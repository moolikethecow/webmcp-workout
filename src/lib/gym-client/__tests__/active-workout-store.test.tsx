/**
 * @vitest-environment jsdom
 *
 * Active-workout store reducer tests (GYM_PLAN §2.4). Drives the store through
 * ActiveWorkoutProvider with an INJECTED api (no network) and asserts the
 * optimistic local-state semantics that the logger depends on:
 *   - ghost-commit: ✓ on an UNTOUCHED row commits previous-else-target values
 *   - addSet clones the last row's values as the new row's ghosts
 *   - cycleSetType toggles warmup/drop/failure ⇄ normal
 *   - updateSetField writes through instantly (never awaits the network)
 * Plus the pure exported helpers (ghostFor / committedValue / fieldsForTracks).
 *
 * The queue mirror key is reset in beforeEach (CI localStorage-flake pattern).
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ReactNode } from 'react'

import {
  ActiveWorkoutProvider,
  useActiveWorkoutStore,
  ghostFor,
  committedValue,
  fieldsForTracks,
  type ActiveWorkoutApi,
} from '../active-workout-store'
import { QUEUE_MIRROR_KEY, type ActiveExercise, type ActiveSet, type ActiveWorkout } from '../active-types'
import { StaleWorkoutRevisionError } from '../write-queue'
import { invalidateResources } from '@/lib/stores/data-sync-store'
import { EMPTY_GRIP } from '@/lib/gym/grip'

// Map-backed localStorage (jsdom's is partial under forks).
const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    get length() {
      return mem.size
    },
  },
})

function mkSet(over: Partial<ActiveSet> = {}): ActiveSet {
  return {
    clientSetId: crypto.randomUUID(),
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

function mkExercise(over: Partial<ActiveExercise> = {}): ActiveExercise {
  return {
    grip: EMPTY_GRIP,
    workoutExerciseId: 'we1',
    exerciseId: 'ex1',
    name: 'Bench Press',
    tracks: 'weight_reps',
    modality: 'strength',
    perSide: false,
    section: 'main',
    position: 0,
    supersetGroup: null,
    restSeconds: 120,
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

function mkWorkout(exercises: ActiveExercise[]): ActiveWorkout {
  return {
    id: 'w1',
    revision: 0,
    name: 'Push',
    status: 'active',
    startedAt: new Date().toISOString(),
    templateId: null,
    templateName: null,
    exercises,
  }
}

/** An api whose getActive returns a seeded workout, everything else a no-op echo. */
function apiFor(workout: ActiveWorkout): ActiveWorkoutApi {
  return {
    getActive: vi.fn().mockResolvedValue(workout),
    start: vi.fn().mockResolvedValue({ workout }),
    putSets: vi.fn().mockResolvedValue({ byExercise: {}, revision: workout.revision + 1 }),
    editExercises: vi.fn().mockResolvedValue(workout),
    patchMeta: vi.fn().mockResolvedValue(workout),
    finish: vi.fn(),
    discard: vi.fn().mockResolvedValue(undefined),
  }
}

function wrapperFor(api: ActiveWorkoutApi) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <ActiveWorkoutProvider api={api}>{children}</ActiveWorkoutProvider>
  }
}

async function mounted(workout: ActiveWorkout) {
  const api = apiFor(workout)
  const { result } = renderHook(() => useActiveWorkoutStore(), { wrapper: wrapperFor(api) })
  // Let the mount probe hydrate the store (flush the getActive() promise chain
  // fully inside act so React batches the resulting state updates).
  await act(async () => {
    await api.getActive()
    await Promise.resolve()
    await Promise.resolve()
  })
  return { result, api }
}

