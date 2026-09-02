/**
 * Template diff (GYM_PLAN §4) — PURE classification of a workout vs its template
 * and the replace-all update payload. Covers the three verdicts, the not-from-a-
 * template short-circuit, and that progression policies survive a values update.
 */
import { describe, expect, it } from 'vitest'

import {
  buildTemplateUpdate,
  diffWorkoutVsTemplate,
  sameExactSetPrescription,
  type ExactTemplateExerciseShape,
  type TemplateExerciseShape,
  type WorkoutExerciseShape,
} from '../template-diff'

const tEx = (
  exerciseId: string,
  position: number,
  opts: Partial<TemplateExerciseShape> = {},
): TemplateExerciseShape => ({
  exerciseId,
  position,
  supersetGroup: null,
  targetSets: 3,
  targetReps: 8,
  targetWeight: 100,
  targetWeightUnit: 'lb',
  ...opts,
})

const wEx = (
  exerciseId: string,
  position: number,
  sets: Array<{ reps: number; weight: number; weightUnit?: 'lb' | 'kg' }>,
  supersetGroup: number | null = null,
): WorkoutExerciseShape => ({
  exerciseId,
  position,
  supersetGroup,
  workingSets: sets.map((set) => ({ ...set, weightUnit: set.weightUnit ?? 'lb' })),
})

const threeSets = (reps: number, weight: number) => [
  { reps, weight },
  { reps, weight },
  { reps, weight },
]

describe('diffWorkoutVsTemplate', () => {
  it('not from a template → unchanged + canUpdate:false', () => {
    const d = diffWorkoutVsTemplate([tEx('a', 0)], [wEx('a', 0, threeSets(8, 100))], false)
    expect(d).toEqual({ verdict: 'unchanged', canUpdate: false })
  })

  it('identical structure + values → unchanged', () => {
    const d = diffWorkoutVsTemplate([tEx('a', 0)], [wEx('a', 0, threeSets(8, 100))], true)
    expect(d.verdict).toBe('unchanged')
    expect(d.canUpdate).toBe(true)
  })

  it('a different exercise → structure_changed', () => {
    const d = diffWorkoutVsTemplate([tEx('a', 0)], [wEx('b', 0, threeSets(8, 100))], true)
    expect(d.verdict).toBe('structure_changed')
  })

  it('an added exercise → structure_changed', () => {
    const d = diffWorkoutVsTemplate(
      [tEx('a', 0)],
      [wEx('a', 0, threeSets(8, 100)), wEx('b', 1, threeSets(10, 50))],
      true,
    )
    expect(d.verdict).toBe('structure_changed')
  })

  it('a superset regrouping → structure_changed', () => {
    const d = diffWorkoutVsTemplate(
      [tEx('a', 0, { supersetGroup: null })],
      [wEx('a', 0, threeSets(8, 100), 1)],
      true,
    )
    expect(d.verdict).toBe('structure_changed')
  })

  it('same structure, more sets → values_changed', () => {
    const d = diffWorkoutVsTemplate(
      [tEx('a', 0, { targetSets: 3 })],
      [wEx('a', 0, [...threeSets(8, 100), { reps: 8, weight: 100 }])],
      true,
    )
    expect(d.verdict).toBe('values_changed')
  })

  it('same structure, heavier top set → values_changed', () => {
    const d = diffWorkoutVsTemplate(
      [tEx('a', 0, { targetWeight: 100 })],
      [wEx('a', 0, threeSets(8, 110))],
      true,
    )
    expect(d.verdict).toBe('values_changed')
  })

  it('normalizes stored and logged units before comparing target weight', () => {
    const d = diffWorkoutVsTemplate(
      [tEx('a', 0, { targetWeight: 100, targetWeightUnit: 'kg' })],
      [wEx('a', 0, threeSets(8, 220.46))],
      true,
    )
    expect(d.verdict).toBe('unchanged')
  })

  it('same structure, different modal reps → values_changed', () => {
    const d = diffWorkoutVsTemplate(
      [tEx('a', 0, { targetReps: 8 })],
      [wEx('a', 0, threeSets(12, 100))],
      true,
    )
    expect(d.verdict).toBe('values_changed')
  })
})

