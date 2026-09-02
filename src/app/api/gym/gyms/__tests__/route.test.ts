/**
 * /api/gym/gyms routes (P3-A3). Covers the create/list shaping, the
 * excludeExercise "Not available here" branch, the [id] PATCH set-default + 404,
 * and DELETE. The lib enforces exactly-one-default in a transaction (covered in the
 * lib test); here we assert the route dispatch + status codes with the lib mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockAuth = vi.hoisted(() => vi.fn(() => true))
const mockList = vi.hoisted(() => vi.fn())
const mockCreate = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockDelete = vi.hoisted(() => vi.fn())
const mockExclude = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({ authenticateRequest: mockAuth }))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/gym/injuries-gyms', () => ({
  listGyms: mockList,
  createGym: mockCreate,
  updateGym: mockUpdate,
  deleteGym: mockDelete,
  excludeExerciseAtDefaultGym: mockExclude,
  // Real passthrough shape so the route's equipment coercion is exercised.
  pickEquipment: (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {}),
  GYM_EQUIPMENT_VOCAB: ['barbell', 'dumbbell', 'machine'],
}))

const { GET, POST } = await import('../route')
const { PATCH, DELETE } = await import('../[id]/route')

function req(method: string, body?: unknown, url = 'http://localhost/api/gym/gyms') {
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
  mockUpdate.mockReset()
  mockDelete.mockReset()
  mockExclude.mockReset()
})

describe('GET /api/gym/gyms', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockReturnValue(false)
    expect((await GET(req('GET'))).status).toBe(401)
  })
  it('returns gyms + the equipment vocab', async () => {
    mockList.mockResolvedValue([{ id: 'g1', name: 'Home' }])
    const res = await GET(req('GET'))
    const body = await res.json()
    expect(body.gyms).toHaveLength(1)
    expect(Array.isArray(body.equipmentVocab)).toBe(true)
  })
})

describe('POST /api/gym/gyms — create', () => {
  it('400s on an empty name', async () => {
    const res = await POST(req('POST', { name: '  ' }))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })
  it('201s and passes equipment through', async () => {
    mockCreate.mockResolvedValue({ id: 'g1', name: 'Home', isDefault: true })
    const res = await POST(
      req('POST', { name: 'Home', equipment: { categories: ['barbell'], machines: ['Row'], machines_excluded: [] }, isDefault: true }),
    )
    expect(res.status).toBe(201)
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Home',
        isDefault: true,
        equipment: expect.objectContaining({ categories: ['barbell'], machines: ['Row'] }),
      }),
    )
  })
})

describe('POST /api/gym/gyms — excludeExercise ("Not available here")', () => {
  it('routes to excludeExerciseAtDefaultGym and returns the result', async () => {
    mockExclude.mockResolvedValue(true)
    const res = await POST(req('POST', { excludeExercise: 'Leg Press' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ excluded: true })
    expect(mockExclude).toHaveBeenCalledWith('Leg Press')
    expect(mockCreate).not.toHaveBeenCalled()
  })
  it('reports excluded:false when there is no default gym', async () => {
    mockExclude.mockResolvedValue(false)
    const res = await POST(req('POST', { excludeExercise: 'Leg Press' }))
    expect(await res.json()).toEqual({ excluded: false })
  })
})

describe('PATCH /api/gym/gyms/[id]', () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) })
  it('sets default and returns the gym', async () => {
    mockUpdate.mockResolvedValue({ id: 'g1', name: 'Home', isDefault: true })
    const res = await PATCH(req('PATCH', { isDefault: true }), params('g1'))
    expect(res.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledWith('g1', expect.objectContaining({ isDefault: true }))
  })
  it('404s on a missing id', async () => {
    mockUpdate.mockResolvedValue(null)
    expect((await PATCH(req('PATCH', { name: 'X' }), params('gone'))).status).toBe(404)
  })
})

describe('DELETE /api/gym/gyms/[id]', () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) })
  it('deletes and returns ok', async () => {
    mockDelete.mockResolvedValue(true)
    expect((await DELETE(req('DELETE'), params('g1'))).status).toBe(200)
  })
  it('404s when nothing was deleted', async () => {
    mockDelete.mockResolvedValue(false)
    expect((await DELETE(req('DELETE'), params('gone'))).status).toBe(404)
  })
})
