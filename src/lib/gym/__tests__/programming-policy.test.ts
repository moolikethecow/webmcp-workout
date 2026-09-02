import { describe, expect, it } from 'vitest'

import type { MuscleRegion } from '@/lib/fitness/muscles'
import {
  EMPTY_PROGRAMMING_HISTORY,
  inferProgrammingGoal,
  resolveProgrammingGoal,
  normalizeWorkoutProgrammingPolicy,
  programWorkout,
  supersetCompatibility,
  type ProgrammableExercise,
  type ProgrammingMetadata,
} from '@/lib/gym/programming-policy'
import type { ProposalSetPrescription } from '@/lib/gym/proposal-payload'

function exercise(
  exerciseId: string,
  region: MuscleRegion,
  overrides: Partial<ProgrammableExercise> = {},
): ProgrammableExercise {
  return {
    exerciseId,
    name: exerciseId,
    sets: 3,
    reps: 8,
    targetWeight: 100,
    supersetGroup: null,
    restSeconds: null,
    region,
    ...overrides,
  }
}

function metadata(rows: Array<[string, MuscleRegion, string]>): Map<string, ProgrammingMetadata> {
  return new Map(rows.map(([id, region, pattern]) => [id, { region, pattern }]))
}

/** A set prescribed in seconds: a hold has a duration and no rep count. */
function timedSet(targetDurationS: number): ProposalSetPrescription {
  return {
    setType: 'normal',
    targetWeight: null,
    reps: null,
    targetDurationS,
    targetRpe: null,
    restSeconds: null,
    side: null,
  }
}

