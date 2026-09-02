import { describe, expect, it, vi } from 'vitest'

const testMocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  materializeSetPrescriptions: vi.fn(),
  readProgrammingHistory: vi.fn(),
}))

vi.mock('@/lib/db/client', () => ({ db: { execute: testMocks.dbExecute, transaction: vi.fn() } }))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: vi.fn() }))
vi.mock('../active-workout', () => ({
  startWorkout: vi.fn(),
  getActiveWorkoutById: vi.fn(),
  materializeSetPrescriptions: testMocks.materializeSetPrescriptions,
}))
vi.mock('../templates-read', () => ({ getTemplateForEditor: vi.fn() }))
vi.mock('../programming-history', async () => {
  const actual = await vi.importActual<typeof import('../programming-history')>('../programming-history')
  return { ...actual, readProgrammingHistory: testMocks.readProgrammingHistory }
})

const {
  applyBlockOverlay,
  applyPlanProgrammingToWorkout,
  explainPlanDecision,
  explainTargetChange,
  mergePlanPrescription,
  normalizeTrainingPlanInput,
  normalizeTrainingPlanPolicy,
  resolveCurrentBlock,
  resolveBlockOccurrence,
  resolveFixedNextDay,
  resolveFlexibleNextDay,
  resolvePlanDayIdentities,
  seedManagedTargets,
} = await import('../training-plans')

describe('training plan policy validation', () => {
  it('defaults to a 3×8–10 style 3×8–10 double progression with a real deload rule', () => {
    const policy = normalizeTrainingPlanPolicy(null)
    expect(policy.progression).toEqual({
      type: 'double_progression',
      repRange: [8, 10],
      increment: 5,
      requiredSets: 3,
      deloadAfterMisses: 2,
      deloadPct: 10,
    })
    expect(policy.autoAdjustTargets).toBe(true)
    expect(policy.programming).toEqual({
      goal: 'balanced',
      order: 'fatigue_aware',
      supersets: 'history',
      warmups: 'ramp',
      history: 'bounded',
    })
  })

  it('infers the programming goal but respects an explicit plan override', () => {
    const inferred = normalizeTrainingPlanInput({
      name: 'Bench strength',
      goal: 'Build max bench strength',
      days: [{ name: 'Push', templateId: 'template-a' }],
    })
    expect(inferred.policy.programming.goal).toBe('strength')

    const overridden = normalizeTrainingPlanInput({
      name: 'Power block',
      goal: 'Build strength',
      policy: { programming: { goal: 'power', order: 'preserve' } },
      days: [{ name: 'Power', templateId: 'template-a' }],
    })
    expect(overridden.policy.programming).toMatchObject({ goal: 'power', order: 'preserve' })
  })

  it('accepts explicit periodization blocks and bounds multipliers', () => {
    const policy = normalizeTrainingPlanPolicy({
      blocks: [
        { name: 'Accumulation', weeks: 4, repRange: [8, 12], volumeMultiplier: 1.2 },
        { name: 'Deload', weeks: 1, loadMultiplier: 0.75, volumeMultiplier: 0.5, deload: true },
      ],
    })
    expect(policy.blocks).toHaveLength(2)
    expect(policy.blocks[1]).toMatchObject({ name: 'Deload', weeks: 1, deload: true })
  })

  it('requires complete template-backed days and fixed-plan weekdays', () => {
    expect(() => normalizeTrainingPlanInput({ name: 'Upper/lower', days: [] })).toThrow(/1–7/)
    expect(() => normalizeTrainingPlanInput({
      name: 'Upper/lower',
      scheduleMode: 'fixed',
      days: [{ name: 'Upper A', templateId: 'template-a' }],
    })).toThrow(/weekday/i)
  })
})

