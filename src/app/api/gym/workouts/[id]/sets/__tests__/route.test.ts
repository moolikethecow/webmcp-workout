import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// #1836: adding sets / editing rest on not-yet-started sets re-sends an
// exercise's ALREADY-completed sibling sets unchanged (the optimistic client
// always PUTs the full current set array). The route must only treat a set as
// "just completed" — and fire the rest-end push — when `upsertSets` reports it
// as newly completed in THIS write, not merely present with completed: true.

const mockAuth = vi.hoisted(() => vi.fn(() => true))
const mockUpsertSets = vi.hoisted(() => vi.fn())
const mockOnSetsCompleted = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
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
  ActiveWorkoutRevisionConflictError: MockRevisionConflict,
  upsertSets: mockUpsertSets,
}))
vi.mock('@/lib/gym/push', () => ({
  onSetsCompleted: mockOnSetsCompleted,
}))

const { PUT } = await import('../route')

function request(body: unknown) {
  return new NextRequest('http://localhost/api/gym/workouts/workout-1/sets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function setInput(overrides: Record<string, unknown> = {}) {
  return {
    clientSetId: '11111111-1111-4111-8111-111111111111',
    workoutExerciseId: 'we-1',
    setNumber: 1,
    completed: false,
    ...overrides,
  }
}

async function call(body: unknown) {
  return PUT(request(body), { params: Promise.resolve({ id: 'workout-1' }) })
}

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(true)
  mockUpsertSets.mockReset()
  mockOnSetsCompleted.mockReset().mockResolvedValue(undefined)
})

describe('PUT /api/gym/workouts/:id/sets — rest-end push gating (#1836)', () => {
  it('does not re-fire the push for an already-completed set resent alongside a new set', async () => {
    // The exercise has one prior ✓ (cs-old) and one brand-new, not-yet-started
    // set (cs-new) — the client's full-array resend includes both.
    const oldSet = { clientSetId: 'cs-old', logicalSetId: 'cs-old', completed: true, setNumber: 1 }
    const newSet = { clientSetId: 'cs-new', logicalSetId: 'cs-new', completed: false, setNumber: 2 }
    mockUpsertSets.mockResolvedValue({
      byExercise: { 'we-1': [oldSet, newSet] },
      revision: 2,
      // upsertSets correctly reports nothing NEW completed in this write.
      newlyCompletedClientSetIds: [],
    })

    const response = await call({
      expectedRevision: 1,
      sets: [
        setInput({ clientSetId: 'cs-old', completed: true, setNumber: 1 }),
        setInput({ clientSetId: 'cs-new', completed: false, setNumber: 2, restSeconds: 90 }),
      ],
    })

    expect(response.status).toBe(200)
    expect(mockOnSetsCompleted).not.toHaveBeenCalled()
  })

  it('fires the push once when a set genuinely flips to completed', async () => {
    const flipped = { clientSetId: 'cs-1', logicalSetId: 'cs-1', completed: true, setNumber: 1 }
    mockUpsertSets.mockResolvedValue({
      byExercise: { 'we-1': [flipped] },
      revision: 2,
      newlyCompletedClientSetIds: ['cs-1'],
    })

    const response = await call({
      expectedRevision: 1,
      sets: [setInput({ clientSetId: 'cs-1', completed: true, setNumber: 1 })],
    })

    expect(response.status).toBe(200)
    expect(mockOnSetsCompleted).toHaveBeenCalledWith('workout-1', ['we-1'])
  })

  it('never fires the push for a not-yet-started set even when included in the batch', async () => {
    const incomplete = { clientSetId: 'cs-new', logicalSetId: 'cs-new', completed: false, setNumber: 1 }
    mockUpsertSets.mockResolvedValue({
      byExercise: { 'we-1': [incomplete] },
      revision: 2,
      newlyCompletedClientSetIds: [],
    })

    const response = await call({
      expectedRevision: 1,
      sets: [setInput({ clientSetId: 'cs-new', completed: false, restSeconds: 60 })],
    })

    expect(response.status).toBe(200)
    expect(mockOnSetsCompleted).not.toHaveBeenCalled()
  })
})