describe('workout programming policy', () => {
  it('normalizes a partial policy and infers explicit goal language', () => {
    expect(normalizeWorkoutProgrammingPolicy({ supersets: 'off' })).toMatchObject({
      goal: 'balanced',
      order: 'fatigue_aware',
      supersets: 'off',
      warmups: 'ramp',
    })
    expect(inferProgrammingGoal(['build my bench strength'])).toBe('strength')
    expect(inferProgrammingGoal(['calf growth and size'])).toBe('hypertrophy')
    expect(inferProgrammingGoal(['explosive power'])).toBe('power')
    expect(inferProgrammingGoal(['Squat 400 lbs'])).toBe('strength')
    expect(inferProgrammingGoal(['Build 15 lbs of muscle'])).toBe('hypertrophy')
  })

  it('uses structured fitness goals without leaking unrelated app goals', () => {
    expect(resolveProgrammingGoal(null, [
      { title: 'Max out my 401k', area: 'wealth' },
      { title: 'Squat 400 lbs', area: 'health', fitnessIntent: 'strength' },
    ])).toBe('strength')

    expect(resolveProgrammingGoal(null, [
      { title: 'Max out my 401k', area: 'wealth' },
    ])).toBe('balanced')
  })

  it('lets an explicit workout focus override the stored goal', () => {
    expect(resolveProgrammingGoal('conditioning today', [
      { title: 'Build muscle', area: 'health', fitnessIntent: 'hypertrophy' },
    ])).toBe('endurance')
  })

  it('keeps technical work first, compounds ahead of isolation, and separates same-region compounds when possible', () => {
    const rows = [
      exercise('bench', 'chest'),
      exercise('incline', 'chest'),
      exercise('fly', 'chest'),
      exercise('row', 'mid_back'),
      exercise('jump', 'quads'),
    ]
    const meta = metadata([
      ['bench', 'chest', 'horizontal-push'],
      ['incline', 'chest', 'horizontal-push'],
      ['fly', 'chest', 'isolation-chest'],
      ['row', 'mid_back', 'horizontal-pull'],
      ['jump', 'quads', 'jump'],
    ])
    const result = programWorkout(rows, {
      metadata: meta,
      policy: { warmups: 'off', supersets: 'off' },
      redistributeWorkingSets: false,
    })
    expect(result.map((row) => row.exerciseId)).toEqual(['jump', 'bench', 'row', 'incline', 'fly'])
  })

  it('removes accidental same-muscle supersets but preserves compatible antagonist pairs', () => {
    const meta = metadata([
      ['bench', 'chest', 'horizontal-push'],
      ['fly', 'chest', 'isolation-chest'],
      ['row', 'mid_back', 'horizontal-pull'],
    ])
    const result = programWorkout([
      exercise('bench', 'chest', { supersetGroup: 1 }),
      exercise('fly', 'chest', { supersetGroup: 1 }),
      exercise('row', 'mid_back', { supersetGroup: 2 }),
      exercise('bench-2', 'chest', { supersetGroup: 2 }),
    ], {
      metadata: new Map([...meta, ['bench-2', { region: 'chest', pattern: 'horizontal-push' }]]),
      policy: { order: 'preserve', warmups: 'off', supersets: 'history' },
    })
    expect(result.slice(0, 2).every((row) => row.supersetGroup == null)).toBe(true)
    expect(result.slice(2).map((row) => row.supersetGroup)).toEqual([2, 2])
    expect(supersetCompatibility(result[2]!, result[3]!, new Map([...meta, ['bench-2', { region: 'chest', pattern: 'horizontal-push' }]]))).toBe('antagonist')
  })

  it('keeps a deliberately-authored same-muscle intensity pair in explicit mode', () => {
    const meta = metadata([
      ['bench', 'chest', 'horizontal-push'],
      ['fly', 'chest', 'isolation-chest'],
    ])
    const result = programWorkout([
      exercise('bench', 'chest', { supersetGroup: 7 }),
      exercise('fly', 'chest', { supersetGroup: 7 }),
    ], {
      metadata: meta,
      policy: { order: 'preserve', warmups: 'off', supersets: 'explicit' },
    })
    expect(result.map((row) => row.supersetGroup)).toEqual([7, 7])
  })

  it('keeps a 3+ member explicit circuit (#1838: was silently dropped to null past a pair)', () => {
    const meta = metadata([
      ['leg-raise', 'abs', 'isolation-abs'],
      ['side-plank', 'abs', 'isolation-abs'],
      ['kegels', 'abs', 'isolation-abs'],
    ])
    const result = programWorkout([
      exercise('leg-raise', 'abs', { supersetGroup: 1 }),
      exercise('side-plank', 'abs', { supersetGroup: 1 }),
      exercise('kegels', 'abs', { supersetGroup: 1 }),
    ], {
      metadata: meta,
      policy: { order: 'preserve', warmups: 'off', supersets: 'explicit' },
    })
    expect(result.map((row) => row.supersetGroup)).toEqual([1, 1, 1])
  })

  it('uses history to enable compatible automatic pairs but never invents a heavy-compound pair', () => {
    const meta = metadata([
      ['bench', 'chest', 'horizontal-push'],
      ['row', 'mid_back', 'horizontal-pull'],
      ['curl', 'biceps', 'isolation-biceps'],
      ['pressdown', 'triceps', 'isolation-triceps'],
    ])
    const result = programWorkout([
      exercise('bench', 'chest'),
      exercise('row', 'mid_back'),
      exercise('curl', 'biceps'),
      exercise('pressdown', 'triceps'),
    ], {
      metadata: meta,
      policy: { order: 'preserve', warmups: 'off', supersets: 'history' },
      history: {
        ...EMPTY_PROGRAMMING_HISTORY,
        supersetSessionRate: 0.75,
      },
    })
    expect(result[0]!.supersetGroup).toBeNull()
    expect(result[1]!.supersetGroup).toBeNull()
    expect(result[2]!.supersetGroup).toBe(result[3]!.supersetGroup)
    expect(result[2]!.restSeconds).toBe(15)
    expect(result[3]!.restSeconds).toBeGreaterThanOrEqual(90)
  })

  it('does not overwrite exact per-exercise rest inside an authored pair', () => {
    const meta = metadata([
      ['curl', 'biceps', 'isolation-biceps'],
      ['pressdown', 'triceps', 'isolation-triceps'],
    ])
    const result = programWorkout([
      exercise('curl', 'biceps', { supersetGroup: 3, restSeconds: 30 }),
      exercise('pressdown', 'triceps', { supersetGroup: 3, restSeconds: 150 }),
    ], {
      metadata: meta,
      policy: { order: 'preserve', warmups: 'off', supersets: 'explicit' },
      preserveExplicitRest: true,
    })
    expect(result.map((row) => row.restSeconds)).toEqual([30, 150])
  })

  it('derives goal-specific reps/rest and adds one task-specific ramp before the first loaded pattern', () => {
    const meta = metadata([
      ['bench', 'chest', 'horizontal-push'],
      ['incline', 'chest', 'horizontal-push'],
    ])
    const result = programWorkout([
      exercise('bench', 'chest', { reps: 12, targetWeight: 200 }),
      exercise('incline', 'chest', { reps: 12, targetWeight: 150 }),
    ], {
      metadata: meta,
      policy: { goal: 'strength', order: 'preserve', supersets: 'off', warmups: 'ramp' },
      redistributeWorkingSets: false,
    })
    expect(result[0]!.reps).toBeGreaterThanOrEqual(3)
    expect(result[0]!.reps).toBeLessThanOrEqual(6)
    expect(result[0]!.restSeconds).toBe(180)
    expect(result[0]!.setPrescriptions?.filter((set) => set.setType === 'warmup')).toHaveLength(3)
    expect(result[1]!.setPrescriptions?.filter((set) => set.setType === 'warmup')).toHaveLength(0)
    expect(result[0]!.setPrescriptions?.filter((set) => set.setType !== 'warmup')).toHaveLength(3)
  })

  it('never invents a compound ramp for an unknown or accessory pattern', () => {
    const meta = metadata([
      ['curl', 'biceps', 'isolation-biceps'],
      ['unknown', 'triceps', 'other'],
    ])
    const result = programWorkout([
      exercise('curl', 'biceps', { targetWeight: 90 }),
      exercise('unknown', 'triceps', { targetWeight: 75 }),
    ], {
      metadata: meta,
      policy: { order: 'preserve', supersets: 'off', warmups: 'ramp', history: 'off' },
      redistributeWorkingSets: false,
    })
    expect(result.every((row) => row.setPrescriptions?.every((set) => set.setType !== 'warmup'))).toBe(true)
    expect(result.map((row) => row.restSeconds)).toEqual([120, 120])
  })

  it('redistributes sets toward compounds without changing regional working volume', () => {
    const meta = metadata([
      ['bench', 'chest', 'horizontal-push'],
      ['fly', 'chest', 'isolation-chest'],
    ])
    const result = programWorkout([
      exercise('bench', 'chest', { sets: 3 }),
      exercise('fly', 'chest', { sets: 3 }),
    ], {
      metadata: meta,
      policy: { goal: 'strength', order: 'preserve', supersets: 'off', warmups: 'off' },
      redistributeWorkingSets: true,
    })
    expect(result.reduce((sum, row) => sum + row.sets, 0)).toBe(6)
    expect(result[0]!.sets).toBeGreaterThan(result[1]!.sets)
  })

  it('bounds historical rest instead of copying a bad habit verbatim', () => {
    const meta = metadata([['bench', 'chest', 'horizontal-push']])
    const result = programWorkout([exercise('bench', 'chest', { reps: 5 })], {
      metadata: meta,
      policy: { goal: 'strength', warmups: 'off' },
      history: {
        ...EMPTY_PROGRAMMING_HISTORY,
        medianRestSeconds: 45,
      },
    })
    expect(result[0]!.restSeconds).toBe(150)
  })
})

