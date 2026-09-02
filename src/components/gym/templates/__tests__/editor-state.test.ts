/**
 * Template builder editor-state helpers (pure). Covers the load-bearing list
 * mutations: reorder (moveRow), superset grouping (toggle merges adjacent rows into
 * an opaque group id, split ungroups + collapses a singleton), the derived A1/B1
 * labels (NEVER stored — GYM_PLAN §3), and the draft→payload mapping (dense
 * positions).
 */
import { describe, expect, it } from 'vitest'

import {
  draftToPayload,
  moveRow,
  nextGroupId,
  patchDraftExercise,
  setSupersetMembers,
  supersetLabels,
  toDraft,
  toggleSupersetWithNext,
  type DraftExercise,
} from '../editor-state'

const draft = (o: Partial<DraftExercise>): DraftExercise => ({
  key: o.key ?? Math.random().toString(),
  exerciseId: 'e',
  name: 'Ex',
  tracks: 'weight_reps',
  preferredUnit: 'lb',
  targetSets: 3,
  targetReps: 10,
  targetWeight: null,
  targetWeightUnit: 'lb',
  targetDurationS: null,
  restSeconds: null,
  restSecondsWarmup: null,
  supersetGroup: null,
  section: 'main',
  sets: Array.from({ length: o.targetSets ?? 3 }, (_, index) => ({
    setNumber: index + 1,
    setType: 'normal' as const,
    targetWeight: o.targetWeight ?? null,
    targetWeightUnit: o.targetWeightUnit ?? 'lb',
    targetReps: o.targetReps ?? 10,
    targetDistanceM: null,
    targetDurationS: o.targetDurationS ?? null,
    targetRpe: null,
    restSeconds: null,
    side: null,
  })),
  progression: null,
  notes: null,
  ...o,
})

const rows = (...ids: string[]) => ids.map((id) => draft({ key: id, exerciseId: id }))

describe('moveRow', () => {
  it('moves a row down and returns a new array', () => {
    const r = rows('a', 'b', 'c')
    const out = moveRow(r, 0, 2)
    expect(out.map((x) => x.key)).toEqual(['b', 'c', 'a'])
    expect(out).not.toBe(r)
  })
  it('moves a row up', () => {
    expect(moveRow(rows('a', 'b', 'c'), 2, 0).map((x) => x.key)).toEqual(['c', 'a', 'b'])
  })
  it('clamps out-of-range targets and no-ops equal from/to', () => {
    expect(moveRow(rows('a', 'b'), 0, 9).map((x) => x.key)).toEqual(['b', 'a'])
    expect(moveRow(rows('a', 'b'), 1, 1).map((x) => x.key)).toEqual(['a', 'b'])
  })
})

describe('nextGroupId', () => {
  it('is max existing + 1 (or 1 when none)', () => {
    expect(nextGroupId(rows('a', 'b'))).toBe(1)
    expect(nextGroupId([draft({ supersetGroup: 3 }), draft({ supersetGroup: 1 })])).toBe(4)
  })
})

describe('toggleSupersetWithNext', () => {
  it('merges two ungrouped adjacent rows into a NEW group id', () => {
    const out = toggleSupersetWithNext(rows('a', 'b', 'c'), 0)
    expect(out[0]!.supersetGroup).toBe(1)
    expect(out[1]!.supersetGroup).toBe(1)
    expect(out[2]!.supersetGroup).toBeNull()
  })

  it('extends an existing group when the upper row is already grouped', () => {
    const start = [draft({ key: 'a', supersetGroup: 5 }), draft({ key: 'b', supersetGroup: 5 }), draft({ key: 'c' })]
    const out = toggleSupersetWithNext(start, 1) // group b with c → both join group 5
    expect(out[1]!.supersetGroup).toBe(5)
    expect(out[2]!.supersetGroup).toBe(5)
  })

  it('splits a linked pair, and collapses a resulting singleton group', () => {
    // a,b share group 1 (a 2-circuit). Toggling splits b out; a is then a singleton
    // in group 1, so a is cleared too.
    const start = [draft({ key: 'a', supersetGroup: 1 }), draft({ key: 'b', supersetGroup: 1 })]
    const out = toggleSupersetWithNext(start, 0)
    expect(out[0]!.supersetGroup).toBeNull()
    expect(out[1]!.supersetGroup).toBeNull()
  })

  it('splitting a 3-circuit keeps the remaining pair grouped', () => {
    const start = [
      draft({ key: 'a', supersetGroup: 1 }),
      draft({ key: 'b', supersetGroup: 1 }),
      draft({ key: 'c', supersetGroup: 1 }),
    ]
    const out = toggleSupersetWithNext(start, 1) // split c out of the circuit
    expect(out[0]!.supersetGroup).toBe(1)
    expect(out[1]!.supersetGroup).toBe(1)
    expect(out[2]!.supersetGroup).toBeNull()
  })

  it('is a no-op on the last row (no next to group with)', () => {
    const start = rows('a', 'b')
    expect(toggleSupersetWithNext(start, 1)).toBe(start)
  })
})