beforeEach(() => {
  // Fake timers keep the store's 1s elapsed-timer interval from firing a stray
  // setNow after assertions (act warning) and make everything deterministic.
  vi.useFakeTimers()
  globalThis.localStorage?.setItem?.(QUEUE_MIRROR_KEY, '')
  globalThis.localStorage?.removeItem?.(QUEUE_MIRROR_KEY)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

// ── pure helpers ──────────────────────────────────────────────────────────────

/**
 * Prefill from what actually happened this session (#1878).
 *
 * The user's 2026-08-31 session: template said 105 lb, he worked 90, then retyped
 * 90×10 twice more against a ghost still showing 105. Straight sets repeat, and
 * the plan goes stale the moment the load is adjusted.
 */
describe('ghostFor prefills from this session before last session or the target', () => {
  const done = (over: Record<string, unknown> = {}) =>
    mkSet({ completed: true, weight: 90, reps: 10, ...over })

  it('a later set takes the weight and reps just logged, not the template', () => {
    const ex = mkExercise({
      previous: [{ setNumber: 1, weight: 185, unit: 'lb', reps: 8, durationS: null, distanceM: null }],
      targets: [{ weight: 105, reps: 10 }],
      sets: [
        done({ clientSetId: 's1', setNumber: 1 }),
        mkSet({ clientSetId: 's2', setNumber: 2 }),
      ],
    })
    expect(ghostFor(ex, 2, 'weight')).toBe(90)
    expect(ghostFor(ex, 2, 'reps')).toBe(10)
  })

  it('set 1 itself is unaffected — there is nothing above it', () => {
    const ex = mkExercise({
      previous: [],
      targets: [{ weight: 105, reps: 10 }],
      sets: [mkSet({ clientSetId: 's1', setNumber: 1 })],
    })
    expect(ghostFor(ex, 1, 'weight')).toBe(105)
  })

  // A blank row below is not evidence of anything; treating it as a source
  // would blank the ghost for every row under it.
  it('ignores rows that have not been completed', () => {
    const ex = mkExercise({
      // Two targets, so set 2 HAS a target ghost to fall back to — otherwise
      // this would pass for the wrong reason (no ghost at all).
      targets: [
        { setNumber: 1, weight: 105, reps: 10 },
        { setNumber: 2, weight: 105, reps: 10 },
      ],
      sets: [
        mkSet({ clientSetId: 's1', setNumber: 1, weight: 90, reps: 10 }),
        mkSet({ clientSetId: 's2', setNumber: 2 }),
      ],
    })
    expect(ghostFor(ex, 2, 'weight')).toBe(105)
  })

  // The same reason ghost lanes exist: a warm-up must never inherit a working
  // weight, and a working set must not inherit the warm-up's.
  it('never crosses the warm-up / working lane', () => {
    const ex = mkExercise({
      targets: [
        { setNumber: 1, setType: 'warmup', weight: 45, reps: 10 },
        { setNumber: 2, setType: 'normal', weight: 105, reps: 10 },
      ],
      sets: [
        done({ clientSetId: 'w1', setNumber: 1, setType: 'warmup', weight: 45 }),
        mkSet({ clientSetId: 's1', setNumber: 2 }),
      ],
    })
    expect(ghostFor(ex, 2, 'weight')).toBe(105)
  })

  // A drop set is deliberately lighter. Sourcing from one would drag every set
  // after it down — but it still RECEIVES a prefill and stays editable.
  it('does not source from a drop set, but does prefill one', () => {
    const ex = mkExercise({
      targets: [{ weight: 105, reps: 10 }],
      sets: [
        done({ clientSetId: 's1', setNumber: 1, weight: 90 }),
        done({ clientSetId: 'drop', setNumber: 2, setType: 'drop', weight: 50 }),
        mkSet({ clientSetId: 's3', setNumber: 3 }),
      ],
    })
    expect(ghostFor(ex, 2, 'weight')).toBe(90)
    expect(ghostFor(ex, 3, 'weight')).toBe(90)
  })

  // Prefill populates fields. An entered value already wins in committedValue,
  // so an edited set cannot be overwritten by a later change to set 1.
  it('never overrides a value the user actually typed', () => {
    const ex = mkExercise({
      targets: [{ weight: 105, reps: 10 }],
      sets: [
        done({ clientSetId: 's1', setNumber: 1, weight: 90 }),
        mkSet({ clientSetId: 's2', setNumber: 2, weight: 75 }),
      ],
    })
    expect(committedValue(ex, ex.sets[1]!, 'weight')).toBe(75)
  })

  // RPE is a judgement about one set, not a value that repeats.
  it('does not carry RPE forward', () => {
    const ex = mkExercise({
      sets: [
        done({ clientSetId: 's1', setNumber: 1, rpe: 9 }),
        mkSet({ clientSetId: 's2', setNumber: 2 }),
      ],
    })
    expect(ghostFor(ex, 2, 'rpe')).toBeNull()
  })

  it('carries duration forward for a timed exercise', () => {
    const ex = mkExercise({
      targets: [{ setNumber: 1, durationS: 20 }, { setNumber: 2, durationS: 20 }],
      sets: [
        done({ clientSetId: 's1', setNumber: 1, weight: null, reps: null, durationS: 45 }),
        mkSet({ clientSetId: 's2', setNumber: 2 }),
      ],
    })
    expect(ghostFor(ex, 2, 'durationS')).toBe(45)
  })
})

describe('ghostFor / committedValue / fieldsForTracks (pure)', () => {
  it('prefers the previous-session value over the progression target', () => {
    const ex = mkExercise({
      previous: [{ setNumber: 1, weight: 185, unit: 'lb', reps: 8, durationS: null, distanceM: null }],
      targets: [{ weight: 190, reps: 8 }],
      sets: [mkSet()],
    })
    expect(ghostFor(ex, 1, 'weight')).toBe(185)
    expect(ghostFor(ex, 1, 'reps')).toBe(8)
  })

  it('falls back to the target when there is no previous set', () => {
    const ex = mkExercise({ previous: [], targets: [{ weight: 135, reps: 5 }] })
    expect(ghostFor(ex, 1, 'weight')).toBe(135)
    expect(ghostFor(ex, 1, 'reps')).toBe(5)
  })

  it('aligns ghosts by warm-up vs working ordinal after a warm-up is inserted', () => {
    const previous = [
      { setNumber: 1, setType: 'normal', weight: 185, unit: 'lb', reps: 8, durationS: null, distanceM: null },
      { setNumber: 2, setType: 'normal', weight: 180, unit: 'lb', reps: 9, durationS: null, distanceM: null },
    ] as Array<ActiveExercise['previous'][number] & { setType: string }>
    const ex = mkExercise({
      previous,
      targets: [
        { setNumber: 1, setType: 'normal', weight: 190, reps: 8 },
        { setNumber: 2, setType: 'normal', weight: 190, reps: 8 },
      ],
      sets: [
        mkSet({ clientSetId: 'warmup', setNumber: 1, setType: 'warmup' }),
        mkSet({ clientSetId: 'work-1', setNumber: 2 }),
        mkSet({ clientSetId: 'work-2', setNumber: 3 }),
      ],
    })

    expect(ghostFor(ex, 1, 'weight')).toBeNull()
    expect(ghostFor(ex, 2, 'weight')).toBe(185)
    expect(ghostFor(ex, 3, 'weight')).toBe(180)

    expect(ghostFor({ ...ex, previous: [] }, 2, 'weight')).toBe(190)
    expect(ghostFor({ ...ex, previous: [] }, 3, 'weight')).toBe(190)
  })

  it('does not reuse the first warm-up target for a newly appended warm-up row', () => {
    const ex = mkExercise({
      targets: [
        { setNumber: 1, setType: 'warmup', weight: 45, reps: 10 },
        { setNumber: 2, setType: 'normal', weight: 185, reps: 8 },
      ],
      sets: [
        mkSet({ clientSetId: 'warmup-1', setNumber: 1, setType: 'warmup' }),
        mkSet({ clientSetId: 'warmup-2', setNumber: 2, setType: 'warmup' }),
        mkSet({ clientSetId: 'work-1', setNumber: 3 }),
      ],
    })

    expect(ghostFor(ex, 1, 'weight')).toBe(45)
    expect(ghostFor(ex, 2, 'weight')).toBeNull()
    expect(ghostFor(ex, 3, 'weight')).toBe(185)
  })

  it('aligns Split ghosts by logical round and side', () => {
    const currentLogical = crypto.randomUUID()
    const previousLogical = crypto.randomUUID()
    const left = mkSet({ setNumber: 1, side: 'left', logicalSetId: currentLogical })
    const right = mkSet({ setNumber: 2, side: 'right', logicalSetId: currentLogical })
    const ex = mkExercise({
      sets: [left, right],
      previous: [
        { setNumber: 1, weight: 40, unit: 'lb', reps: 10, durationS: null, distanceM: null, side: 'left', logicalSetId: previousLogical },
        { setNumber: 2, weight: 42.5, unit: 'lb', reps: 10, durationS: null, distanceM: null, side: 'right', logicalSetId: previousLogical },
      ],
    })

    expect(ghostFor(ex, left, 'weight')).toBe(40)
    expect(ghostFor(ex, right, 'weight')).toBe(42.5)
  })

  it('committedValue returns the entered value when present, else the ghost', () => {
    const ex = mkExercise({ previous: [{ setNumber: 1, weight: 185, unit: 'lb', reps: 8, durationS: null, distanceM: null }] })
    const touched = mkSet({ weight: 200 })
    const untouched = mkSet({ weight: null })
    expect(committedValue(ex, touched, 'weight')).toBe(200)
    expect(committedValue(ex, untouched, 'weight')).toBe(185)
  })

  it('fieldsForTracks returns the right commit fields per tracks shape', () => {
    expect(fieldsForTracks('weight_reps')).toEqual(['weight', 'reps'])
    expect(fieldsForTracks('reps')).toEqual(['reps'])
    expect(fieldsForTracks('time')).toEqual(['weight', 'durationS'])
    expect(fieldsForTracks('distance_time')).toEqual(['distanceM', 'durationS'])
  })
})

// ── store reducer ───────────────────────────────────────────────────────────

describe('ActiveWorkoutStore ghost-commit', () => {
  it('✓ on an UNTOUCHED row commits the previous-session ghosts as the set values', async () => {
    const clientSetId = 'set-a'
    const ex = mkExercise({
      previous: [{ setNumber: 1, weight: 185, unit: 'lb', reps: 8, durationS: null, distanceM: null }],
      sets: [mkSet({ clientSetId, weight: null, reps: null })],
    })
    const { result } = await mounted(mkWorkout([ex]))

    await act(async () => {
      result.current.completeSet('we1', clientSetId)
    })

    const set = result.current.workout!.exercises[0]!.sets[0]!
    expect(set.completed).toBe(true)
    expect(set.weight).toBe(185) // ghost committed
    expect(set.reps).toBe(8)
  })

  it('✓ on an UNTOUCHED row falls back to the TARGET when no previous exists', async () => {
    const clientSetId = 'set-b'
    const ex = mkExercise({
      previous: [],
      targets: [{ weight: 135, reps: 5 }],
      sets: [mkSet({ clientSetId, weight: null, reps: null })],
    })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => {
      result.current.completeSet('we1', clientSetId)
    })
    const set = result.current.workout!.exercises[0]!.sets[0]!
    expect(set.weight).toBe(135)
    expect(set.reps).toBe(5)
  })

  it('✓ on an UNTOUCHED row with no previous and no target fills 0, not null (#1842)', async () => {
    const clientSetId = 'set-zero'
    const ex = mkExercise({
      previous: [],
      targets: [],
      sets: [mkSet({ clientSetId, weight: null, reps: null })],
    })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => {
      result.current.completeSet('we1', clientSetId)
    })
    const set = result.current.workout!.exercises[0]!.sets[0]!
    expect(set.completed).toBe(true)
    expect(set.weight).toBe(0)
    expect(set.reps).toBe(0)
  })

  it('✓ on a TOUCHED row keeps the entered values (does not overwrite with ghosts)', async () => {
    const clientSetId = 'set-c'
    const ex = mkExercise({
      previous: [{ setNumber: 1, weight: 185, unit: 'lb', reps: 8, durationS: null, distanceM: null }],
      sets: [mkSet({ clientSetId, weight: 225, reps: 3 })],
    })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => {
      result.current.completeSet('we1', clientSetId)
    })
    const set = result.current.workout!.exercises[0]!.sets[0]!
    expect(set.weight).toBe(225) // entered value preserved
    expect(set.reps).toBe(3)
  })
})

