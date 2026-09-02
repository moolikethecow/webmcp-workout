import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockAuth = vi.hoisted(() => vi.fn(() => true))
const mockEditExercises = vi.hoisted(() => vi.fn())
const MockPerformedConflict = vi.hoisted(
  () => class ActiveWorkoutPerformedSetsConflictError extends Error {
    readonly code = 'performed_sets_present'
    readonly workoutExerciseId: string
    readonly operation: 'remove' | 'replace'

    constructor(workoutExerciseId: string, operation: 'remove' | 'replace') {
      super('That exercise already has completed sets and cannot be removed from the session history.')
      this.workoutExerciseId = workoutExerciseId
      this.operation = operation
    }
  },
)
const MockRevisionConflict = vi.hoisted(
  () => class ActiveWorkoutRevisionConflictError extends Error {
    readonly code = 'stale_revision'
  },
)

vi.mock('@/lib/auth', () => ({ authenticateRequest: mockAuth }))
vi.mock('@/lib/db/ensure-fitness', () => ({
  ensureGymSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/gym/active-workout', () => ({
  ActiveWorkoutPerformedSetsConflictError: MockPerformedConflict,
  ActiveWorkoutRevisionConflictError: MockRevisionConflict,
  editExercises: mockEditExercises,
}))
// #1876 chosen-vs-suggested: db.execute is only reached for a non-empty
// `replace` (the pre-edit exercise_id snapshot) — no rows ⇒ no match ⇒ the
// metric is silently skipped, so these tests don't need coach-context/novelty
// mocked too.
const mockDbExecute = vi.hoisted(() => vi.fn().mockResolvedValue({ rows: [] }))
vi.mock('@/lib/db/client', () => ({ db: { execute: mockDbExecute } }))

const mockAssembleCoachContext = vi.hoisted(() => vi.fn().mockResolvedValue({ pools: new Map() }))
vi.mock('@/lib/gym/coach-context', () => ({ assembleCoachContext: mockAssembleCoachContext }))
const mockAlternativesForProfile = vi.hoisted(() => vi.fn().mockReturnValue([]))
vi.mock('@/lib/gym/novelty', () => ({ alternativesForProfile: mockAlternativesForProfile }))
const mockSourceProfile = vi.hoisted(() => vi.fn().mockResolvedValue([]))
vi.mock('@/lib/gym/source-profile', () => ({ sourceProfile: mockSourceProfile }))

const { POST } = await import('../route')

function request(body: unknown) {
  return new NextRequest('http://localhost/api/gym/workouts/workout-1/exercises', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(true)
  mockEditExercises.mockReset()
  mockDbExecute.mockReset().mockResolvedValue({ rows: [] })
  mockAssembleCoachContext.mockReset().mockResolvedValue({ pools: new Map() })
  mockAlternativesForProfile.mockReset().mockReturnValue([])
  mockSourceProfile.mockReset().mockResolvedValue([])
})

