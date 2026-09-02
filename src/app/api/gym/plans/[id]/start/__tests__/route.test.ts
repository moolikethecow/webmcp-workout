import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => {
  class TrainingPlanNotFoundError extends Error {}
  class TrainingPlanValidationError extends Error {}
  return {
    authenticate: vi.fn(() => true),
    start: vi.fn(),
    TrainingPlanNotFoundError,
    TrainingPlanValidationError,
  }
})

vi.mock('@/lib/auth', () => ({ authenticateRequest: mocks.authenticate }))
vi.mock('@/lib/gym/training-plans', () => ({
  startTrainingPlanDay: mocks.start,
  TrainingPlanNotFoundError: mocks.TrainingPlanNotFoundError,
  TrainingPlanValidationError: mocks.TrainingPlanValidationError,
}))

const { POST } = await import('../route')

const context = (id = 'plan-1') => ({ params: Promise.resolve({ id }) })

function request(body?: unknown) {
  return new NextRequest('http://localhost/api/gym/plans/plan-1/start', {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.authenticate.mockReset().mockReturnValue(true)
  mocks.start.mockReset()
})

describe('POST /api/gym/plans/[id]/start', () => {
  it('rejects unauthenticated starts', async () => {
    mocks.authenticate.mockReturnValue(false)

    const response = await POST(request({}), context())

    expect(response.status).toBe(401)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('accepts an empty body and starts the next due day', async () => {
    const result = { workout: { id: 'workout-1', name: 'Upper A' }, planId: 'plan-1' }
    mocks.start.mockResolvedValue(result)

    const response = await POST(request(), context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(result)
    expect(mocks.start).toHaveBeenCalledWith('plan-1', undefined)
  })

  it('forwards an explicit day and returns the started workout', async () => {
    const result = { workout: { id: 'workout-2', name: 'Lower A' }, planId: 'plan-1' }
    mocks.start.mockResolvedValue(result)

    const response = await POST(request({ dayId: 'day-2' }), context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(result)
    expect(mocks.start).toHaveBeenCalledWith('plan-1', 'day-2')
  })

  it('returns 400 for malformed JSON', async () => {
    const response = await POST(request('{not json'), context())

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' })
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('returns the existing workout as a 409 conflict', async () => {
    mocks.start.mockResolvedValue({ conflictActiveWorkoutId: 'active-workout' })

    const response = await POST(request({}), context())

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ activeWorkoutId: 'active-workout' })
  })

  it('returns 404 for a missing plan', async () => {
    mocks.start.mockRejectedValue(
      new mocks.TrainingPlanNotFoundError('Training plan not found'),
    )

    const response = await POST(request({}), context('missing'))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Training plan not found' })
  })

  it('returns 400 when the requested day cannot be started', async () => {
    mocks.start.mockRejectedValue(
      new mocks.TrainingPlanValidationError('That day is not part of this training plan'),
    )

    const response = await POST(request({ dayId: 'foreign-day' }), context())

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'That day is not part of this training plan',
    })
  })
})