describe('ActiveWorkoutStore mutations', () => {
  it('applies a detail-sheet load-basis edit to the active logger immediately', async () => {
    const { result } = await mounted(mkWorkout([mkExercise({ loadBasis: 'total' })]))

    act(() => result.current.updateExerciseLoadBasis('we1', 'per_side'))

    expect(result.current.workout!.exercises[0]!.loadBasis).toBe('per_side')
    expect(result.current.sideModeFor('we1')).toBe('both')
  })

  it('updateSetField writes through to local state instantly', async () => {
    const clientSetId = 'set-d'
    const ex = mkExercise({ sets: [mkSet({ clientSetId })] })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => {
      result.current.updateSetField(clientSetId, 'weight', 315)
    })
    expect(result.current.workout!.exercises[0]!.sets[0]!.weight).toBe(315)
  })

  it('replaceExercise passes keepPrescription through to the edit call (#1876)', async () => {
    const ex = mkExercise({})
    const { result, api } = await mounted(mkWorkout([ex]))
    await act(async () => {
      await result.current.replaceExercise('we1', 'ex-new', true)
    })
    expect(api.editExercises).toHaveBeenCalledWith(
      'w1',
      { replace: [{ workoutExerciseId: 'we1', newExerciseId: 'ex-new', keepPrescription: true }] },
      0,
    )
  })

  it('addSet clones the last row values as the new row (Strong ghost clone)', async () => {
    const ex = mkExercise({ sets: [mkSet({ clientSetId: 's1', weight: 200, reps: 6, setNumber: 1 })] })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => {
      result.current.addSet('we1')
    })
    const sets = result.current.workout!.exercises[0]!.sets
    expect(sets).toHaveLength(2)
    const added = sets[1]!
    expect(added.setNumber).toBe(2)
    expect(added.weight).toBe(200) // cloned
    expect(added.reps).toBe(6)
    expect(added.completed).toBe(false)
    expect(added.clientSetId).not.toBe('s1') // fresh uuid
  })

  it('addWarmupSet inserts one blank warm-up before working sets and reindexes', async () => {
    const ex = mkExercise({
      sets: [
        mkSet({ clientSetId: 'w1', setNumber: 1, setType: 'warmup', weight: 45 }),
        mkSet({ clientSetId: 's1', setNumber: 2, setType: 'normal', weight: 200 }),
      ],
    })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => {
      result.current.addWarmupSet('we1')
    })
    const sets = result.current.workout!.exercises[0]!.sets
    expect(sets.map((set) => [set.setNumber, set.setType])).toEqual([
      [1, 'warmup'],
      [2, 'warmup'],
      [3, 'normal'],
    ])
    expect(sets[1]).toMatchObject({ weight: null, reps: null, completed: false })
  })

  it('completing a newly added warm-up never commits the working-set ghost', async () => {
    const previous = [
      { setNumber: 1, setType: 'normal', weight: 185, unit: 'lb', reps: 8, durationS: null, distanceM: null },
    ] as Array<ActiveExercise['previous'][number] & { setType: string }>
    const ex = mkExercise({
      previous,
      targets: [{ setNumber: 1, setType: 'normal', weight: 190, reps: 8 }],
      sets: [mkSet({ clientSetId: 'work-1', setNumber: 1 })],
    })
    const { result } = await mounted(mkWorkout([ex]))

    await act(async () => {
      result.current.addWarmupSet('we1')
    })
    const warmupId = result.current.workout!.exercises[0]!.sets[0]!.clientSetId!
    await act(async () => {
      result.current.completeSet('we1', warmupId)
      await Promise.resolve()
    })

    expect(result.current.workout!.exercises[0]!.sets[0]).toMatchObject({
      setType: 'warmup',
      weight: 0, // no warmup ghost to commit (not the working set's 190) — 0-fills instead (#1842)
      reps: 0,
      completed: true,
    })
  })

  it('addSet on a per-side hold adds an L/R PAIR (§10b.2)', async () => {
    const ex = mkExercise({
      tracks: 'time',
      perSide: true,
      sets: [mkSet({ clientSetId: 's1', durationS: 45, setNumber: 1, side: 'left' })],
    })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => {
      result.current.addSet('we1')
    })
    const sets = result.current.workout!.exercises[0]!.sets
    expect(sets).toHaveLength(3)
    expect(sets[1]!.side).toBe('left')
    expect(sets[2]!.side).toBe('right')
    expect(sets[1]!.setNumber).toBe(2)
    expect(sets[2]!.setNumber).toBe(3)
    // Both clone the last row's hold duration as their ghost.
    expect(sets[1]!.durationS).toBe(45)
    expect(sets[2]!.durationS).toBe(45)
    expect(sets[1]!.logicalSetId).toBe(sets[2]!.logicalSetId)
  })

  it('defaults per-side strength to one Both row and can author Split rounds', async () => {
    const ex = mkExercise({ loadBasis: 'per_side', sets: [] })
    const { result } = await mounted(mkWorkout([ex]))

    act(() => result.current.addSet('we1'))
    expect(result.current.workout!.exercises[0]!.sets).toHaveLength(1)
    expect(result.current.workout!.exercises[0]!.sets[0]!.side).toBeNull()

    act(() => result.current.setSideMode('we1', 'split'))
    const reshaped = result.current.workout!.exercises[0]!.sets
    expect(reshaped.map((set) => set.side)).toEqual(['left', 'right'])
    expect(reshaped[0]!.logicalSetId).toBe(reshaped[1]!.logicalSetId)

    act(() => result.current.addSet('we1'))
    const added = result.current.workout!.exercises[0]!.sets.slice(2)
    expect(added.map((set) => set.side)).toEqual(['left', 'right'])
    expect(added[0]!.logicalSetId).toBe(added[1]!.logicalSetId)
    expect(added[0]!.logicalSetId).not.toBe(reshaped[0]!.logicalSetId)
  })

  it.each([
    ['left', 'left'],
    ['right', 'right'],
  ] as const)('authors a single tagged row in %s-only mode', async (mode, expectedSide) => {
    const ex = mkExercise({ loadBasis: 'per_side', sets: [] })
    const { result } = await mounted(mkWorkout([ex]))

    act(() => result.current.setSideMode('we1', mode))
    act(() => result.current.addSet('we1'))

    expect(result.current.workout!.exercises[0]!.sets).toMatchObject([
      { side: expectedSide, setNumber: 1 },
    ])
  })

  it('never reshapes completed or partially-entered logical rounds', async () => {
    const completedId = crypto.randomUUID()
    const typedId = crypto.randomUUID()
    const ex = mkExercise({
      loadBasis: 'per_side',
      sets: [
        mkSet({ clientSetId: 'done', logicalSetId: completedId, completed: true, weight: 42.5 }),
        mkSet({ clientSetId: 'typed', logicalSetId: typedId, weight: 40 }),
      ],
    })
    const { result } = await mounted(mkWorkout([ex]))

    act(() => result.current.setSideMode('we1', 'split'))

    expect(result.current.workout!.exercises[0]!.sets).toMatchObject([
      { clientSetId: 'done', side: null, completed: true, weight: 42.5 },
      { clientSetId: 'typed', side: null, completed: false, weight: 40 },
    ])
  })

  it('addWarmupSet on a per-side hold adds an L/R PAIR (§10b.2, #1840)', async () => {
    const ex = mkExercise({
      tracks: 'time',
      perSide: true,
      sets: [mkSet({ clientSetId: 's1', durationS: 30, setNumber: 1, side: 'left' })],
    })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => {
      result.current.addWarmupSet('we1')
    })
    const sets = result.current.workout!.exercises[0]!.sets
    expect(sets.slice(0, 2).map((set) => [set.setType, set.side])).toEqual([
      ['warmup', 'left'],
      ['warmup', 'right'],
    ])
    expect(sets[0]!.logicalSetId).toBe(sets[1]!.logicalSetId)
    expect(sets[2]).toMatchObject({ clientSetId: 's1', setType: 'normal', side: 'left' })
  })

  it('applies Split to strength warm-ups while preserving their set type', async () => {
    const ex = mkExercise({
      loadBasis: 'per_side',
      sets: [mkSet({ clientSetId: 'working', weight: 40 })],
    })
    const { result } = await mounted(mkWorkout([ex]))

    act(() => result.current.setSideMode('we1', 'split'))
    act(() => result.current.addWarmupSet('we1'))

    const sets = result.current.workout!.exercises[0]!.sets
    expect(sets.slice(0, 2).map((set) => [set.setType, set.side])).toEqual([
      ['warmup', 'left'],
      ['warmup', 'right'],
    ])
    expect(sets[0]!.logicalSetId).toBe(sets[1]!.logicalSetId)
    expect(sets[2]).toMatchObject({ clientSetId: 'working', setType: 'normal', side: null })
  })

  it('reshapes an untouched strength warm-up when side mode changes', async () => {
    const warmupLogicalId = crypto.randomUUID()
    const ex = mkExercise({
      loadBasis: 'per_side',
      sets: [
        mkSet({ clientSetId: 'warmup', logicalSetId: warmupLogicalId, setType: 'warmup' }),
        mkSet({ clientSetId: 'working', weight: 40, setNumber: 2 }),
      ],
    })
    const { result } = await mounted(mkWorkout([ex]))

    act(() => result.current.setSideMode('we1', 'split'))

    expect(result.current.workout!.exercises[0]!.sets.slice(0, 2)).toMatchObject([
      { logicalSetId: warmupLogicalId, setType: 'warmup', side: 'left' },
      { logicalSetId: warmupLogicalId, setType: 'warmup', side: 'right' },
    ])
  })

  it('deletes and retypes an entire Split logical round', async () => {
    const firstId = crypto.randomUUID()
    const secondId = crypto.randomUUID()
    const ex = mkExercise({
      loadBasis: 'per_side',
      sets: [
        mkSet({ clientSetId: 'l1', logicalSetId: firstId, setNumber: 1, side: 'left' }),
        mkSet({ clientSetId: 'r1', logicalSetId: firstId, setNumber: 2, side: 'right' }),
        mkSet({ clientSetId: 'both2', logicalSetId: secondId, setNumber: 3 }),
      ],
    })
    const { result } = await mounted(mkWorkout([ex]))

    act(() => result.current.cycleSetType('l1', 'failure'))
    expect(result.current.workout!.exercises[0]!.sets.slice(0, 2).map((set) => set.setType)).toEqual([
      'failure', 'failure',
    ])

    act(() => result.current.deleteSet('r1'))
    expect(result.current.workout!.exercises[0]!.sets).toMatchObject([
      { clientSetId: 'both2', setNumber: 1 },
    ])
  })

  it('cycleSetType toggles a type on, and the same type off to normal', async () => {
    const ex = mkExercise({ sets: [mkSet({ clientSetId: 's1' })] })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => {
      result.current.cycleSetType('s1', 'warmup')
    })
    expect(result.current.workout!.exercises[0]!.sets[0]!.setType).toBe('warmup')
    await act(async () => {
      result.current.cycleSetType('s1', 'warmup')
    })
    expect(result.current.workout!.exercises[0]!.sets[0]!.setType).toBe('normal')
  })

  it('deleteSet removes a set and renumbers the remainder contiguously', async () => {
    const ex = mkExercise({
      sets: [
        mkSet({ clientSetId: 's1', setNumber: 1 }),
        mkSet({ clientSetId: 's2', setNumber: 2 }),
        mkSet({ clientSetId: 's3', setNumber: 3 }),
      ],
    })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => {
      result.current.deleteSet('s2')
    })
    const sets = result.current.workout!.exercises[0]!.sets
    expect(sets.map((s) => s.clientSetId)).toEqual(['s1', 's3'])
    expect(sets.map((s) => s.setNumber)).toEqual([1, 2]) // renumbered
  })

  it('reorderExercise writes one full, unique, contiguous order', async () => {
    const workout = mkWorkout([
      mkExercise({ workoutExerciseId: 'we1', exerciseId: 'ex1', position: 0 }),
      mkExercise({ workoutExerciseId: 'we2', exerciseId: 'ex2', position: 1 }),
      mkExercise({ workoutExerciseId: 'we3', exerciseId: 'ex3', position: 2 }),
    ])
    const api = apiFor(workout)
    const edit = vi.mocked(api.editExercises)
    edit.mockImplementation(async (_workoutId, body) => {
      const order = body.reorder as Array<{ workoutExerciseId: string; position: number }>
      const byId = new Map(order.map((item) => [item.workoutExerciseId, item.position]))
      return {
        ...workout,
        exercises: workout.exercises
          .map((ex) => ({ ...ex, position: byId.get(ex.workoutExerciseId) ?? ex.position }))
          .sort((a, b) => a.position - b.position),
      }
    })
    const { result } = renderHook(() => useActiveWorkoutStore(), { wrapper: wrapperFor(api) })
    await act(async () => {
      await api.getActive()
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => result.current.reorderExercise('we3', 0))

    expect(edit).toHaveBeenCalledWith(
      'w1',
      {
        reorder: [
          { workoutExerciseId: 'we3', position: 0 },
          { workoutExerciseId: 'we1', position: 1 },
          { workoutExerciseId: 'we2', position: 2 },
        ],
      },
      0,
    )
    expect(result.current.workout!.exercises.map((ex) => [ex.workoutExerciseId, ex.position])).toEqual([
      ['we3', 0],
      ['we1', 1],
      ['we2', 2],
    ])
  })

  it('setSupersetGroup replaces arbitrary membership in one atomic structural edit', async () => {
    const workout = mkWorkout([
      mkExercise({ workoutExerciseId: 'we1', exerciseId: 'ex1', position: 0, supersetGroup: 4 }),
      mkExercise({ workoutExerciseId: 'we2', exerciseId: 'ex2', position: 1, supersetGroup: 4 }),
      mkExercise({ workoutExerciseId: 'we3', exerciseId: 'ex3', position: 2, supersetGroup: null }),
    ])
    const api = apiFor(workout)
    const { result } = renderHook(() => useActiveWorkoutStore(), { wrapper: wrapperFor(api) })
    await act(async () => {
      await api.getActive()
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => result.current.setSupersetGroup(['we1', 'we3'], 4))

    expect(api.editExercises).toHaveBeenCalledWith(
      'w1',
      {
        superset: [
          { workoutExerciseId: 'we2', group: null },
          { workoutExerciseId: 'we3', group: 4 },
        ],
      },
      0,
    )
  })

  it('persists a typed exercise note once the debounce elapses (was local-only)', async () => {
    const { result, api } = await mounted(mkWorkout([mkExercise({ workoutExerciseId: 'we1' })]))

    await act(async () => {
      result.current.updateExerciseNotes('we1', 'elbows')
      result.current.updateExerciseNotes('we1', 'elbows tucked')
    })
    // Still local while the user is mid-word — one write, not one per keystroke.
    expect(api.editExercises).not.toHaveBeenCalled()
    expect(result.current.workout?.exercises[0]?.notes).toBe('elbows tucked')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(api.editExercises).toHaveBeenCalledTimes(1)
    expect(api.editExercises).toHaveBeenCalledWith(
      'w1',
      { notes: [{ workoutExerciseId: 'we1', notes: 'elbows tucked' }] },
      0,
    )
  })

  it('keeps keystrokes that land during the round-trip from being rewound', async () => {
    const workout = mkWorkout([mkExercise({ workoutExerciseId: 'we1', notes: null })])
    const { result, api } = await mounted(workout)
    // The server echoes the canonical row WITHOUT the newest characters.
    vi.mocked(api.editExercises).mockResolvedValue({
      ...workout,
      revision: 1,
      exercises: [{ ...workout.exercises[0]!, notes: 'pause' }],
    })

    await act(async () => {
      result.current.updateExerciseNotes('we1', 'pause')
      const inFlight = result.current.commitExerciseNotes()
      result.current.updateExerciseNotes('we1', 'pause on chest')
      await inFlight
    })

    expect(result.current.workout?.exercises[0]?.notes).toBe('pause on chest')
  })

  it('saveExerciseNoteToTemplate sends the newest draft and cancels the pending debounce', async () => {
    const { result, api } = await mounted(mkWorkout([mkExercise({ workoutExerciseId: 'we1' })]))

    await act(async () => {
      result.current.updateExerciseNotes('we1', 'pause on chest')
      await result.current.saveExerciseNoteToTemplate('we1')
    })

    expect(api.editExercises).toHaveBeenCalledWith(
      'w1',
      { notes: [{ workoutExerciseId: 'we1', notes: 'pause on chest', applyToTemplate: true }] },
      0,
    )

    // The debounce must not fire a second, duplicate write for the same note.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(api.editExercises).toHaveBeenCalledTimes(1)
  })

  it('commits a pending note before finishing so the session seals with it', async () => {
    const { result, api } = await mounted(mkWorkout([mkExercise({ workoutExerciseId: 'we1' })]))
    vi.mocked(api.finish).mockResolvedValue({} as Awaited<ReturnType<typeof api.finish>>)

    await act(async () => {
      result.current.updateExerciseNotes('we1', 'felt heavy')
    })
    await act(async () => {
      await result.current.finish()
    })

    expect(api.editExercises).toHaveBeenCalledWith(
      'w1',
      { notes: [{ workoutExerciseId: 'we1', notes: 'felt heavy' }] },
      0,
    )
    expect(vi.mocked(api.editExercises).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(api.finish).mock.invocationCallOrder[0]!,
    )
  })
})

