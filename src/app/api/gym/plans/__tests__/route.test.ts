import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => {
  class TrainingPlanValidationError extends Error {}
  return {
    authenticate: vi.fn(() => true),
    create: vi.fn(),
    list: vi.fn(),
    TrainingPlanValidationError,
  }
})

vi.mock('@/lib/auth', () => ({ authenticateRequest: mocks.authenticate }))
vi.mock('@/lib/gym/training-plans', () => ({
  createTrainingPlan: mocks.create,
  listTrainingPlans: mocks.list,
  TrainingPlanValidationError: mocks.TrainingPlanValidationError,
}))

const { GET, POST } = await import('../route')

function request(method: 'GET' | 'POST', body?: unknown, query = '') {
  return new NextRequest(`http://localhost/api/gym/plans${query}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.authenticate.mockReset().mockReturnValue(true)
  mocks.create.mockReset()
  mocks.list.mockReset()
})

describe('GET /api/gym/plans', () => {
  it('rejects unauthenticated reads', async () => {
    mocks.authenticate.mockReturnValue(false)

    const response = await GET(request('GET'))

    expect(response.status).toBe(401)
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('returns plans and only includes archived rows when requested', async () => {
    const plans = [{ id: 'plan-1', name: 'Upper / Lower' }]
    mocks.list.mockResolvedValue(plans)

    const response = await GET(request('GET', undefined, '?archived=1'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ plans })
    expect(mocks.list).toHaveBeenCalledWith(true)
  })
})

describe('POST /api/gym/plans', () => {
  it('rejects unauthenticated writes before parsing the body', async () => {
    mocks.authenticate.mockReturnValue(false)

    const response = await POST(request('POST', { name: 'Nope' }))

    expect(response.status).toBe(401)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed JSON', async () => {
    const response = await POST(request('POST', '{not json'))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('returns the validation message without converting it to a server error', async () => {
    mocks.create.mockRejectedValue(
      new mocks.TrainingPlanValidationError('A plan needs 1–7 workout days'),
    )

    const response = await POST(request('POST', { name: 'Upper / Lower', days: [] }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'A plan needs 1–7 workout days' })
  })

  it('creates a plan and returns the canonical hydrated resource', async () => {
    const input = {
      name: 'Upper / Lower',
      days: [{ name: 'Upper A', templateId: 'template-1' }],
    }
    const plan = { id: 'plan-1', ...input, status: 'active', version: 1 }
    mocks.create.mockResolvedValue(plan)

    const response = await POST(request('POST', input))

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ plan })
    expect(mocks.create).toHaveBeenCalledWith(input)
  })
})