describe('setSupersetMembers', () => {
  it('builds a superset from non-adjacent template exercises', () => {
    const out = setSupersetMembers(rows('a', 'b', 'c'), 'a', ['a', 'c'])
    expect(out.map((row) => row.supersetGroup)).toEqual([1, null, 1])
  })

  it('edits a circuit and clears a singleton left in another group', () => {
    const start = [
      draft({ key: 'a', supersetGroup: 4 }),
      draft({ key: 'b', supersetGroup: 4 }),
      draft({ key: 'c', supersetGroup: 9 }),
      draft({ key: 'd', supersetGroup: 9 }),
    ]
    const out = setSupersetMembers(start, 'a', ['a', 'c', 'd'])
    expect(out.map((row) => row.supersetGroup)).toEqual([4, null, 4, 4])
  })
})

describe('supersetLabels', () => {
  it('derives A1/A2/B1 labels by group, in row order; ungrouped → null', () => {
    const start = [
      draft({ key: 'a', supersetGroup: 1 }),
      draft({ key: 'b', supersetGroup: 1 }),
      draft({ key: 'c' }),
      draft({ key: 'd', supersetGroup: 2 }),
      draft({ key: 'e', supersetGroup: 2 }),
    ]
    expect(supersetLabels(start)).toEqual(['A1', 'A2', null, 'B1', 'B2'])
  })

  it('assigns letters by first-encountered group order (not by id value)', () => {
    const start = [
      draft({ key: 'a', supersetGroup: 7 }),
      draft({ key: 'b', supersetGroup: 3 }),
      draft({ key: 'c', supersetGroup: 7 }),
    ]
    // group 7 is encountered first → A; group 3 → B.
    expect(supersetLabels(start)).toEqual(['A1', 'B1', 'A2'])
  })
})

describe('draftToPayload', () => {
  it('maps rows to the payload with dense positions', () => {
    const start = [
      draft({ key: 'a', exerciseId: 'a', targetSets: 4, targetReps: 6, supersetGroup: 1 }),
      draft({ key: 'b', exerciseId: 'b', targetWeight: 61.2, targetWeightUnit: 'kg', progression: { type: 'linear', increment: 5 } }),
    ]
    const payload = draftToPayload(start)
    expect(payload.map((p) => p.position)).toEqual([0, 1])
    expect(payload[0]).toMatchObject({ exerciseId: 'a', targetSets: 4, targetReps: 6, supersetGroup: 1 })
    expect(payload[1]).toMatchObject({
      exerciseId: 'b',
      targetWeight: 61.2,
      targetWeightUnit: 'kg',
      progression: { type: 'linear', increment: 5 },
    })
  })

  it('round-trips heterogeneous exact sets without flattening them', () => {
    const exact = [
      {
        setNumber: 1, setType: 'warmup' as const, targetWeight: 20,
        targetWeightUnit: 'kg' as const, targetReps: 12, targetDistanceM: null,
        targetDurationS: null, targetRpe: 5, restSeconds: 45, side: null,
      },
      {
        setNumber: 2, setType: 'normal' as const, targetWeight: 40,
        targetWeightUnit: 'kg' as const, targetReps: 10, targetDistanceM: null,
        targetDurationS: null, targetRpe: 8, restSeconds: 90, side: 'left' as const,
      },
      {
        setNumber: 3, setType: 'drop' as const, targetWeight: 30,
        targetWeightUnit: 'kg' as const, targetReps: 14, targetDistanceM: null,
        targetDurationS: null, targetRpe: 9, restSeconds: 30, side: 'right' as const,
      },
    ]
    const hydrated = toDraft({
      exerciseId: 'e1', name: 'Curl', tracks: 'weight_reps', preferredUnit: 'kg',
      position: 0, targetSets: 2, targetReps: 10, targetWeight: 40,
      targetWeightUnit: 'kg', targetDurationS: null, restSeconds: 120,
      restSecondsWarmup: 45, supersetGroup: null, section: 'main', sets: exact,
      progression: null, notes: 'Slow eccentric',
    })

    const [payload] = draftToPayload([hydrated])
    expect(payload?.sets).toEqual(exact)
    expect(payload).toMatchObject({ restSecondsWarmup: 45, section: 'main' })
    expect(payload?.sets).not.toBe(hydrated.sets)
  })
})