describe('ActiveWorkoutStore agent-collaboration revisions', () => {
  it('live-refreshes from the start surface after an agent starts a workout', async () => {
    const started = mkWorkout([mkExercise({ sets: [mkSet({ clientSetId: 's1' })] })])
    const api = apiFor(started)
    vi.mocked(api.getActive).mockResolvedValueOnce({ active: null }).mockResolvedValue(started)
    const { result } = renderHook(() => useActiveWorkoutStore(), { wrapper: wrapperFor(api) })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.workout).toBeNull()
    act(() => invalidateResources(['gym']))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.getActive).toHaveBeenCalledTimes(2)
    expect(result.current.workout).toMatchObject({ id: 'w1', status: 'active' })
  })

  it('live-refreshes the open logger after an executed agent gym edit', async () => {
    const initial = mkWorkout([
      mkExercise({ sets: [mkSet({ clientSetId: 's1' })], restSeconds: 120 }),
    ])
    const edited: ActiveWorkout = {
      ...initial,
      revision: 1,
      name: 'Upper Day',
      exercises: initial.exercises.map((exercise) => ({ ...exercise, restSeconds: 180 })),
    }
    const api = apiFor(initial)
    vi.mocked(api.getActive).mockResolvedValueOnce(initial).mockResolvedValue(edited)
    const { result } = renderHook(() => useActiveWorkoutStore(), { wrapper: wrapperFor(api) })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      invalidateResources(['gym'])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.getActive).toHaveBeenCalledTimes(2)
    expect(result.current.workout).toMatchObject({ revision: 1, name: 'Upper Day' })
    expect(result.current.workout!.exercises[0]!.restSeconds).toBe(180)
  })

  it('ignores an older live-refresh response that arrives after a newer one', async () => {
    const initial = mkWorkout([mkExercise({ sets: [mkSet({ clientSetId: 's1' })] })])
    let resolveOld!: (workout: ActiveWorkout) => void
    let resolveNew!: (workout: ActiveWorkout) => void
    const oldRequest = new Promise<ActiveWorkout>((resolve) => { resolveOld = resolve })
    const newRequest = new Promise<ActiveWorkout>((resolve) => { resolveNew = resolve })
    const api = apiFor(initial)
    vi.mocked(api.getActive)
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(oldRequest)
      .mockReturnValueOnce(newRequest)
    const { result } = renderHook(() => useActiveWorkoutStore(), { wrapper: wrapperFor(api) })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => invalidateResources(['gym']))
    await act(async () => Promise.resolve())
    act(() => invalidateResources(['gym']))
    await act(async () => Promise.resolve())

    await act(async () => {
      resolveNew({ ...initial, revision: 2, name: 'Newest' })
      await Promise.resolve()
    })
    await act(async () => {
      resolveOld({ ...initial, revision: 1, name: 'Older' })
      await Promise.resolve()
    })

    expect(result.current.workout).toMatchObject({ revision: 2, name: 'Newest' })
  })

  it('rebases an unsaved logger value over the agent\'s winning revision and retries safely', async () => {
    const initial = mkWorkout([
      mkExercise({ sets: [mkSet({ clientSetId: 's1', weight: null })], restSeconds: 120 }),
    ])
    const agentEdit: ActiveWorkout = {
      ...initial,
      revision: 1,
      name: 'Agent-adjusted Push',
      exercises: initial.exercises.map((exercise) => ({
        ...exercise,
        restSeconds: 180,
        sets: exercise.sets.map((set) => ({ ...set, setType: 'drop', restSeconds: 240 })),
      })),
    }
    const savedSet = mkSet({ clientSetId: 's1', weight: 205, setType: 'drop', restSeconds: 240 })
    const api = apiFor(initial)
    vi.mocked(api.getActive).mockResolvedValueOnce(initial).mockResolvedValue(agentEdit)
    vi.mocked(api.putSets)
      .mockRejectedValueOnce(new StaleWorkoutRevisionError())
      .mockResolvedValueOnce({ byExercise: { we1: [savedSet] }, revision: 2 })
    const { result } = renderHook(() => useActiveWorkoutStore(), { wrapper: wrapperFor(api) })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => result.current.updateSetField('s1', 'weight', 205))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
      await Promise.resolve()
    })

    expect(vi.mocked(api.putSets).mock.calls.map(([, body]) => body.expectedRevision)).toEqual([0, 1])
    expect(vi.mocked(api.putSets).mock.calls[1]![1].sets[0]).toMatchObject({
      weight: 205,
      setType: 'drop',
      restSeconds: 240,
    })
    expect(result.current.workout).toMatchObject({ revision: 2, name: 'Agent-adjusted Push' })
    expect(result.current.workout!.exercises[0]).toMatchObject({ restSeconds: 180 })
    expect(result.current.workout!.exercises[0]!.sets[0]!.weight).toBe(205)
    expect(result.current.workout!.exercises[0]!.sets[0]).toMatchObject({
      setType: 'drop',
      restSeconds: 240,
    })
  })

  it('never attaches queued rows to a replacement movement that reused the structural id', async () => {
    const initial = mkWorkout([
      mkExercise({ exerciseId: 'bench', sets: [mkSet({ clientSetId: 'bench-s1' })] }),
    ])
    const replacement: ActiveWorkout = {
      ...initial,
      revision: 1,
      exercises: [
        mkExercise({
          exerciseId: 'row',
          name: 'Cable Row',
          sets: [mkSet({ clientSetId: 'row-s1', weight: 80 })],
        }),
      ],
    }
    const api = apiFor(initial)
    vi.mocked(api.getActive).mockResolvedValueOnce(initial).mockResolvedValue(replacement)
    vi.mocked(api.putSets).mockRejectedValueOnce(new StaleWorkoutRevisionError())
    const { result } = renderHook(() => useActiveWorkoutStore(), { wrapper: wrapperFor(api) })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => result.current.updateSetField('bench-s1', 'weight', 205))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
      await Promise.resolve()
    })

    expect(api.putSets).toHaveBeenCalledTimes(1)
    expect(result.current.workout!.exercises[0]).toMatchObject({ exerciseId: 'row' })
    expect(result.current.workout!.exercises[0]!.sets.map((set) => set.clientSetId)).toEqual(['row-s1'])
  })

  it('refuses to finish or clear the mirror while a set write is unsaved', async () => {
    const initial = mkWorkout([
      mkExercise({ sets: [mkSet({ clientSetId: 's1', weight: 100 })] }),
    ])
    const api = apiFor(initial)
    vi.mocked(api.putSets).mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => useActiveWorkoutStore(), { wrapper: wrapperFor(api) })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => result.current.updateSetField('s1', 'weight', 105))

    await expect(act(async () => result.current.finish())).rejects.toThrow('saved locally')

    expect(api.finish).not.toHaveBeenCalled()
    expect(result.current.workout?.id).toBe('w1')
    expect(globalThis.localStorage?.getItem(QUEUE_MIRROR_KEY)).toBeTruthy()
  })
})

