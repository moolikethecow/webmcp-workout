/**
 * agent-edit.ts — the two behaviours that make agent editing of a LIVE session
 * safe, plus the eligibility gate.
 *
 *  1. A stale `expected_revision` is refused before anything is written.
 *  2. A programming change leaves completed performance alone.
 *
 * The active-workout lib is mocked at the module boundary so these assert the
 * mapping (which sets get written, with what) rather than the SQL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActiveExercise, ActiveWorkout } from '../active-workout'

const mockGetActive = vi.hoisted(() => vi.fn())
const mockUpsertSets = vi.hoisted(() => vi.fn())
const mockEditExercises = vi.hoisted(() => vi.fn())
const mockListInjuries = vi.hoisted(() => vi.fn())
const mockExecute = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db/client', () => ({ db: { execute: mockExecute } }))
vi.mock('@/lib/gym/injuries-gyms', () => ({ listInjuries: mockListInjuries }))
vi.mock('@/lib/gym/active-workout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../active-workout')>()
  return {
    ...actual,
    getActiveWorkout: mockGetActive,
    upsertSets: mockUpsertSets,
    editExercises: mockEditExercises,
    upsertExerciseSetsIfUnchanged: vi.fn(),
    patchWorkoutMeta: vi.fn(),
    restoreTemplateWeights: vi.fn(),
  }
})

const { applyActiveEdit } = await import('../agent-edit')

/** One exercise: set 1 completed at 135×8, set 2 planned. */
function benchPress(): ActiveExercise {
  return {
    workoutExerciseId: 'we-1',
    exerciseId: 'ex-1',
    name: 'Bench Press',
    tracks: 'weight_reps',
    modality: 'strength',
    perSide: false,
    loadBasis: 'total',
    section: 'main',
    position: 1,
    supersetGroup: null,
    restSeconds: 120,
    preferredUnit: 'lb',
    notes: null,
    ruleText: '',
    previous: [],
    grip: {},
    targets: [
      { setNumber: 1, setType: 'normal', weight: 135, weightUnit: 'lb', reps: 8 },
      { setNumber: 2, setType: 'normal', weight: 135, weightUnit: 'lb', reps: 8 },
    ],
    sets: [
      {
        clientSetId: 'set-1',
        logicalSetId: 'log-1',
        setNumber: 1,
        setType: 'normal',
        weight: 135,
        weightUnit: 'lb',
        reps: 8,
        distanceM: null,
        durationS: null,
        rpe: null,
        side: null,
        completed: true,
      },
      {
        clientSetId: 'set-2',
        logicalSetId: 'log-2',
        setNumber: 2,
        setType: 'normal',
        weight: null,
        weightUnit: 'lb',
        reps: null,
        distanceM: null,
        durationS: null,
        rpe: null,
        side: null,
        completed: false,
      },
    ],
  } as unknown as ActiveExercise
}

function workout(revision = 7): ActiveWorkout {
  return {
    id: 'w-1',
    revision,
    name: 'Push A',
    status: 'active',
    startedAt: '2026-09-01T17:00:00Z',
    templateId: null,
    templateName: null,
    exercises: [benchPress()],
  } as unknown as ActiveWorkout
}

beforeEach(() => {
  mockGetActive.mockReset()
  mockUpsertSets.mockReset()
  mockEditExercises.mockReset()
  mockListInjuries.mockReset().mockResolvedValue([])
  mockExecute.mockReset().mockResolvedValue({ rows: [] })
})

