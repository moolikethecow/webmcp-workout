import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockAuth = vi.hoisted(() => vi.fn(() => true))
const mockDetail = vi.hoisted(() => vi.fn())
const mockPatch = vi.hoisted(() => vi.fn())
const mockUnits = vi.hoisted(() => vi.fn().mockResolvedValue({ weightUnit: 'kg', distanceUnit: 'km' }))

vi.mock('@/lib/auth', () => ({ authenticateRequest: mockAuth }))
vi.mock('@/lib/db/ensure-fitness', () => ({
  ensureGymSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/fitness/enrich', () => ({
  ensureExerciseCatalogEnriched: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/gym/exercise-detail', () => ({
  ActiveLoadCorrectionError: class ActiveLoadCorrectionError extends Error {},
  getExerciseDetail: mockDetail,
  patchExercise: mockPatch,
}))
vi.mock('@/lib/gym/unit-preferences', () => ({ getGymUnitPreferences: mockUnits }))

const { GET, PATCH } = await import('../route')

function req() {
  return new NextRequest('http://localhost/api/gym/exercises/e1')
}

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(true)
  mockDetail.mockReset()
  mockPatch.mockReset()
  mockUnits.mockReset().mockResolvedValue({ weightUnit: 'kg', distanceUnit: 'km' })
})

describe('PATCH /api/gym/exercises/[id]', () => {
  it('accepts the explicit per-side load basis', async () => {
    mockPatch.mockResolvedValue({ exercise: { id: 'e1', loadBasis: 'per_side' } })
    const request = new NextRequest('http://localhost/api/gym/exercises/e1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loadBasis: 'per_side' }),
    })

    const response = await PATCH(request, { params: Promise.resolve({ id: 'e1' }) })

    expect(response.status).toBe(200)
    expect(mockPatch).toHaveBeenCalledWith('e1', { loadBasis: 'per_side' })
  })
})

describe('GET /api/gym/exercises/[id]', () => {
  it('loads the exercise read model in the global app weight unit', async () => {
    const detail = {
      exercise: { id: 'e1' },
      weightUnit: 'kg',
      records: {},
      history: [],
      charts: {},
    }
    mockDetail.mockResolvedValue(detail)

    const response = await GET(req(), { params: Promise.resolve({ id: 'e1' }) })

    expect(response.status).toBe(200)
    expect(mockDetail).toHaveBeenCalledWith('e1', 'kg', 'km')
    expect(await response.json()).toEqual(detail)
  })

  it('does not resolve preferences or read detail before authentication', async () => {
    mockAuth.mockReturnValue(false)

    const response = await GET(req(), { params: Promise.resolve({ id: 'e1' }) })

    expect(response.status).toBe(401)
    expect(mockUnits).not.toHaveBeenCalled()
    expect(mockDetail).not.toHaveBeenCalled()
  })
})