describe('POST /api/gym/workouts/:id/exercises', () => {
  it('returns a typed 409 instead of deleting completed performance', async () => {
    mockEditExercises.mockRejectedValue(new MockPerformedConflict('we-1', 'remove'))

    const response = await POST(
      request({ expectedRevision: 4, remove: ['we-1'] }),
      { params: Promise.resolve({ id: 'workout-1' }) },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'That exercise already has completed sets and cannot be removed from the session history.',
      code: 'performed_sets_present',
      workoutExerciseId: 'we-1',
      operation: 'remove',
    })
    expect(mockEditExercises).toHaveBeenCalledWith(
      'workout-1',
      { remove: ['we-1'] },
      4,
    )
  })

  it('parses replace edits with keepPrescription (#1876), defaulting to false', async () => {
    mockEditExercises.mockResolvedValue({ id: 'workout-1' })

    const response = await POST(
      request({
        expectedRevision: 2,
        replace: [
          { workoutExerciseId: 'we-1', newExerciseId: 'ex-2', keepPrescription: true },
          { workoutExerciseId: 'we-3', newExerciseId: 'ex-4' },
        ],
      }),
      { params: Promise.resolve({ id: 'workout-1' }) },
    )

    expect(response.status).toBe(200)
    expect(mockEditExercises).toHaveBeenCalledWith(
      'workout-1',
      {
        replace: [
          { workoutExerciseId: 'we-1', newExerciseId: 'ex-2', keepPrescription: true },
          { workoutExerciseId: 'we-3', newExerciseId: 'ex-4', keepPrescription: false },
        ],
      },
      2,
    )
  })

  // #1876 — logs whether a replacement pick was among the deterministic suggestions.
  describe('chosen-vs-suggested metric', () => {
    it('logs wasSuggested:true when the pick is among the recomputed alternatives', async () => {
      mockEditExercises.mockResolvedValue({ id: 'workout-1' })
      mockDbExecute.mockResolvedValue({ rows: [{ id: 'we-1', exercise_id: 'ex-old' }] })
      mockAlternativesForProfile.mockReturnValue([{ id: 'ex-new' }, { id: 'ex-other' }])
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

      await POST(
        request({ expectedRevision: 3, replace: [{ workoutExerciseId: 'we-1', newExerciseId: 'ex-new' }] }),
        { params: Promise.resolve({ id: 'workout-1' }) },
      )
      await vi.waitFor(() => expect(infoSpy).toHaveBeenCalled())

      expect(infoSpy).toHaveBeenCalledWith(
        '[gym.replace] chosen-vs-suggested',
        expect.objectContaining({
          workoutId: 'workout-1',
          workoutExerciseId: 'we-1',
          oldExerciseId: 'ex-old',
          newExerciseId: 'ex-new',
          wasSuggested: true,
          suggestedCount: 2,
        }),
      )
      infoSpy.mockRestore()
    })

    it('logs wasSuggested:false when the pick was NOT among the alternatives', async () => {
      mockEditExercises.mockResolvedValue({ id: 'workout-1' })
      mockDbExecute.mockResolvedValue({ rows: [{ id: 'we-1', exercise_id: 'ex-old' }] })
      mockAlternativesForProfile.mockReturnValue([{ id: 'ex-other' }])
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

      await POST(
        request({ expectedRevision: 3, replace: [{ workoutExerciseId: 'we-1', newExerciseId: 'ex-new' }] }),
        { params: Promise.resolve({ id: 'workout-1' }) },
      )
      await vi.waitFor(() => expect(infoSpy).toHaveBeenCalled())

      expect(infoSpy).toHaveBeenCalledWith(
        '[gym.replace] chosen-vs-suggested',
        expect.objectContaining({ wasSuggested: false }),
      )
      infoSpy.mockRestore()
    })

    it('skips logging entirely when the edit has no replace ops', async () => {
      mockEditExercises.mockResolvedValue({ id: 'workout-1' })
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

      await POST(request({ expectedRevision: 1, remove: ['we-1'] }), {
        params: Promise.resolve({ id: 'workout-1' }),
      })

      expect(mockDbExecute).not.toHaveBeenCalled()
      expect(infoSpy).not.toHaveBeenCalled()
      infoSpy.mockRestore()
    })
  })

  it('accepts a per-exercise notes edit (null clears) and drops malformed rows', async () => {
    mockEditExercises.mockResolvedValue({ id: 'workout-1' })

    const response = await POST(
      request({
        expectedRevision: 7,
        notes: [
          { workoutExerciseId: 'we-1', notes: 'elbows tucked' },
          { workoutExerciseId: 'we-2', notes: null },
          { workoutExerciseId: 'we-3', notes: 42 },
          { notes: 'no id' },
        ],
      }),
      { params: Promise.resolve({ id: 'workout-1' }) },
    )

    expect(response.status).toBe(200)
    expect(mockEditExercises).toHaveBeenCalledWith(
      'workout-1',
      {
        notes: [
          { workoutExerciseId: 'we-1', notes: 'elbows tucked', applyToTemplate: false },
          { workoutExerciseId: 'we-2', notes: null, applyToTemplate: false },
        ],
      },
      7,
    )
  })
})