// ── P2b: rest timer + display unit (B2) ───────────────────────────────────────

describe('ActiveWorkoutStore rest timer (P2b)', () => {
  it('completing a WORKING set auto-starts a rest countdown for that exercise', async () => {
    const ex = mkExercise({ restSeconds: 90, sets: [mkSet({ clientSetId: 's1', weight: 100, reps: 8 })] })
    const { result } = await mounted(mkWorkout([ex]))
    expect(result.current.restTimer).toBeNull()
    await act(async () => {
      result.current.completeSet('we1', 's1')
    })
    expect(result.current.restTimer).not.toBeNull()
    expect(result.current.restTimer!.exerciseId).toBe('ex1')
    expect(result.current.restTimer!.totalMs).toBe(90_000)
  })

  it('startRest / adjustRest / skipRest manage the timer', async () => {
    const ex = mkExercise({ sets: [mkSet({ clientSetId: 's1' })] })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => result.current.startRest('ex1', 60))
    const endsAt0 = result.current.restTimer!.endsAt
    await act(async () => result.current.adjustRest(30))
    expect(result.current.restTimer!.endsAt).toBe(endsAt0 + 30_000)
    await act(async () => result.current.skipRest())
    expect(result.current.restTimer).toBeNull()
  })

  it('an exact set rest override wins when the set is completed', async () => {
    const ex = mkExercise({
      restSeconds: 120,
      sets: [mkSet({ clientSetId: 's1', weight: 100, reps: 8, restSeconds: 90 })],
    })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => result.current.completeSet('we1', 's1'))
    expect(result.current.restTimer!.totalMs).toBe(90_000)
  })

  it('starts Split rest only after the second side completes', async () => {
    const logicalSetId = crypto.randomUUID()
    const ex = mkExercise({
      loadBasis: 'per_side',
      restSeconds: 90,
      sets: [
        mkSet({ clientSetId: 'left', logicalSetId, setNumber: 1, side: 'left', weight: 40, reps: 10 }),
        mkSet({ clientSetId: 'right', logicalSetId, setNumber: 2, side: 'right', weight: 40, reps: 10 }),
      ],
    })
    const { result } = await mounted(mkWorkout([ex]))

    await act(async () => {
      result.current.completeSet('we1', 'left')
      await Promise.resolve()
    })
    expect(result.current.restTimer).toBeNull()

    await act(async () => {
      result.current.completeSet('we1', 'right')
      await Promise.resolve()
    })
    expect(result.current.restTimer?.totalMs).toBe(90_000)
  })

  it('updateSetRest can override and then return a set to inherited rest', async () => {
    const ex = mkExercise({ restSeconds: 120, sets: [mkSet({ clientSetId: 's1', restSeconds: null })] })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => result.current.updateSetRest('s1', 75))
    expect(result.current.workout!.exercises[0]!.sets[0]!.restSeconds).toBe(75)
    await act(async () => result.current.updateSetRest('s1', null))
    expect(result.current.workout!.exercises[0]!.sets[0]!.restSeconds).toBeNull()
  })
})