describe('duration-based work is never given a rep count', () => {
  // Regression 2026-08-26: repsForGoal has no null branch — with no current reps
  // it returns the MIDPOINT of the goal's range — so it invented "12 reps" for a
  // 2:10 Kegels hold (balanced isolation range [8,15]), which then rendered
  // beside the duration in the logger. A hold is prescribed in seconds; reps are
  // not a thing it has.
  const meta = metadata([
    ['kegels', 'abs', 'isolation-core'],
    ['bench', 'chest', 'horizontal-push'],
  ])

  it('leaves reps null on an exercise-level duration target', () => {
    const [row] = programWorkout(
      [exercise('kegels', 'abs', { reps: null, targetWeight: null, targetDurationS: 130 })],
      { metadata: meta, policy: { warmups: 'off', supersets: 'off' }, redistributeWorkingSets: false },
    )
    expect(row!.reps).toBeNull()
    expect(row!.targetDurationS).toBe(130)
  })

  it('leaves reps null when only the SET prescriptions carry a duration', () => {
    const [row] = programWorkout(
      [
        exercise('kegels', 'abs', {
          reps: null,
          targetWeight: null,
          setPrescriptions: [
            timedSet(130),
            timedSet(130),
          ],
        }),
      ],
      { metadata: meta, policy: { warmups: 'off', supersets: 'off' }, redistributeWorkingSets: false },
    )
    expect(row!.reps).toBeNull()
  })

  it('still fills a rep scheme for ordinary weighted work', () => {
    const [row] = programWorkout([exercise('bench', 'chest', { reps: null })], {
      metadata: meta,
      policy: { warmups: 'off', supersets: 'off' },
      redistributeWorkingSets: false,
    })
    expect(row!.reps).toBeGreaterThan(0)
  })
})

describe('bodyweight reps are never snapped into a goal range', () => {
  // #1879: Pull Up authored at 3x5 bodyweight (a compound "vertical-pull" pattern)
  // came back from a 'balanced' template's ramp generator as 9 reps — the midpoint
  // of the [6,12] compound range for that goal — because repsForGoal treated the
  // authored 5 as a deficiency to correct up to. That's the right move for a
  // barbell lift (drop the weight, add reps); a bodyweight movement has no weight
  // to drop, so 5 was the user's real, deliberate, sub-max target, not a mistake.
  const meta = metadata([['pullup', 'lats', 'vertical-pull']])

  it('keeps an authored rep count for a movement with no external load', () => {
    const [row] = programWorkout(
      [exercise('pullup', 'lats', { reps: 5, targetWeight: null })],
      { metadata: meta, policy: { goal: 'balanced', warmups: 'off', supersets: 'off' }, redistributeWorkingSets: false },
    )
    expect(row!.reps).toBe(5)
  })

  it('still snaps an out-of-range rep count into the goal window for weighted work', () => {
    const [row] = programWorkout(
      [exercise('pullup', 'lats', { reps: 5, targetWeight: 25 })],
      { metadata: meta, policy: { goal: 'balanced', warmups: 'off', supersets: 'off' }, redistributeWorkingSets: false },
    )
    expect(row!.reps).toBe(9)
  })
})
