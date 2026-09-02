/**
 * Template patch edits (#1830).
 *
 * replace-all made a two-field edit cost a ~2KB resend of ten exercises — and
 * anything the client failed to echo back was silently deleted. These pin the
 * property that makes a patch worth having: what you did not name does not move.
 */
import { describe, expect, it } from 'vitest'

import { applyTemplatePatch, type TemplatePatchOp } from '../template-patch'
import type { EditorExercise } from '../templates-read'

function ex(name: string, over: Partial<EditorExercise> = {}): EditorExercise {
  return {
    exerciseId: `id-${name}`,
    name,
    tracks: 'weight_reps',
    preferredUnit: 'lb',
    position: 0,
    targetSets: 3,
    targetReps: 10,
    targetWeight: 100,
    targetWeightUnit: 'lb',
    targetDurationS: null,
    restSeconds: 90,
    restSecondsWarmup: null,
    supersetGroup: null,
    section: 'main',
    progression: null,
    notes: 'keep me',
    sets: [
      { setNumber: 1, setType: 'warmup', targetWeight: 45, targetWeightUnit: 'lb', targetReps: 10, targetDistanceM: null, targetDurationS: null, targetRpe: null, restSeconds: 45, side: null },
      { setNumber: 2, setType: 'normal', targetWeight: 100, targetWeightUnit: 'lb', targetReps: 10, targetDistanceM: null, targetDurationS: null, targetRpe: null, restSeconds: 90, side: null },
      { setNumber: 3, setType: 'normal', targetWeight: 100, targetWeightUnit: 'lb', targetReps: 10, targetDistanceM: null, targetDurationS: null, targetRpe: null, restSeconds: 90, side: null },
    ],
    ...over,
  } as EditorExercise
}

// Real templates carry distinct positions; the fixture must too, or the dense
// repositioning at the end of a patch looks like a spurious diff.
const template = () => [
  ex('Hack Squat', { position: 0 }),
  ex('Romanian Deadlift (Barbell)', { position: 1 }),
  ex('Kegels', { position: 2 }),
]

describe('what you did not name does not move', () => {
  it('leaves every untouched exercise byte-identical', () => {
    const before = template()
    const res = applyTemplatePatch(before, [
      { op: 'set_rest', exercise: 'Hack Squat', restSeconds: 150 },
    ])
    expect(res.ok).toBe(true)
    // The two it never mentioned come back exactly as they went in — notes,
    // per-set RPE and all, which replace-all could silently drop.
    expect(res.exercises[1]).toEqual(before[1])
    expect(res.exercises[2]).toEqual(before[2])
  })

  it('does not mutate the input', () => {
    const before = template()
    applyTemplatePatch(before, [{ op: 'set_rest', exercise: 'Hack Squat', restSeconds: 150 }])
    expect(before[0]!.restSeconds).toBe(90)
  })
})

describe('set_rest', () => {
  // Rest lives on the exercise AND on each working set; a template whose two
  // disagree renders one number and programs the other.
  it('writes both the exercise-level and the working-set rest', () => {
    const res = applyTemplatePatch(template(), [
      { op: 'set_rest', exercise: 'Hack Squat', restSeconds: 150 },
    ])
    const target = res.exercises[0]!
    expect(target.restSeconds).toBe(150)
    expect(target.sets.filter((s) => s.setType !== 'warmup').every((s) => s.restSeconds === 150)).toBe(true)
  })

  it('leaves warmup rest alone', () => {
    const res = applyTemplatePatch(template(), [
      { op: 'set_rest', exercise: 'Hack Squat', restSeconds: 150 },
    ])
    expect(res.exercises[0]!.sets[0]!.restSeconds).toBe(45)
  })
})

describe('set_scheme', () => {
  it('grows the working sets by copying the last one rather than inventing a prescription', () => {
    const res = applyTemplatePatch(template(), [
      { op: 'set_scheme', exercise: 'Hack Squat', sets: 4, reps: 8 },
    ])
    const working = res.exercises[0]!.sets.filter((s) => s.setType !== 'warmup')
    expect(working).toHaveLength(4)
    expect(working.every((s) => s.targetReps === 8)).toBe(true)
    expect(working[3]!.targetWeight).toBe(100)
  })

  it('renumbers densely across warmups and working sets', () => {
    const res = applyTemplatePatch(template(), [
      { op: 'set_scheme', exercise: 'Hack Squat', sets: 2, reps: 12 },
    ])
    expect(res.exercises[0]!.sets.map((s) => s.setNumber)).toEqual([1, 2, 3])
  })
})

describe('supersets and removal', () => {
  it('groups the three core exercises in one call', () => {
    const ops: TemplatePatchOp[] = [
      { op: 'set_superset', exercise: 'Hack Squat', group: 1 },
      { op: 'set_superset', exercise: 'Kegels', group: 1 },
    ]
    const res = applyTemplatePatch(template(), ops)
    expect(res.exercises[0]!.supersetGroup).toBe(1)
    expect(res.exercises[2]!.supersetGroup).toBe(1)
    expect(res.exercises[1]!.supersetGroup).toBeNull()
  })

  it('keeps positions dense after a removal', () => {
    const res = applyTemplatePatch(template(), [
      { op: 'remove_exercise', exercise: 'Romanian Deadlift (Barbell)' },
    ])
    expect(res.exercises.map((e) => e.name)).toEqual(['Hack Squat', 'Kegels'])
    expect(res.exercises.map((e) => e.position)).toEqual([0, 1])
  })
})

describe('failure is loud', () => {
  // A silent no-op here looks exactly like a successful edit — which is the
  // failure mode this whole feature exists to remove.
  it('rejects an unknown exercise and names what is actually there', () => {
    const res = applyTemplatePatch(template(), [
      { op: 'set_rest', exercise: 'Bench Press', restSeconds: 150 },
    ])
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Hack Squat')
  })

  it('applies nothing at all when one op in the batch fails', () => {
    const before = template()
    const res = applyTemplatePatch(before, [
      { op: 'set_rest', exercise: 'Hack Squat', restSeconds: 150 },
      { op: 'set_rest', exercise: 'Nope', restSeconds: 150 },
    ])
    expect(res.ok).toBe(false)
    expect(res.exercises).toEqual(before)
  })

  it('rejects an empty operation list', () => {
    expect(applyTemplatePatch(template(), []).ok).toBe(false)
  })
})
