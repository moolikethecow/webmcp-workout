/**
 * Templates read layer (lib/gym/templates-read.ts, P2a) — the Train start surface
 * + save-as-template mapping. The marquee test is the PURE `buildTemplateFromWorkout`
 * fn (a completed workout → template_exercises rows): warmups don't seed targets,
 * target_sets = working-set count, target_reps = modal reps, target_weight = top
 * weight, positions re-index densely, superset_group carries. The DB wrappers use a
 * mocked db.execute / db.transaction to assert the read shape + insert wiring.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sqlText } from './sql-text'

const mockExecute = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db/client', () => ({
  db: { execute: mockExecute, transaction: mockTransaction },
}))

const {
  buildTemplateFromWorkout,
  createTemplateFromWorkout,
  listTemplatesForStart,
} = await import('../templates-read')

const set = (o: Partial<import('../templates-read').WorkoutSetForTemplate>) => ({
  exerciseId: 'ex-1',
  position: 0,
  supersetGroup: null,
  exerciseRestSeconds: 120,
  exerciseRestSecondsWarmup: 45,
  section: 'main',
  exerciseNotes: null,
  setNumber: 1,
  setType: 'normal',
  weight: 100,
  weightUnit: 'lb' as const,
  reps: 8,
  distanceM: null,
  durationS: null,
  rpe: null,
  restSeconds: null,
  side: null,
  ...o,
})

beforeEach(() => {
  mockExecute.mockReset()
  mockTransaction.mockReset()
})

// ── PURE mapping ──────────────────────────────────────────────────────────────
describe('buildTemplateFromWorkout (pure)', () => {
  it('maps one exercise: target_sets = working-set count, modal reps, top weight', () => {
    const rows = buildTemplateFromWorkout([
      set({ reps: 8, weight: 100 }),
      set({ reps: 8, weight: 105 }),
      set({ reps: 6, weight: 110 }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      exerciseId: 'ex-1',
      position: 0,
      supersetGroup: null,
      targetSets: 3, // 3 working sets
      targetReps: 8, // modal (8 appears twice, 6 once)
      targetWeight: 110, // top weight
      targetWeightUnit: 'lb',
      targetDurationS: null,
      restSeconds: 120,
      restSecondsWarmup: 45,
      section: 'main',
      notes: null,
      sets: [
        expect.objectContaining({ setNumber: 1, targetWeight: 100, targetReps: 8 }),
        expect.objectContaining({ setNumber: 2, targetWeight: 105, targetReps: 8 }),
        expect.objectContaining({ setNumber: 3, targetWeight: 110, targetReps: 6 }),
      ],
    })
  })

  it('excludes warmups from the target math but keeps the slot', () => {
    const rows = buildTemplateFromWorkout([
      set({ setType: 'warmup', reps: 12, weight: 45 }),
      set({ setType: 'warmup', reps: 10, weight: 65 }),
      set({ setType: 'normal', reps: 5, weight: 135 }),
      set({ setType: 'normal', reps: 5, weight: 135 }),
    ])
    expect(rows[0]).toMatchObject({ targetSets: 2, targetReps: 5, targetWeight: 135 })
  })

  it('an exercise with ONLY warmups becomes a slot with null targets', () => {
    const rows = buildTemplateFromWorkout([
      set({ setType: 'warmup', reps: 12, weight: 45 }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ targetSets: null, targetReps: null, targetWeight: null })
  })

  it('orders by position and RE-INDEXES densely (gaps collapse to 0..n-1)', () => {
    const rows = buildTemplateFromWorkout([
      set({ exerciseId: 'c', position: 5 }),
      set({ exerciseId: 'a', position: 1 }),
      set({ exerciseId: 'b', position: 3 }),
    ])
    expect(rows.map((r) => r.exerciseId)).toEqual(['a', 'b', 'c'])
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2])
  })

  it('carries superset_group through', () => {
    const rows = buildTemplateFromWorkout([
      set({ exerciseId: 'a', position: 0, supersetGroup: 7 }),
      set({ exerciseId: 'b', position: 1, supersetGroup: 7 }),
    ])
    expect(rows.map((r) => r.supersetGroup)).toEqual([7, 7])
  })

  it('groups multiple sets of the SAME exercise into one slot', () => {
    const rows = buildTemplateFromWorkout([
      set({ exerciseId: 'a', position: 0, reps: 10, weight: 50 }),
      set({ exerciseId: 'a', position: 0, reps: 10, weight: 50 }),
      set({ exerciseId: 'a', position: 0, reps: 9, weight: 55 }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ targetSets: 3, targetReps: 10, targetWeight: 55 })
  })

  it('keeps repeated occurrences of the same exercise as separate workout slots', () => {
    const rows = buildTemplateFromWorkout([
      set({ exerciseId: 'a', position: 0, setNumber: 1, reps: 8, weight: 100 }),
      set({ exerciseId: 'a', position: 0, setNumber: 2, reps: 8, weight: 100 }),
      set({ exerciseId: 'a', position: 3, setNumber: 1, reps: 15, weight: 50 }),
      set({ exerciseId: 'a', position: 3, setNumber: 2, reps: 15, weight: 50 }),
    ])
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.position)).toEqual([0, 1])
    expect(rows.map((row) => [row.targetSets, row.targetReps, row.targetWeight])).toEqual([
      [2, 8, 100],
      [2, 15, 50],
    ])
  })

  it('keeps four identical sets as four ordered template prescriptions', () => {
    const rows = buildTemplateFromWorkout(
      Array.from({ length: 4 }, (_, index) =>
        set({ setNumber: index + 1, reps: 10, weight: 45 }),
      ),
    )
    expect(rows[0]!.sets).toHaveLength(4)
    expect(rows[0]!.sets.map((entry) => entry.setNumber)).toEqual([1, 2, 3, 4])
    expect(rows[0]!.sets.every((entry) => entry.targetWeight === 45 && entry.targetReps === 10)).toBe(true)
  })

  it('compares mixed-unit sets canonically and stores the heaviest target in lb', () => {
    const rows = buildTemplateFromWorkout([
      set({ weight: 220, weightUnit: 'lb' }),
      set({ weight: 101, weightUnit: 'kg' }),
    ])
    expect(rows[0]).toMatchObject({ targetWeight: 222.67, targetWeightUnit: 'lb' })
  })

  it('bodyweight-only sets → null weight, reps still map', () => {
    const rows = buildTemplateFromWorkout([
      set({ reps: 15, weight: null }),
      set({ reps: 15, weight: null }),
    ])
    expect(rows[0]).toMatchObject({ targetSets: 2, targetReps: 15, targetWeight: null })
  })

  it('preserves heterogeneous set type, duration, distance, RPE, side, and per-set rest', () => {
    const rows = buildTemplateFromWorkout([
      set({ setNumber: 1, setType: 'warmup', weight: 45, reps: 12, restSeconds: 30 }),
      set({
        setNumber: 2,
        setType: 'normal',
        weight: null,
        reps: null,
        distanceM: 400,
        durationS: 75,
        rpe: 8,
        restSeconds: 90,
        side: 'left',
      }),
    ])
    expect(rows[0]!.sets).toEqual([
      expect.objectContaining({ setNumber: 1, setType: 'warmup', targetWeight: 45, targetReps: 12, restSeconds: 30 }),
      expect.objectContaining({
        setNumber: 2,
        setType: 'normal',
        targetDistanceM: 400,
        targetDurationS: 75,
        targetRpe: 8,
        restSeconds: 90,
        side: 'left',
      }),
    ])
  })

  it('keeps an exercise with no completed sets without inventing a phantom set', () => {
    const rows = buildTemplateFromWorkout([set({ setNumber: null, weight: null, reps: null })])
    expect(rows[0]).toMatchObject({ targetSets: null, sets: [] })
  })

  it('empty input → empty output', () => {
    expect(buildTemplateFromWorkout([])).toEqual([])
  })
})

// ── listTemplatesForStart (mocked db) ────────────────────────────────────────
describe('listTemplatesForStart', () => {
  it('shapes templates + lastWorkout and filters to completed workouts', async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [
          { id: 't1', name: 'Push', folder: 'PPL', exercise_count: 5, last_performed: '2026-07-01T10:00:00Z', is_mobility: false },
          { id: 't2', name: 'Pull', folder: null, exercise_count: 6, last_performed: null, is_mobility: false },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: 'w9', name: 'Push Day', started_at: '2026-07-08T09:00:00Z', duration_seconds: 3600, exercise_count: 5 },
        ],
      })

    const out = await listTemplatesForStart()
    expect(out.templates).toEqual([
      { id: 't1', name: 'Push', folder: 'PPL', exerciseCount: 5, lastPerformed: '2026-07-01T10:00:00Z', isMobility: false },
      { id: 't2', name: 'Pull', folder: null, exerciseCount: 6, lastPerformed: null, isMobility: false },
    ])
    expect(out.lastWorkout).toEqual({
      id: 'w9',
      name: 'Push Day',
      date: '2026-07-08T09:00:00Z',
      exerciseCount: 5,
      durationSeconds: 3600,
    })

    // §3b: both queries must scope to completed workouts.
    const templatesSql = sqlText(mockExecute.mock.calls[0]![0])
    const lastSql = sqlText(mockExecute.mock.calls[1]![0])
    expect(templatesSql).toMatch(/status\s*=\s*'completed'/)
    expect(lastSql).toMatch(/status\s*=\s*'completed'/)
  })

  it('lastWorkout is null when there are no completed workouts', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
    const out = await listTemplatesForStart()
    expect(out.templates).toEqual([])
    expect(out.lastWorkout).toBeNull()
  })
})

// ── createTemplateFromWorkout (mocked db + transaction) ──────────────────────
describe('createTemplateFromWorkout', () => {
  it('returns null when the source workout has no exercises', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] }) // no workout_exercises
    const out = await createTemplateFromWorkout('w-empty', 'Nope')
    expect(out).toBeNull()
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it('inserts the template + mapped exercises in a transaction and returns the summary', async () => {
    // First read: the workout's exercises + sets.
    mockExecute.mockResolvedValueOnce({
      rows: [
        { exercise_id: 'a', position: 0, superset_group: null, set_number: 1, set_type: 'normal', weight: '135', weight_unit: 'lb', reps: 5 },
        { exercise_id: 'a', position: 0, superset_group: null, set_number: 2, set_type: 'normal', weight: '61.24', weight_unit: 'kg', reps: 5 },
        { exercise_id: 'b', position: 1, superset_group: null, set_number: 1, set_type: 'normal', weight: '95', weight_unit: 'lb', reps: 10 },
      ],
    })

    // db.transaction(cb) runs cb with a tx whose execute returns the new id first.
    const txExecute = vi.fn()
    let templateExerciseN = 0
    txExecute.mockImplementation((query: unknown) => {
      const text = sqlText(query)
      if (/INSERT INTO workout_templates/.test(text)) return Promise.resolve({ rows: [{ id: 'new-tpl' }] })
      if (/INSERT INTO template_exercises/.test(text)) {
        templateExerciseN += 1
        return Promise.resolve({ rows: [{ id: `te-${templateExerciseN}` }] })
      }
      return Promise.resolve({ rows: [] })
    })
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) =>
      cb({ execute: txExecute }),
    )

    const out = await createTemplateFromWorkout('w-1', '  Leg Day  ')
    expect(out).toEqual({ id: 'new-tpl', name: 'Leg Day', folder: null, exerciseCount: 2 })

    const sourceSql = sqlText(mockExecute.mock.calls[0]![0])
    expect(sourceSql).not.toMatch(/ws\.completed\s*=\s*true/)
    expect(sourceSql).toMatch(/COALESCE\(ws\.weight, ws\.prescribed_weight\)/)

    // One template + two exercise rows + all three exact set rows.
    expect(txExecute).toHaveBeenCalledTimes(6)
    const insertTplSql = sqlText(txExecute.mock.calls[0]![0])
    expect(insertTplSql).toMatch(/INSERT INTO workout_templates/)
    const insertExSql = sqlText(txExecute.mock.calls[1]![0])
    expect(insertExSql).toMatch(/INSERT INTO template_exercises/)
    expect(insertExSql).toContain('target_weight_unit')
    expect(txExecute.mock.calls.map(([q]) => sqlText(q)).filter((q) => /INSERT INTO template_sets/.test(q))).toHaveLength(3)
  })

  it('carries the source template’s progression policies onto the new template', async () => {
    // (1) workout exercises + sets, then (2) the source template's policies.
    mockExecute
      .mockResolvedValueOnce({
        rows: [
          { exercise_id: 'a', position: 0, superset_group: null, set_number: 1, set_type: 'normal', weight: '135', weight_unit: 'lb', reps: 5 },
          { exercise_id: 'b', position: 1, superset_group: null, set_number: 1, set_type: 'normal', weight: '95', weight_unit: 'lb', reps: 10 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { exercise_id: 'a', progression: { type: 'linear', increment: 5 } },
          // Unreadable → dropped rather than propagated as a fake policy.
          { exercise_id: 'b', progression: { type: 'nonsense' } },
        ],
      })

    const txExecute = vi.fn()
    let n = 0
    txExecute.mockImplementation((query: unknown) => {
      const text = sqlText(query)
      if (/INSERT INTO workout_templates/.test(text)) return Promise.resolve({ rows: [{ id: 'tpl' }] })
      if (/INSERT INTO template_exercises/.test(text)) {
        n += 1
        return Promise.resolve({ rows: [{ id: `te-${n}` }] })
      }
      return Promise.resolve({ rows: [] })
    })
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) =>
      cb({ execute: txExecute }),
    )

    await createTemplateFromWorkout('w-1', 'Leg Day B', { carryProgression: true })

    const exerciseInserts = txExecute.mock.calls
      .map(([q]) => sqlText(q))
      .filter((q) => /INSERT INTO template_exercises/.test(q))
    expect(exerciseInserts).toHaveLength(2)
    expect(exerciseInserts[0]).toContain('progression')
    expect(exerciseInserts[0]).toContain('{"type":"linear","increment":5}')
    expect(exerciseInserts[1]).not.toContain('increment')
  })

  it('does not read the source policies when the carry option is off', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ exercise_id: 'a', position: 0, superset_group: null, set_type: 'normal', weight: '100', weight_unit: 'lb', reps: 8 }],
    })
    const txExecute = vi.fn()
    txExecute.mockImplementation((query: unknown) => {
      const text = sqlText(query)
      if (/INSERT INTO workout_templates/.test(text)) return Promise.resolve({ rows: [{ id: 'tpl' }] })
      if (/INSERT INTO template_exercises/.test(text)) return Promise.resolve({ rows: [{ id: 'te-a' }] })
      return Promise.resolve({ rows: [] })
    })
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) =>
      cb({ execute: txExecute }),
    )

    await createTemplateFromWorkout('w-1', 'Solo')

    expect(mockExecute).toHaveBeenCalledTimes(1) // only the workout read
  })

  it('falls back to a default name when the name is blank', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ exercise_id: 'a', position: 0, superset_group: null, set_type: 'normal', weight: '100', weight_unit: 'lb', reps: 8 }],
    })
    const txExecute = vi.fn()
    txExecute.mockImplementation((query: unknown) => {
      const text = sqlText(query)
      if (/INSERT INTO workout_templates/.test(text)) return Promise.resolve({ rows: [{ id: 'tpl' }] })
      if (/INSERT INTO template_exercises/.test(text)) return Promise.resolve({ rows: [{ id: 'te-a' }] })
      return Promise.resolve({ rows: [] })
    })
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) =>
      cb({ execute: txExecute }),
    )

    const out = await createTemplateFromWorkout('w-1', '   ')
    expect(out?.name).toBe('New Template')
  })
})
