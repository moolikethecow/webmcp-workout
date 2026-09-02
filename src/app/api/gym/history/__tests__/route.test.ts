/**
 * /api/gym/history route (P2b) — thin GET that wires readHistory. The lib is
 * mocked; these tests assert the auth gate, the query-param passthrough
 * (month/offset/limit), the 500 on a lib throw, and that a good call returns the
 * lib payload verbatim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockRead = vi.hoisted(() => vi.fn())
const mockAuth = vi.hoisted(() => vi.fn(() => true))
const mockUnits = vi.hoisted(() => vi.fn().mockResolvedValue({ weightUnit: 'lb', distanceUnit: 'mi' }))

vi.mock('@/lib/auth', () => ({ authenticateRequest: mockAuth }))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/gym/history-read', () => ({ readHistory: mockRead }))
vi.mock('@/lib/gym/unit-preferences', () => ({ getGymUnitPreferences: mockUnits }))

const { GET } = await import('../route')

function req(qs = '') {
  return new NextRequest(`http://localhost/api/gym/history${qs}`)
}

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(true)
  mockRead.mockReset()
  mockUnits.mockReset().mockResolvedValue({ weightUnit: 'lb', distanceUnit: 'mi' })
})

describe('GET /api/gym/history', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockReturnValue(false)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(mockRead).not.toHaveBeenCalled()
  })

  it('returns the history payload', async () => {
    const payload = { calendar: [], weeks: [], sessions: [], hasMore: false, eras: [] }
    mockRead.mockResolvedValue(payload)
    const res = await GET(req('?month=2026-07'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ...payload, distanceUnit: 'mi' })
  })

  it('passes month/offset/limit through to the lib', async () => {
    mockRead.mockResolvedValue({ calendar: [], weeks: [], sessions: [], hasMore: false, eras: [] })
    await GET(req('?month=2026-06&offset=40&limit=10'))
    expect(mockRead).toHaveBeenCalledWith({ month: '2026-06', offset: 40, limit: 10 }, 'lb')
  })

  it('omits absent params (undefined, not NaN)', async () => {
    mockRead.mockResolvedValue({ calendar: [], weeks: [], sessions: [], hasMore: false, eras: [] })
    await GET(req())
    expect(mockRead).toHaveBeenCalledWith({ month: undefined, offset: undefined, limit: undefined }, 'lb')
  })

  it('500s when the lib throws', async () => {
    mockRead.mockRejectedValue(new Error('boom'))
    const res = await GET(req())
    expect(res.status).toBe(500)
  })
})