describe('buildTemplateUpdate', () => {
  it('values mode: keeps structure + progression, refreshes targets from logs', () => {
    const template = [tEx('a', 0, { targetReps: 8, targetWeight: 100, progression: { type: 'linear', increment: 5 } })]
    const workout = [wEx('a', 0, threeSets(10, 110))]
    const rows = buildTemplateUpdate(template, workout, 'values')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      exerciseId: 'a',
      position: 0,
      targetSets: 3,
      targetReps: 10,
      targetWeight: 110,
      targetWeightUnit: 'lb',
      progression: { type: 'linear', increment: 5 }, // preserved
    })
  })

  it('structure mode: adopts the workout skeleton; new exercise gets null policy', () => {
    const template = [tEx('a', 0, { progression: { type: 'rep_only', addRepWhen: { repsAtLeast: 12 } } })]
    const workout = [wEx('a', 0, threeSets(8, 100)), wEx('c', 1, threeSets(12, 40))]
    const rows = buildTemplateUpdate(template, workout, 'structure')
    expect(rows.map((r) => r.exerciseId)).toEqual(['a', 'c'])
    // surviving 'a' keeps its policy; new 'c' has null
    expect(rows.find((r) => r.exerciseId === 'a')!.progression).toMatchObject({ type: 'rep_only' })
    expect(rows.find((r) => r.exerciseId === 'c')!.progression).toBeNull()
    // structure mode keeps the OLD targets for survivors (values not taken).
    expect(rows.find((r) => r.exerciseId === 'a')!.targetReps).toBe(8)
    // A newly-added slot has no old values, so its logged prescription seeds it.
    expect(rows.find((r) => r.exerciseId === 'c')).toMatchObject({
      targetSets: 3,
      targetReps: 12,
      targetWeight: 40,
    })
  })

  it('both mode: adopts structure AND logged values', () => {
    const template = [tEx('a', 0, { targetReps: 8, targetWeight: 100 })]
    const workout = [wEx('a', 0, threeSets(12, 120))]
    const rows = buildTemplateUpdate(template, workout, 'both')
    expect(rows[0]).toMatchObject({ targetReps: 12, targetWeight: 120, targetSets: 3 })
  })

  it('writes mixed-unit logged targets canonically in pounds', () => {
    const template = [tEx('a', 0)]
    const workout = [wEx('a', 0, [{ reps: 8, weight: 100, weightUnit: 'kg' }])]
    const rows = buildTemplateUpdate(template, workout, 'values')
    expect(rows[0]).toMatchObject({ targetWeight: 220.46, targetWeightUnit: 'lb' })
  })

  it('updates repeated occurrences independently instead of collapsing by exercise id', () => {
    const template = [
      tEx('a', 0, { progression: { type: 'linear', increment: 5 } }),
      tEx('a', 1, { progression: { type: 'rep_only', addRepWhen: { repsAtLeast: 15 } } }),
    ]
    const workout = [
      wEx('a', 0, threeSets(8, 110)),
      wEx('a', 1, threeSets(15, 50)),
    ]
    const rows = buildTemplateUpdate(template, workout, 'values')
    expect(rows.map((row) => [row.targetReps, row.targetWeight])).toEqual([
      [8, 110],
      [15, 50],
    ])
    expect(rows.map((row) => (row.progression as { type: string }).type)).toEqual([
      'linear',
      'rep_only',
    ])
  })

  it('follows a reordered exercise to preserve its progression policy', () => {
    const template = [
      tEx('a', 0, { progression: { type: 'linear', increment: 5 } }),
      tEx('b', 1, { progression: { type: 'rpe_target', rpe: 8 } }),
    ]
    const workout = [wEx('b', 0, threeSets(8, 80)), wEx('a', 1, threeSets(8, 100))]
    const rows = buildTemplateUpdate(template, workout, 'structure')
    expect(rows.map((row) => [row.exerciseId, (row.progression as { type: string }).type])).toEqual([
      ['b', 'rpe_target'],
      ['a', 'linear'],
    ])
  })

  it('keeps duplicate occurrence identity when another exercise moves across both copies', () => {
    const template = [
      tEx('a', 0, { progression: { type: 'linear', increment: 5 }, targetWeight: 100 }),
      tEx('a', 1, {
        progression: { type: 'rep_only', addRepWhen: { repsAtLeast: 15 } },
        targetWeight: 50,
      }),
      tEx('b', 2, { progression: { type: 'rpe_target', rpe: 8 }, targetWeight: 80 }),
    ]
    const workout = [
      wEx('b', 0, threeSets(8, 80)),
      wEx('a', 1, threeSets(8, 100)),
      wEx('a', 2, threeSets(15, 50)),
    ]
    const rows = buildTemplateUpdate(template, workout, 'structure')
    expect(rows.map((row) => [
      row.exerciseId,
      row.targetWeight,
      (row.progression as { type: string }).type,
    ])).toEqual([
      ['b', 80, 'rpe_target'],
      ['a', 100, 'linear'],
      ['a', 50, 'rep_only'],
    ])
  })
})

describe('sameExactSetPrescription', () => {
  const exact = (
    overrides: Partial<ExactTemplateExerciseShape['sets'][number]> = {},
  ): ExactTemplateExerciseShape[] => [{
    exerciseId: 'a',
    position: 0,
    sets: [
      {
        setNumber: 1,
        setType: 'normal',
        targetWeight: 100,
        targetWeightUnit: 'lb',
        targetReps: 8,
        targetDistanceM: null,
        targetDurationS: null,
        targetRpe: 8,
        restSeconds: 90,
        side: null,
        ...overrides,
      },
      {
        setNumber: 2,
        setType: 'normal',
        targetWeight: 100,
        targetWeightUnit: 'lb',
        targetReps: 8,
        targetDistanceM: null,
        targetDurationS: null,
        targetRpe: 8,
        restSeconds: 120,
        side: null,
      },
    ],
  }]

  it('accepts equivalent weights expressed in different units', () => {
    expect(sameExactSetPrescription(exact(), exact({ targetWeight: 45.3592, targetWeightUnit: 'kg' }))).toBe(true)
  })

  it.each([
    ['set type', { setType: 'drop' as const }],
    ['heterogeneous reps', { targetReps: 9 }],
    ['duration', { targetDurationS: 45 }],
    ['distance', { targetDistanceM: 400 }],
    ['RPE', { targetRpe: 9 }],
    ['per-set rest', { restSeconds: 75 }],
    ['side', { side: 'left' as const }],
  ])('detects an exact-only %s change', (_label, change) => {
    expect(sameExactSetPrescription(exact(), exact(change))).toBe(false)
  })

  it('detects set order/count changes even when scalar targets could match', () => {
    const reordered = exact()
    const [first, second] = reordered[0]!.sets
    reordered[0]!.sets = [
      { ...second!, setNumber: 1 },
      { ...first!, setNumber: 2 },
    ]
    expect(sameExactSetPrescription(exact(), reordered)).toBe(false)
    expect(sameExactSetPrescription(exact(), [{ ...exact()[0]!, sets: exact()[0]!.sets.slice(0, 1) }])).toBe(false)
  })
})
