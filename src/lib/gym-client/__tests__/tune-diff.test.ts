import { describe, it, expect } from 'vitest'

import {
  computeTuneDiff,
  tuneDiffHasChanges,
  type CurrentExercise,
} from '../tune-diff'
import type { ProposalPayload, ProposalExercise } from '@/lib/gym/plan'

function pex(over: Partial<ProposalExercise> & { exerciseId: string; name: string }): ProposalExercise {
  return {
    sets: 3,
    reps: 8,
    targetWeight: null,
    supersetGroup: null,
    restSeconds: null,
    why: '',
    region: null,
    ...over,
  }
}

function payload(exercises: ProposalExercise[]): ProposalPayload {
  return { name: 'Test', exercises }
}

function cur(over: Partial<CurrentExercise> & { exerciseId: string }): CurrentExercise {
  return { workoutExerciseId: `we-${over.exerciseId}`, name: over.exerciseId, ...over }
}

describe('computeTuneDiff', () => {
  it('classifies kept / added / removed by exerciseId', () => {
    const proposal = payload([
      pex({ exerciseId: 'a', name: 'Bench Press' }), // kept
      pex({ exerciseId: 'c', name: 'Incline DB Press', why: 'staler variety' }), // added
    ])
    const current = [
      cur({ exerciseId: 'a', name: 'Bench Press' }), // kept
      cur({ exerciseId: 'b', name: 'Flat Fly' }), // removed (not in proposal)
    ]

    const diff = computeTuneDiff(proposal, current)

    expect(diff.kept.map((r) => r.exerciseId)).toEqual(['a'])
    expect(diff.added.map((r) => r.exerciseId)).toEqual(['c'])
    expect(diff.added[0]!.why).toBe('staler variety')
    expect(diff.removed.map((r) => r.exerciseId)).toEqual(['b'])
    // Removed rows carry the workoutExerciseId so the store can remove the slot.
    expect(diff.removed[0]!.workoutExerciseId).toBe('we-b')
  })

  it('a template-swap (A→B) reads as {removed: A, added: B}', () => {
    const proposal = payload([pex({ exerciseId: 'B', name: 'Cable Row' })])
    const current = [cur({ exerciseId: 'A', name: 'Barbell Row' })]

    const diff = computeTuneDiff(proposal, current)

    expect(diff.added.map((r) => r.exerciseId)).toEqual(['B'])
    expect(diff.removed.map((r) => r.exerciseId)).toEqual(['A'])
    expect(diff.kept).toHaveLength(0)
    expect(tuneDiffHasChanges(diff)).toBe(true)
  })

  it('identical proposal ⇒ all kept, no changes', () => {
    const proposal = payload([
      pex({ exerciseId: 'a', name: 'Squat' }),
      pex({ exerciseId: 'b', name: 'RDL' }),
    ])
    const current = [cur({ exerciseId: 'a' }), cur({ exerciseId: 'b' })]

    const diff = computeTuneDiff(proposal, current)

    expect(diff.kept).toHaveLength(2)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(tuneDiffHasChanges(diff)).toBe(false)
  })

  it('dedupes a proposal that lists the same exerciseId twice', () => {
    const proposal = payload([
      pex({ exerciseId: 'x', name: 'Curl' }),
      pex({ exerciseId: 'x', name: 'Curl (dupe)' }),
    ])
    const diff = computeTuneDiff(proposal, [])
    expect(diff.added.map((r) => r.exerciseId)).toEqual(['x'])
  })

  it('empty proposal removes everything currently in the workout', () => {
    const diff = computeTuneDiff(payload([]), [cur({ exerciseId: 'a' }), cur({ exerciseId: 'b' })])
    expect(diff.removed.map((r) => r.exerciseId)).toEqual(['a', 'b'])
    expect(diff.added).toHaveLength(0)
    expect(tuneDiffHasChanges(diff)).toBe(true)
  })
})