describe('patchDraftExercise', () => {
  const heterogeneous = () => draft({
    targetSets: 2,
    targetReps: 10,
    targetWeight: 40,
    targetWeightUnit: 'kg',
    sets: [
      {
        setNumber: 1, setType: 'warmup', targetWeight: 20, targetWeightUnit: 'kg',
        targetReps: 12, targetDistanceM: null, targetDurationS: null, targetRpe: 5,
        restSeconds: 45, side: null,
      },
      {
        setNumber: 2, setType: 'normal', targetWeight: 40, targetWeightUnit: 'kg',
        targetReps: 10, targetDistanceM: null, targetDurationS: null, targetRpe: 8,
        restSeconds: 90, side: 'left',
      },
      {
        setNumber: 3, setType: 'drop', targetWeight: 30, targetWeightUnit: 'kg',
        targetReps: 14, targetDistanceM: null, targetDurationS: null, targetRpe: 9,
        restSeconds: 30, side: 'right',
      },
    ],
  })

  it('applies scalar target changes to working sets but preserves warmup ramps and per-set metadata', () => {
    const before = heterogeneous()
    const after = patchDraftExercise(before, { targetReps: 8, targetWeight: 45 })

    expect(after.sets[0]).toEqual(before.sets[0])
    expect(after.sets.slice(1).map((set) => [set.targetReps, set.targetWeight])).toEqual([
      [8, 45], [8, 45],
    ])
    expect(after.sets.slice(1).map((set) => [set.setType, set.targetRpe, set.restSeconds, set.side])).toEqual([
      ['normal', 8, 90, 'left'], ['drop', 9, 30, 'right'],
    ])
  })

  it('resizes only working rows, keeps warmups, and appends a deliberate normal prescription', () => {
    const grown = patchDraftExercise(heterogeneous(), { targetSets: 3 })
    expect(grown.sets.map((set) => set.setType)).toEqual(['warmup', 'normal', 'drop', 'normal'])
    expect(grown.sets.map((set) => set.setNumber)).toEqual([1, 2, 3, 4])
    expect(grown.sets[3]).toMatchObject({
      targetWeight: 40,
      targetWeightUnit: 'kg',
      targetReps: 10,
      targetRpe: 9,
      restSeconds: 30,
      side: 'right',
    })

    const shrunk = patchDraftExercise(grown, { targetSets: 1 })
    expect(shrunk.sets.map((set) => set.setType)).toEqual(['warmup', 'normal'])
    expect(shrunk.sets.map((set) => set.setNumber)).toEqual([1, 2])
  })

  it('leaves exact per-set rest overrides untouched when the exercise fallback changes', () => {
    const after = patchDraftExercise(heterogeneous(), { restSeconds: 180 })
    expect(after.restSeconds).toBe(180)
    expect(after.sets.map((set) => set.restSeconds)).toEqual([45, 90, 30])
  })
})
