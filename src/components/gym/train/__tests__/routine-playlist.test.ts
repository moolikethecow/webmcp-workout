/**
 * routine-playlist unit tests (GYM_PLAN §10b.6, M3) — the PURE playlist builder
 * behind the RoutinePlayer. Covers: exercise/set ordering, completed + non-timed
 * + unaddressable (null clientSetId) exclusion, side carry-through, duration
 * resolution (entered → previous ghost → target ghost → 30s fallback), the
 * per-exercise hold counters, and the isTimedRoutine gate.
 */
import { describe, expect, it } from 'vitest'

import type { ActiveExercise, ActiveSet } from '@/lib/gym-client/active-types'
import { EMPTY_GRIP } from '@/lib/gym/grip'

import {
  buildPlaylist,
  isTimedRoutine,
  FALLBACK_HOLD_SECONDS,
  TRANSITION_SECONDS,
} from '../routine-playlist'

// ── fixtures ──────────────────────────────────────────────────────────────────

function set(over: Partial<ActiveSet> = {}): ActiveSet {
  return {
    clientSetId: 'cs-1',
    setNumber: 1,
    setType: 'normal',
    weight: null,
    weightUnit: 'lb',
    reps: null,
    distanceM: null,
    durationS: null,
    rpe: null,
    side: null,
    completed: false,
    ...over,
    logicalSetId: over.logicalSetId ?? crypto.randomUUID(),
  }
}

function exercise(over: Partial<ActiveExercise> = {}): ActiveExercise {
  return {
    grip: EMPTY_GRIP,
    workoutExerciseId: 'we-1',
    exerciseId: 'ex-1',
    name: 'Pigeon Pose',
    tracks: 'time',
    modality: 'stretch',
    perSide: false,
    section: 'main',
    position: 0,
    supersetGroup: null,
    restSeconds: 60,
    preferredUnit: 'lb',
    notes: null,
    targets: [],
    ruleText: '',
    previous: [],
    sets: [],
    ...over,
    loadBasis: over.loadBasis ?? 'total',
  }
}

// ── buildPlaylist ─────────────────────────────────────────────────────────────

