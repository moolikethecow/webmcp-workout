/**
 * /api/gym/history/[id] route (P2b) — session detail. The lib is mocked; assert the
 * auth gate, the 404 when readSessionDetail returns null (missing / not completed),
 * the 200 passthrough, and the 500 on a throw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockDetail = vi.hoisted(() => vi.fn())
const mockUpdateRest = vi.hoisted(() => vi.fn())
const mockAuth = vi.hoisted(() => vi.fn(() => true))
const mockUnits = vi.hoisted(() => vi.fn().mockResolvedValue({ weightUnit: 'lb', distanceUnit: 'mi' }))

vi.mock('@/lib/auth', () => ({ authenticateRequest: mockAuth }))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/gym/history-read', () => ({
  readSessionDetail: mockDetail,
  updateCompletedSetRest: mockUpdateRest,
}))
vi.mock('@/lib/gym/history-delete', () => ({ deleteCompletedWorkout: vi.fn() }))
vi.mock('@/lib/gym/unit-preferences', () => ({ getGymUnitPreferences: mockUnits }))

const { GET, PATCH } = await import('../route')

function req() {
  return new NextRequest('http://localhost/api/gym/history/w1')
}
function patchReq(body: unknown) {
  return new NextRequest('http://localhost/api/gym/history/w1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}
const params = Promise.resolve({ id: 'w1' })

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(true)
  mockDetail.mockReset()
  mockUpdateRest.mockReset().mockResolvedValue(true)
  mockUnits.mockReset().mockResolvedValue({ weightUnit: 'lb', distanceUnit: 'mi' })
})

describe('PATCH /api/gym/history/[id] — edit per-set rest', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockReturnValue(false)
    const res = await PATCH(patchReq({ setId: 's1', restSeconds: 120 }), { params })
    expect(res.status).toBe(401)
    expect(mockUpdateRest).not.toHaveBeenCalled()
  })

  it('400s without a setId', async () => {
    const res = await PATCH(patchReq({ restSeconds: 120 }), { params })
    expect(res.status).toBe(400)
  })

  it('400s on an out-of-range rest', async () => {
    const res = await PATCH(patchReq({ setId: 's1', restSeconds: 99999 }), { params })
    expect(res.status).toBe(400)
    expect(mockUpdateRest).not.toHaveBeenCalled()
  })

  it('updates the set rest and echoes the value', async () => {
    const res = await PATCH(patchReq({ setId: 's1', restSeconds: 120 }), { params })
    expect(res.status).toBe(200)
    expect(mockUpdateRest).toHaveBeenCalledWith('w1', 's1', 120)
    expect(await res.json()).toEqual({ ok: true, restSeconds: 120 })
  })

  it('clears the rest when restSeconds is null', async () => {
    const res = await PATCH(patchReq({ setId: 's1', restSeconds: null }), { params })
    expect(res.status).toBe(200)
    expect(mockUpdateRest).toHaveBeenCalledWith('w1', 's1', null)
  })

  it('404s when the set is not in this session', async () => {
    mockUpdateRest.mockResolvedValue(false)
    const res = await PATCH(patchReq({ setId: 'nope', restSeconds: 60 }), { params })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/gym/history/[id]', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockReturnValue(false)
    const res = await GET(req(), { params })
    expect(res.status).toBe(401)
    expect(mockDetail).not.toHaveBeenCalled()
  })

  it('404s when the session is missing / not completed', async () => {
    mockDetail.mockResolvedValue(null)
    const res = await GET(req(), { params })
    expect(res.status).toBe(404)
    expect(mockDetail).toHaveBeenCalledWith('w1', 'lb')
  })

  it('returns the session detail', async () => {
    const detail = { id: 'w1', name: 'Push', date: '2026-07-08T00:00:00Z', durationSeconds: 3600, notes: null, templateId: null, templateName: null, exerciseCount: 5, setCount: 15, volumeLb: 9000, exercises: [] }
    mockDetail.mockResolvedValue(detail)
    const res = await GET(req(), { params })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ...detail, distanceUnit: 'mi' })
  })

  it('500s when the lib throws', async () => {
    mockDetail.mockRejectedValue(new Error('boom'))
    const res = await GET(req(), { params })
    expect(res.status).toBe(500)
  })
})
