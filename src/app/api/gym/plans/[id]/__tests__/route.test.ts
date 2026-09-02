import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => {
  class TrainingPlanNotFoundError extends Error {}
  class TrainingPlanValidationError extends Error {}
  return {
    authenticate: vi.fn(() => true),
    get: vi.fn(),
    setStatus: vi.fn(),
    update: vi.fn(),
    TrainingPlanNotFoundError,
    TrainingPlanValidationError,
  }
})

vi.mock('@/lib/auth', () => ({ authenticateRequest: mocks.authenticate }))
vi.mock('@/lib/gym/training-plans', () => ({
  getTrainingPlan: mocks.get,
  setTrainingPlanStatus: mocks.setStatus,
  updateTrainingPlan: mocks.update,
  TrainingPlanNotFoundError: mocks.TrainingPlanNotFoundError,
  TrainingPlanValidationError: mocks.TrainingPlanValidationError,
}))

const { DELETE, GET, PATCH } = await import('../route')

const context = (id = 'plan-1') => ({ params: Promise.resolve({ id }) })

function request(method: 'GET' | 'PATCH' | 'DELETE', body?: unknown) {
  return new NextRequest('http://localhost/api/gym/plans/plan-1', {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.authenticate.mockReset().mockReturnValue(true)
  mocks.get.mockReset()
  mocks.setStatus.mockReset()
  mocks.update.mockReset()
})

describe('GET /api/gym/plans/[id]', () => {
  it('rejects unauthenticated reads', async () => {
    mocks.authenticate.mockReturnValue(false)

    const response = await GET(request('GET'), context())

    expect(response.status).toBe(401)
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('returns 404 when the plan does not exist', async () => {
    mocks.get.mockResolvedValue(null)

    const response = await GET(request('GET'), context('missing'))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Training plan not found' })
    expect(mocks.get).toHaveBeenCalledWith('missing', true)
  })

  it('returns the hydrated plan including its preview', async () => {
    const plan = { id: 'plan-1', name: 'Upper / Lower', nextTargets: [] }
    mocks.get.mockResolvedValue(plan)

    const response = await GET(request('GET'), context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ plan })
    expect(mocks.get).toHaveBeenCalledWith('plan-1', true)
  })
})

describe('PATCH /api/gym/plans/[id]', () => {
  it('returns 400 for malformed JSON', async () => {
    const response = await PATCH(request('PATCH', '{not json'), context())

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' })
  })

  it('routes status-only writes to the status transition seam', async () => {
    const plan = { id: 'plan-1', status: 'paused' }
    mocks.setStatus.mockResolvedValue(plan)

    const response = await PATCH(request('PATCH', { status: 'paused' }), context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ plan })
    expect(mocks.setStatus).toHaveBeenCalledWith('plan-1', 'paused')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('returns a validation failure from a structural update', async () => {
    mocks.update.mockRejectedValue(
      new mocks.TrainingPlanValidationError('Day 1 needs a templateId'),
    )

    const response = await PATCH(request('PATCH', { days: [{ name: 'Upper' }] }), context())

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Day 1 needs a templateId' })
  })

  it('returns 404 when the update target no longer exists', async () => {
    mocks.update.mockRejectedValue(
      new mocks.TrainingPlanNotFoundError('Training plan not found'),
    )

    const response = await PATCH(request('PATCH', { name: 'Renamed plan' }), context('missing'))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Training plan not found' })
  })
})

describe('DELETE /api/gym/plans/[id]', () => {
  it('archives instead of destructively deleting a plan', async () => {
    const plan = { id: 'plan-1', status: 'archived' }
    mocks.setStatus.mockResolvedValue(plan)

    const response = await DELETE(request('DELETE'), context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ plan })
    expect(mocks.setStatus).toHaveBeenCalledWith('plan-1', 'archived')
  })

  it('returns 404 when there is nothing to archive', async () => {
    mocks.setStatus.mockRejectedValue(
      new mocks.TrainingPlanNotFoundError('Training plan not found'),
    )

    const response = await DELETE(request('DELETE'), context('missing'))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Training plan not found' })
  })
})