describe('applyActiveEdit — revision safety', () => {
  it('refuses a stale expected_revision without writing anything', async () => {
    mockGetActive.mockResolvedValue(workout(7))

    const result = await applyActiveEdit({
      expected_revision: 6,
      ops: [{ op: 'set_weight', exercise_name: 'Bench Press', weight: 155 }],
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a rejection')
    expect(result.code).toBe('stale_revision')
    if (result.code !== 'stale_revision') throw new Error('expected stale_revision')
    expect(result.current_revision).toBe(7)
    expect(result.workout.id).toBe('w-1')
    expect(mockUpsertSets).not.toHaveBeenCalled()
    expect(mockEditExercises).not.toHaveBeenCalled()
  })

  it('reports no_active_workout instead of throwing when nothing is running', async () => {
    mockGetActive.mockResolvedValue(null)
    const result = await applyActiveEdit({ ops: [{ op: 'rename', workout_name: 'Push B' }] })
    expect(result).toEqual({ ok: false, code: 'no_active_workout' })
  })

  it('proceeds when expected_revision matches', async () => {
    mockGetActive.mockResolvedValue(workout(7))
    mockUpsertSets.mockResolvedValue({ byExercise: {}, revision: 8, newlyCompletedClientSetIds: [] })

    const result = await applyActiveEdit({
      expected_revision: 7,
      ops: [{ op: 'set_weight', exercise_name: 'Bench Press', weight: 155 }],
    })

    expect(result.ok).toBe(true)
    expect(mockUpsertSets).toHaveBeenCalledTimes(1)
    expect(mockUpsertSets.mock.calls[0]![2]).toBe(7) // expectedRevision forwarded
  })
})

describe('applyActiveEdit — completed sets are preserved', () => {
  it('writes only the incomplete working set, and only as a prescription', async () => {
    mockGetActive.mockResolvedValue(workout(7))
    mockUpsertSets.mockResolvedValue({ byExercise: {}, revision: 8, newlyCompletedClientSetIds: [] })

    const result = await applyActiveEdit({
      ops: [{ op: 'set_weight', exercise_name: 'Bench Press', weight: 155 }],
    })
    expect(result.ok).toBe(true)

    const upserts = mockUpsertSets.mock.calls[0]![1] as Array<Record<string, unknown>>
    expect(upserts).toHaveLength(1)
    const [only] = upserts
    expect(only!.setNumber).toBe(2)
    expect(only!.completed).toBe(false)
    // The change lands in the PRESCRIPTION, never in performed data.
    expect(only!.prescribedWeight).toBe(155)
    expect(only!.weight).toBeNull()
    // The completed set was not touched at all.
    expect(upserts.some((set) => set.clientSetId === 'set-1')).toBe(false)
  })

  it('refuses to shrink working sets past a completed one', async () => {
    mockGetActive.mockResolvedValue({
      ...workout(7),
      exercises: [
        {
          ...benchPress(),
          sets: [
            { ...benchPress().sets[0]!, setNumber: 2, clientSetId: 'set-2', completed: true },
            { ...benchPress().sets[0]!, setNumber: 1, clientSetId: 'set-1', completed: true },
          ],
        },
      ],
    })

    const result = await applyActiveEdit({ ops: [{ op: 'set_scheme', exercise_name: 'Bench Press', sets: 1 }] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.applied).toHaveLength(0)
    expect(result.rejected[0]!.error).toMatch(/already completed/)
    expect(mockUpsertSets).not.toHaveBeenCalled()
  })

  it('rewrites a completed set only when apply_to_completed is explicit', async () => {
    mockGetActive.mockResolvedValue(workout(7))
    mockUpsertSets.mockResolvedValue({ byExercise: {}, revision: 8, newlyCompletedClientSetIds: [] })

    await applyActiveEdit({
      ops: [
        {
          op: 'set_weight',
          exercise_name: 'Bench Press',
          set_number: 1,
          weight: 145,
          apply_to_completed: true,
        },
      ],
    })

    const upserts = mockUpsertSets.mock.calls[0]![1] as Array<Record<string, unknown>>
    expect(upserts).toHaveLength(1)
    expect(upserts[0]!.clientSetId).toBe('set-1')
    expect(upserts[0]!.weight).toBe(145)
    expect(upserts[0]!.completed).toBe(true)
  })
})

describe('applyActiveEdit — eligibility gate', () => {
  it('refuses to add a movement excluded by an active training constraint', async () => {
    mockGetActive.mockResolvedValue(workout(7))
    mockListInjuries.mockResolvedValue([{ region: 'shoulder_joint', severity: 'limiting' }])
    mockExecute.mockResolvedValue({
      rows: [
        {
          id: 'ex-9',
          name: 'Overhead Press',
          injury_profile: {
            schemaVersion: 1,
            provenance: 'catalog-derived',
            sites: { shoulder_joint: ['primary'] },
            traits: [],
          },
          injury_override: false,
        },
      ],
    })

    const result = await applyActiveEdit({
      ops: [{ op: 'add_exercise', exercise_name: 'Overhead Press' }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.applied).toHaveLength(0)
    expect(result.rejected[0]!.error).toMatch(/training constraint/i)
    expect(mockEditExercises).not.toHaveBeenCalled()
  })

  it('adds a movement that clears the gate', async () => {
    const after = { ...workout(8) }
    mockGetActive.mockResolvedValue(workout(7))
    mockListInjuries.mockResolvedValue([])
    mockExecute.mockResolvedValue({
      rows: [{ id: 'ex-9', name: 'Cable Row', injury_profile: null, injury_override: false }],
    })
    mockEditExercises.mockResolvedValue(after)

    const result = await applyActiveEdit({ ops: [{ op: 'add_exercise', exercise_name: 'Cable Row' }] })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.applied[0]!.change).toMatch(/Added Cable Row/)
    expect(mockEditExercises).toHaveBeenCalledWith('w-1', { add: [{ exerciseId: 'ex-9' }] }, 7)
  })
})