describe('buildPlaylist', () => {
  it('orders by exercise position then setNumber, even from shuffled input', () => {
    const exercises = [
      exercise({
        grip: EMPTY_GRIP,
        workoutExerciseId: 'we-b',
        name: 'Couch Stretch',
        position: 2,
        sets: [
          set({ clientSetId: 'b2', setNumber: 2, durationS: 45 }),
          set({ clientSetId: 'b1', setNumber: 1, durationS: 45 }),
        ],
      }),
      exercise({
        grip: EMPTY_GRIP,
        workoutExerciseId: 'we-a',
        name: 'Pigeon Pose',
        position: 1,
        sets: [set({ clientSetId: 'a1', setNumber: 1, durationS: 60 })],
      }),
    ]
    expect(buildPlaylist(exercises).map((s) => s.clientSetId)).toEqual(['a1', 'b1', 'b2'])
  })

  it('skips completed sets and numbers the remaining holds 1..n', () => {
    const exercises = [
      exercise({
        sets: [
          set({ clientSetId: 'c1', setNumber: 1, durationS: 30, completed: true }),
          set({ clientSetId: 'c2', setNumber: 2, durationS: 30 }),
          set({ clientSetId: 'c3', setNumber: 3, durationS: 30 }),
        ],
      }),
    ]
    const steps = buildPlaylist(exercises)
    expect(steps.map((s) => s.clientSetId)).toEqual(['c2', 'c3'])
    expect(steps.map((s) => s.indexInExercise)).toEqual([1, 2])
    expect(steps.every((s) => s.totalInExercise === 2)).toBe(true)
  })

  it('skips non-time exercises entirely', () => {
    const exercises = [
      exercise({
        grip: EMPTY_GRIP,
        workoutExerciseId: 'we-lift',
        name: 'Bench Press',
        tracks: 'weight_reps',
        position: 0,
        sets: [set({ clientSetId: 'lift-1', reps: 8, weight: 135 })],
      }),
      exercise({
        grip: EMPTY_GRIP,
        workoutExerciseId: 'we-hold',
        position: 1,
        sets: [set({ clientSetId: 'hold-1', durationS: 60 })],
      }),
    ]
    const steps = buildPlaylist(exercises)
    expect(steps).toHaveLength(1)
    expect(steps[0].workoutExerciseId).toBe('we-hold')
  })

  it('skips sets without a clientSetId (nothing addressable to complete)', () => {
    const exercises = [
      exercise({
        sets: [
          set({ clientSetId: null, setNumber: 1, durationS: 30 }),
          set({ clientSetId: 'ok', setNumber: 2, durationS: 30 }),
        ],
      }),
    ]
    const steps = buildPlaylist(exercises)
    expect(steps.map((s) => s.clientSetId)).toEqual(['ok'])
    expect(steps[0].totalInExercise).toBe(1)
  })

  it('carries each set side through to its step', () => {
    const exercises = [
      exercise({
        perSide: true,
        sets: [
          set({ clientSetId: 'l', setNumber: 1, durationS: 30, side: 'left' }),
          set({ clientSetId: 'r', setNumber: 2, durationS: 30, side: 'right' }),
        ],
      }),
    ]
    expect(buildPlaylist(exercises).map((s) => s.side)).toEqual(['left', 'right'])
  })

  it('uses the entered durationS when present', () => {
    const exercises = [
      exercise({
        targets: [{ durationS: 45 }],
        sets: [set({ durationS: 90 })],
      }),
    ]
    expect(buildPlaylist(exercises)[0].durationS).toBe(90)
  })

  it('falls back to the ghost (previous, then target) when no value was entered', () => {
    const withPrevious = exercise({
      previous: [
        { setNumber: 1, weight: null, unit: 'lb', reps: null, durationS: 75, distanceM: null },
      ],
      targets: [{ durationS: 45 }],
      sets: [set()],
    })
    expect(buildPlaylist([withPrevious])[0].durationS).toBe(75)

    const withTargetOnly = exercise({
      targets: [{ durationS: 45 }],
      sets: [set()],
    })
    expect(buildPlaylist([withTargetOnly])[0].durationS).toBe(45)
  })

  it(`falls back to ${FALLBACK_HOLD_SECONDS}s when nothing resolves`, () => {
    const exercises = [exercise({ sets: [set()] })]
    expect(buildPlaylist(exercises)[0].durationS).toBe(FALLBACK_HOLD_SECONDS)
  })

  it('carries name + workoutExerciseId onto every step', () => {
    const exercises = [
      exercise({
        grip: EMPTY_GRIP,
        workoutExerciseId: 'we-x',
        name: "World's Greatest Stretch",
        sets: [set({ clientSetId: 'x1', durationS: 30 })],
      }),
    ]
    const [step] = buildPlaylist(exercises)
    expect(step.exerciseName).toBe("World's Greatest Stretch")
    expect(step.workoutExerciseId).toBe('we-x')
  })

  it('exports a 5s transition window', () => {
    expect(TRANSITION_SECONDS).toBe(5)
  })
})

// ── isTimedRoutine ────────────────────────────────────────────────────────────

describe('isTimedRoutine', () => {
  it('is false for an empty workout', () => {
    expect(isTimedRoutine([])).toBe(false)
  })

  it('is false when ANY exercise is not timed (mixed strength session)', () => {
    const exercises = [
      exercise({ sets: [set({ durationS: 30 })] }),
      exercise({
        grip: EMPTY_GRIP,
        workoutExerciseId: 'we-lift',
        tracks: 'weight_reps',
        sets: [set({ clientSetId: 'lift-1' })],
      }),
    ]
    expect(isTimedRoutine(exercises)).toBe(false)
  })

  it('is false when every hold is already completed', () => {
    const exercises = [
      exercise({ sets: [set({ completed: true }), set({ clientSetId: null, setNumber: 2 })] }),
    ]
    expect(isTimedRoutine(exercises)).toBe(false)
  })

  it('is true for an all-timed session with a playable hold left', () => {
    const exercises = [
      exercise({ sets: [set({ completed: true }), set({ clientSetId: 'p2', setNumber: 2 })] }),
      exercise({ workoutExerciseId: 'we-2', position: 1, sets: [set({ clientSetId: 'q1', completed: true })] }),
    ]
    expect(isTimedRoutine(exercises)).toBe(true)
  })
})
