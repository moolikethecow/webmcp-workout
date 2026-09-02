/**
 * /api/gym/injuries routes (P3-A3). Validation focus: a bad region → 400 (the
 * write-path safety gate), the tweak branch, and the [id] PATCH resolve + 404. The
 * lib is mocked so we assert the route's shaping/dispatch, not the SQL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockAuth = vi.hoisted(() => vi.fn(() => true))
const mockList = vi.hoisted(() => vi.fn())
const mockCreate = vi.hoisted(() => vi.fn())
const mockTweak = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockDelete = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({ authenticateRequest: mockAuth }))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/gym/injuries-gyms', () => ({
  listInjuries: mockList,
  createInjury: mockCreate,
  createTweakInjury: mockTweak,
  updateInjury: mockUpdate,
  deleteInjury: mockDelete,
}))

const { GET, POST } = await import('../route')
const { PATCH, DELETE } = await import('../[id]/route')

function req(method: string, body?: unknown, url = 'http://localhost/api/gym/injuries') {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(true)
  mockList.mockReset()
  mockCreate.mockReset()
  mockTweak.mockReset()
  mockUpdate.mockReset()
  mockDelete.mockReset()
})

describe('GET /api/gym/injuries', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockReturnValue(false)
    expect((await GET(req('GET'))).status).toBe(401)
  })
  it('passes active=1 through to listInjuries(true)', async () => {
    mockList.mockResolvedValue([])
    await GET(req('GET', undefined, 'http://localhost/api/gym/injuries?active=1'))
    expect(mockList).toHaveBeenCalledWith(true)
  })
  it('defaults to listInjuries(false) with no active flag', async () => {
    mockList.mockResolvedValue([])
    await GET(req('GET'))
    expect(mockList).toHaveBeenCalledWith(false)
  })
})

describe('POST /api/gym/injuries — region validation', () => {
  it('400s on a non-canonical region (no create fired)', async () => {
    const res = await POST(req('POST', { region: 'left knee', severity: 'nagging' }))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })
  it('201s on a canonical region', async () => {
    mockCreate.mockResolvedValue({ id: 'i1', region: 'quads', active: true })
    const res = await POST(req('POST', { region: 'quads', severity: 'out', label: 'knee' }))
    expect(res.status).toBe(201)
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ region: 'quads', severity: 'out' }))
  })
  it('201s on an anatomical site outside the legacy muscle-region list', async () => {
    mockCreate.mockResolvedValue({ id: 'i2', region: 'elbows', active: true })
    const res = await POST(req('POST', { region: 'elbows', severity: 'limiting', label: 'tendon' }))
    expect(res.status).toBe(201)
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ region: 'elbows', severity: 'limiting' }))
  })
  it('tweak branch validates region and calls createTweakInjury', async () => {
    mockTweak.mockResolvedValue({ id: 't1', region: 'hamstrings', active: true })
    const res = await POST(req('POST', { tweak: { region: 'hamstrings', days: 7 } }))
    expect(res.status).toBe(201)
    expect(mockTweak).toHaveBeenCalledWith('hamstrings', 7)
  })
  it('tweak branch 400s on a bad region', async () => {
    const res = await POST(req('POST', { tweak: { region: 'elbow' } }))
    expect(res.status).toBe(400)
    expect(mockTweak).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/gym/injuries/[id]', () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) })
  it('resolves and returns the injury', async () => {
    mockUpdate.mockResolvedValue({ id: 'i1', region: 'quads', active: false })
    const res = await PATCH(req('PATCH', { resolve: true }), params('i1'))
    expect(res.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledWith('i1', expect.objectContaining({ resolve: true }))
  })
  it('404s on a missing id', async () => {
    mockUpdate.mockResolvedValue(null)
    expect((await PATCH(req('PATCH', { resolve: true }), params('gone'))).status).toBe(404)
  })
})

describe('DELETE /api/gym/injuries/[id]', () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) })
  it('deletes and returns ok', async () => {
    mockDelete.mockResolvedValue(true)
    const res = await DELETE(req('DELETE'), params('i1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
  it('404s when nothing was deleted', async () => {
    mockDelete.mockResolvedValue(false)
    expect((await DELETE(req('DELETE'), params('gone'))).status).toBe(404)
  })
})