describe('ActiveWorkoutStore display unit (P2b) — stored-as-entered invariant', () => {
  it('seeds the session display from the app-wide unit', async () => {
    const workout = { ...mkWorkout([mkExercise()]), weightUnit: 'kg' as const }
    const { result } = await mounted(workout)

    expect(result.current.displayUnit).toBe('kg')
  })

  it('setDisplayUnit toggling NEVER mutates stored set values or units', async () => {
    const ex = mkExercise({
      sets: [mkSet({ clientSetId: 's1', weight: 185, weightUnit: 'lb', reps: 8, completed: true })],
    })
    const { result } = await mounted(mkWorkout([ex]))
    const before = result.current.workout!.exercises[0]!.sets[0]!

    await act(async () => result.current.setDisplayUnit('kg'))
    const afterKg = result.current.workout!.exercises[0]!.sets[0]!
    expect(afterKg.weight).toBe(185) // value untouched
    expect(afterKg.weightUnit).toBe('lb') // unit untouched
    expect(result.current.displayUnit).toBe('kg') // only the display override changed

    await act(async () => result.current.setDisplayUnit('lb'))
    const afterBack = result.current.workout!.exercises[0]!.sets[0]!
    expect(afterBack.weight).toBe(before.weight)
    expect(afterBack.weightUnit).toBe(before.weightUnit)
  })

  it('setSetWeightUnit records the entered unit for that row only', async () => {
    const ex = mkExercise({
      sets: [
        mkSet({ clientSetId: 's1', weight: 100, weightUnit: 'lb' }),
        mkSet({ clientSetId: 's2', weight: 100, weightUnit: 'lb' }),
      ],
    })
    const { result } = await mounted(mkWorkout([ex]))
    await act(async () => result.current.setSetWeightUnit('s1', 'kg'))
    const sets = result.current.workout!.exercises[0]!.sets
    expect(sets[0]!.weightUnit).toBe('kg') // entered-in-kg row
    expect(sets[0]!.weight).toBe(100) // value NOT converted (stored as entered)
    expect(sets[1]!.weightUnit).toBe('lb') // sibling row untouched
  })
})
