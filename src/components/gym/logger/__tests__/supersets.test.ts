/**
 * Superset derivation (GYM_PLAN §4 supersets, §3 semantics). Pure: labels + colours
 * + rotation derived from (group, position); the delete-middle case must preserve
 * grouping (the plan's named unit test).
 */
import { describe, it, expect } from 'vitest'

import {
  supersetMap,
  supersetWithNext,
  nextSupersetGroupId,
  SUPERSET_HUES,
} from '../supersets'
import type { ActiveExercise, ActiveWorkout } from '@/lib/gym-client/active-types'
import { EMPTY_GRIP } from '@/lib/gym/grip'

function ex(over: Partial<ActiveExercise> & { workoutExerciseId: string; position: number }): ActiveExercise {
  return {
    grip: EMPTY_GRIP,
    exerciseId: `e-${over.workoutExerciseId}`,
    name: over.workoutExerciseId,
    tracks: 'weight_reps',
    modality: 'strength',
    perSide: false,
    section: 'main',
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

function wk(exercises: ActiveExercise[]): ActiveWorkout {
  return {
    id: 'w1',
    revision: 0,
    name: 'x',
    status: 'active',
    startedAt: new Date().toISOString(),
    templateId: null,
    templateName: null,
    exercises,
  }
}

describe('supersetMap — labels + rotation', () => {
  it('groups get A1/A2, B1/B2 by first appearance; solos are null', () => {
    const w = wk([
      ex({ workoutExerciseId: 'we1', position: 0, supersetGroup: 7 }),
      ex({ workoutExerciseId: 'we2', position: 1, supersetGroup: 7 }),
      ex({ workoutExerciseId: 'we3', position: 2, supersetGroup: null }), // solo
      ex({ workoutExerciseId: 'we4', position: 3, supersetGroup: 9 }),
      ex({ workoutExerciseId: 'we5', position: 4, supersetGroup: 9 }),
    ])
    const m = supersetMap(w)
    expect(m.get('we1')!.label).toBe('A1')
    expect(m.get('we2')!.label).toBe('A2')
    expect(m.get('we3')!.label).toBeNull()
    expect(m.get('we4')!.label).toBe('B1')
    expect(m.get('we5')!.label).toBe('B2')
  })

  it('rotation next: A1 → A2 → A1 (wraps); solo group has no next', () => {
    const w = wk([
      ex({ workoutExerciseId: 'we1', position: 0, supersetGroup: 7 }),
      ex({ workoutExerciseId: 'we2', position: 1, supersetGroup: 7 }),
      ex({ workoutExerciseId: 'we3', position: 2, supersetGroup: 5 }), // lone member
    ])
    const m = supersetMap(w)
    expect(m.get('we1')!.nextExerciseId).toBe('we2')
    expect(m.get('we2')!.nextExerciseId).toBe('we1') // wraps
    expect(m.get('we3')!.nextExerciseId).toBeNull() // solo group
  })

  it('colours are stable per group and rotate by group order', () => {
    const w = wk([
      ex({ workoutExerciseId: 'we1', position: 0, supersetGroup: 7 }),
      ex({ workoutExerciseId: 'we2', position: 1, supersetGroup: 9 }),
    ])
    const m = supersetMap(w)
    expect(m.get('we1')!.color).toBe(SUPERSET_HUES[0])
    expect(m.get('we2')!.color).toBe(SUPERSET_HUES[1])
  })

  it('DELETE-MIDDLE preserves grouping (a 3-circuit → 2 keeps A1/A2)', () => {
    // Group 7 had we1/we2/we3; the middle we2 was removed. we1 + we3 stay grouped.
    const w = wk([
      ex({ workoutExerciseId: 'we1', position: 0, supersetGroup: 7 }),
      ex({ workoutExerciseId: 'we3', position: 2, supersetGroup: 7 }),
    ])
    const m = supersetMap(w)
    expect(m.get('we1')!.group).toBe(7)
    expect(m.get('we3')!.group).toBe(7)
    expect(m.get('we1')!.label).toBe('A1')
    expect(m.get('we3')!.label).toBe('A2') // renumbered at RENDER (positions, not gaps)
    expect(m.get('we1')!.nextExerciseId).toBe('we3')
  })
})

describe('nextSupersetGroupId', () => {
  it('is max existing + 1 (never renumbers)', () => {
    const w = wk([
      ex({ workoutExerciseId: 'we1', position: 0, supersetGroup: 3 }),
      ex({ workoutExerciseId: 'we2', position: 1, supersetGroup: 8 }),
    ])
    expect(nextSupersetGroupId(w)).toBe(9)
  })
  it('starts at 1 for an ungrouped workout', () => {
    const w = wk([ex({ workoutExerciseId: 'we1', position: 0 })])
    expect(nextSupersetGroupId(w)).toBe(1)
  })
})

describe('supersetWithNext', () => {
  it('pairs an exercise with the one after it, minting a fresh group', () => {
    const w = wk([
      ex({ workoutExerciseId: 'we1', position: 0 }),
      ex({ workoutExerciseId: 'we2', position: 1 }),
    ])
    const r = supersetWithNext(w, 'we1')!
    expect(r.ids).toEqual(['we1', 'we2'])
    expect(r.group).toBe(1)
  })

  it('chains onto an existing group when the next is already grouped', () => {
    const w = wk([
      ex({ workoutExerciseId: 'we1', position: 0 }),
      ex({ workoutExerciseId: 'we2', position: 1, supersetGroup: 4 }),
      ex({ workoutExerciseId: 'we3', position: 2, supersetGroup: 4 }),
    ])
    const r = supersetWithNext(w, 'we1')!
    expect(r.group).toBe(4) // joins the existing B group
  })

  it('returns null on the last exercise (no next to group with)', () => {
    const w = wk([
      ex({ workoutExerciseId: 'we1', position: 0 }),
      ex({ workoutExerciseId: 'we2', position: 1 }),
    ])
    expect(supersetWithNext(w, 'we2')).toBeNull()
  })
})