describe('periodization resolution and overlays', () => {
  const blocks = [
    { name: 'Base', weeks: 3 },
    { name: 'Intensify', weeks: 2 },
    { name: 'Deload', weeks: 1 },
  ]

  it('advances by completed plan cycles, not calendar guesses', () => {
    expect(resolveCurrentBlock(blocks, 0, 4, false)?.name).toBe('Base')
    expect(resolveCurrentBlock(blocks, 12, 4, false)?.name).toBe('Intensify')
    expect(resolveCurrentBlock(blocks, 20, 4, false)?.name).toBe('Deload')
  })

  it('can repeat a finished block sequence', () => {
    expect(resolveCurrentBlock(blocks, 24, 4, true)?.name).toBe('Base')
  })

  it('gives repeated block sequences distinct history occurrences', () => {
    const first = resolveCurrentBlock(blocks, 0, 4, true)
    const repeated = resolveCurrentBlock(blocks, 24, 4, true)
    expect(resolveBlockOccurrence(blocks, first, true)).toBe(0)
    expect(resolveBlockOccurrence(blocks, repeated, true)).toBe(6)
  })

  it('applies volume, load, rep, and RPE changes deterministically', () => {
    const targets = applyBlockOverlay(
      [
        { weight: 100, reps: 10 },
        { weight: 100, reps: 10 },
        { weight: 100, reps: 10 },
      ],
      { name: 'Deload', weeks: 1, volumeMultiplier: 2 / 3, loadMultiplier: 0.8, repRange: [6, 8], targetRpe: 6 },
    ) as Array<{ weight?: number; reps?: number; rpe?: number }>
    expect(targets).toHaveLength(2)
    expect(targets[0]).toEqual({ weight: 80, reps: 6, rpe: 6 })
  })

  it('keeps unilateral periodization in complete left/right pairs', () => {
    const targets = applyBlockOverlay(
      [
        { weight: 20, reps: 8, side: 'left' },
        { weight: 20, reps: 8, side: 'right' },
        { weight: 20, reps: 8, side: 'left' },
        { weight: 20, reps: 8, side: 'right' },
      ],
      { name: 'Deload', weeks: 1, volumeMultiplier: 0.6 },
    )
    expect(targets).toHaveLength(2)
    expect(targets.map((target) => target.side)).toEqual(['left', 'right'])
  })

  it('does not force template volume when the block has no volume overlay', () => {
    const targets = applyBlockOverlay(
      [{ weight: 100, reps: 8 }, { weight: 100, reps: 8 }],
      { name: 'Technique', weeks: 1, targetRpe: 7 },
      4,
    )
    expect(targets).toHaveLength(2)
  })
})

describe('fixed schedule resolution', () => {
  const days = [
    { id: 'mon', position: 0, name: 'Upper A', templateId: 't1', templateName: 'Upper A', exerciseCount: 5, weekday: 1, notes: null, available: true },
    { id: 'wed', position: 1, name: 'Lower A', templateId: 't2', templateName: 'Lower A', exerciseCount: 5, weekday: 3, notes: null, available: true },
  ]

  it('uses today when due, then advances after that day is completed', () => {
    expect(resolveFixedNextDay(days, 1, new Set())?.id).toBe('mon')
    expect(resolveFixedNextDay(days, 1, new Set(['mon']))?.id).toBe('wed')
  })
})

describe('flexible schedule resolution', () => {
  const days = [
    { id: 'upper', position: 0, name: 'Upper', templateId: 't1', templateName: 'Upper', exerciseCount: 5, weekday: null, notes: null, available: true },
    { id: 'lower', position: 1, name: 'Lower', templateId: 't2', templateName: 'Lower', exerciseCount: 5, weekday: null, notes: null, available: true },
  ]

  it('advances from the day actually completed out of order', () => {
    expect(resolveFlexibleNextDay(days, [{
      workoutId: 'w1', workoutName: 'Lower', dayId: 'lower', dayName: 'Lower',
      status: 'completed', startedAt: '2026-07-15', endedAt: '2026-07-15', blockIndex: null,
    }], 1)?.id).toBe('upper')
  })

  it('preserves semantic IDs through a reorder so completed Upper advances to Lower', () => {
    const resolved = resolvePlanDayIdentities(days, [
      { dayId: 'lower', name: 'Lower', templateId: 't2' },
      { dayId: 'upper', name: 'Upper', templateId: 't1' },
    ])
    expect(resolved.map((row) => row.existingId)).toEqual(['lower', 'upper'])
    const reordered = resolved.map((row, position) => ({
      ...days.find((day) => day.id === row.existingId)!,
      position,
    }))
    expect(resolveFlexibleNextDay(reordered, [{
      workoutId: 'w1', workoutName: 'Upper', dayId: 'upper', dayName: 'Upper',
      status: 'completed', startedAt: '2026-07-15', endedAt: '2026-07-15', blockIndex: null,
    }], 1)?.id).toBe('lower')
  })

  it('matches unchanged template days for legacy update clients that omit IDs', () => {
    const resolved = resolvePlanDayIdentities(days, [
      { name: 'Lower', templateId: 't2' },
      { name: 'Upper', templateId: 't1' },
    ])
    expect(resolved.map((row) => row.existingId)).toEqual(['lower', 'upper'])
  })
})

describe('first managed session targets', () => {
  const policy = {
    type: 'double_progression' as const,
    repRange: [8, 10] as [number, number],
    increment: 5,
    requiredSets: 3,
  }

  it('starts the plan rule at 3×8 instead of echoing a 4×12 template', () => {
    expect(seedManagedTargets(
      Array.from({ length: 4 }, () => ({ weight: 100, reps: 12 })),
      policy,
    )).toEqual(Array.from({ length: 3 }, () => ({ weight: 100, reps: 8, side: null })))
  })

  it('seeds complete balanced rounds for unilateral work', () => {
    const targets = seedManagedTargets([
      { weight: 20, reps: 12, side: 'left' },
      { weight: 20, reps: 12, side: 'right' },
    ], policy)
    expect(targets).toHaveLength(6)
    expect(targets.map((target) => target.side)).toEqual([
      'left', 'right', 'left', 'right', 'left', 'right',
    ])
    expect(targets.every((target) => target.reps === 8 && target.weight === 20)).toBe(true)
  })
})

describe('live plan materialization', () => {
  it('materializes one ramp per loaded movement family and preserves exact working rest', async () => {
    const row = (
      workoutExerciseId: string,
      exerciseId: string,
      position: number,
      exerciseName: string,
      setNumber: number,
    ) => ({
      workout_exercise_id: workoutExerciseId,
      exercise_id: exerciseId,
      position,
      exercise_name: exerciseName,
      primary_muscle: 'chest',
      secondary_muscles: ['triceps'],
      force: 'push',
      mechanic: 'compound',
      superset_group: null,
      exercise_rest_seconds: 150,
      section: 'main',
      set_number: setNumber,
      set_type: 'normal',
      prescribed_weight: position === 0 ? '200' : '150',
      prescribed_weight_unit: 'lb',
      prescribed_reps: 5,
      prescribed_distance_m: null,
      prescribed_duration_s: null,
      prescribed_rpe: null,
      rest_seconds: 111,
      prescription_source: 'progression',
      side: null,
    })
    testMocks.dbExecute.mockReset()
    testMocks.materializeSetPrescriptions.mockReset()
    testMocks.readProgrammingHistory.mockReset()
    testMocks.dbExecute.mockResolvedValueOnce({
      rows: [
        row('we-bench', 'bench', 0, 'Bench Press', 1),
        row('we-bench', 'bench', 0, 'Bench Press', 2),
        row('we-bench', 'bench', 0, 'Bench Press', 3),
        row('we-incline', 'incline', 1, 'Incline Bench Press', 1),
        row('we-incline', 'incline', 1, 'Incline Bench Press', 2),
        row('we-incline', 'incline', 1, 'Incline Bench Press', 3),
      ],
    })
    testMocks.dbExecute.mockResolvedValue({ rows: [] })
    testMocks.readProgrammingHistory.mockResolvedValue({
      positionByExercise: new Map(),
      supersetSessionRate: 0,
      medianRestSeconds: null,
    })

    await applyPlanProgrammingToWorkout('workout-1', {
      goal: 'strength',
      order: 'preserve',
      supersets: 'off',
      warmups: 'ramp',
      history: 'off',
    })

    expect(testMocks.materializeSetPrescriptions).toHaveBeenCalledTimes(2)
    const benchSets = testMocks.materializeSetPrescriptions.mock.calls[0]![2] as Array<{
      setType: string
      weight: number | null
      restSeconds: number | null
    }>
    const inclineSets = testMocks.materializeSetPrescriptions.mock.calls[1]![2] as Array<{
      setType: string
      restSeconds: number | null
    }>
    expect(benchSets.filter((set) => set.setType === 'warmup')).toMatchObject([
      { weight: 80, restSeconds: 45 },
      { weight: 120, restSeconds: 60 },
      { weight: 150, restSeconds: 90 },
    ])
    expect(benchSets.filter((set) => set.setType !== 'warmup').every((set) => set.restSeconds === 111)).toBe(true)
    expect(inclineSets.filter((set) => set.setType === 'warmup')).toHaveLength(0)
    expect(inclineSets.every((set) => set.restSeconds === 111)).toBe(true)
  })

  it('changes real working prescriptions while preserving warmups and set-level rest', () => {
    const base = [
      { setNumber: 1, setType: 'warmup' as const, weight: 45, weightUnit: 'lb' as const, reps: 10, restSeconds: 30, source: 'template' as const },
      { setNumber: 2, setType: 'normal' as const, weight: 100, weightUnit: 'lb' as const, reps: 10, restSeconds: 90, source: 'template' as const },
      { setNumber: 3, setType: 'normal' as const, weight: 100, weightUnit: 'lb' as const, reps: 10, restSeconds: 120, source: 'template' as const },
      { setNumber: 4, setType: 'normal' as const, weight: 100, weightUnit: 'lb' as const, reps: 10, restSeconds: 150, source: 'template' as const },
    ]
    const merged = mergePlanPrescription(
      base,
      [{ weight: 80, reps: 6, rpe: 6 }, { weight: 80, reps: 6, rpe: 6 }],
      'lb',
    )
    expect(merged).toHaveLength(3)
    expect(merged[0]).toMatchObject({ setType: 'warmup', weight: 45, restSeconds: 30, source: 'template' })
    expect(merged.slice(1)).toMatchObject([
      { setNumber: 2, weight: 80, reps: 6, rpe: 6, restSeconds: 90, source: 'progression' },
      { setNumber: 3, weight: 80, reps: 6, rpe: 6, restSeconds: 120, source: 'progression' },
    ])
  })
})

describe('auditable adaptation copy', () => {
  it('explains increases, deloads, rep changes, and holds from actual targets', () => {
    expect(explainTargetChange(
      Array.from({ length: 3 }, () => ({ weight: 100, reps: 10 })),
      Array.from({ length: 3 }, () => ({ weight: 105, reps: 8 })),
      'lb',
    )).toMatch(/Bump \+5 lb/)
    expect(explainTargetChange(
      Array.from({ length: 3 }, () => ({ weight: 100, reps: 6 })),
      Array.from({ length: 3 }, () => ({ weight: 90, reps: 8 })),
      'lb',
    )).toMatch(/Deload 10 lb/)
    expect(explainTargetChange(
      Array.from({ length: 3 }, () => ({ weight: 100, reps: 8 })),
      Array.from({ length: 3 }, () => ({ weight: 100, reps: 9 })),
      'lb',
    )).toMatch(/Add 1 rep/)
    expect(explainTargetChange(
      Array.from({ length: 3 }, () => ({ weight: 100, reps: 8 })),
      [{ weight: 100, reps: 9 }, { weight: 100, reps: 8 }, { weight: 100, reps: 8 }],
      'lb',
    )).toMatch(/set 1/)
    expect(explainTargetChange(
      Array.from({ length: 3 }, () => ({ weight: 100, reps: 8 })),
      Array.from({ length: 3 }, () => ({ weight: 100, reps: 8 })),
      'lb',
    )).toMatch(/Repeat the target/)
  })

  it('credits an explicit block overlay instead of inventing a miss-triggered deload', () => {
    expect(explainPlanDecision(
      Array.from({ length: 3 }, () => ({ weight: 100, reps: 10 })),
      Array.from({ length: 2 }, () => ({ weight: 80, reps: 6, rpe: 6 })),
      'lb',
      { name: 'Deload', weeks: 1, volumeMultiplier: 2 / 3, loadMultiplier: 0.8, repRange: [6, 8], targetRpe: 6, deload: true },
    )).toBe('Deload block — 2 work sets, 80% baseline load, 6–8 reps, target RPE 6.')
  })
})
