/**
 * /api/gym/templates/[id] route — GET (editor shape) · PATCH (replace-all save OR
 * archive/restore toggle) · DELETE (soft archive). The lib layer is mocked; these
 * assert the route wiring: auth gate, param unwrap, body dispatch by shape, and the
 * honest status codes (404 missing, 400 bad body, 422 missing exercise).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockGet = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockArchive = vi.hoisted(() => vi.fn())
const mockUnarchive = vi.hoisted(() => vi.fn())
const mockFindMissing = vi.hoisted(() => vi.fn())
const mockValidate = vi.hoisted(() => vi.fn())
const mockAuth = vi.hoisted(() => vi.fn(() => true))
const mockWeightUnit = vi.hoisted(() => vi.fn().mockResolvedValue('lb'))

vi.mock('@/lib/auth', () => ({ authenticateRequest: mockAuth }))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/gym/unit-preferences', () => ({ getGymWeightUnit: mockWeightUnit }))
vi.mock('@/lib/gym/templates-read', () => ({
  getTemplateForEditor: mockGet,
  updateTemplateFromEditor: mockUpdate,
  archiveTemplate: mockArchive,
  unarchiveTemplate: mockUnarchive,
  findMissingExerciseId: mockFindMissing,
  validateEditorPayload: mockValidate,
}))

const { GET, PATCH, DELETE } = await import('../route')

const params = (id: string) => Promise.resolve({ id })

function req(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/gym/templates/t1', {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(true)
  mockWeightUnit.mockReset().mockResolvedValue('lb')
  for (const m of [mockGet, mockUpdate, mockArchive, mockUnarchive, mockFindMissing, mockValidate]) {
    m.mockReset()
  }
})

describe('GET /api/gym/templates/[id]', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockReturnValue(false)
    const res = await GET(req('GET'), { params: params('t1') })
    expect(res.status).toBe(401)
  })

  it('404s when the template is missing', async () => {
    mockGet.mockResolvedValue(null)
    const res = await GET(req('GET'), { params: params('t1') })
    expect(res.status).toBe(404)
  })

  it('returns the editor shape', async () => {
    const template = { id: 't1', name: 'Push', folder: null, notes: null, source: 'user', archived: false, exercises: [] }
    mockGet.mockResolvedValue(template)
    const res = await GET(req('GET'), { params: params('t1') })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ template })
    expect(mockGet).toHaveBeenCalledWith('t1')
  })
})

describe('PATCH /api/gym/templates/[id] — archive toggle', () => {
  it('archives when { archived: true }', async () => {
    mockArchive.mockResolvedValue(true)
    const res = await PATCH(req('PATCH', { archived: true }), { params: params('t1') })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ archived: true })
    expect(mockArchive).toHaveBeenCalledWith('t1')
  })

  it('restores when { archived: false }', async () => {
    mockUnarchive.mockResolvedValue(true)
    const res = await PATCH(req('PATCH', { archived: false }), { params: params('t1') })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ archived: false })
    expect(mockUnarchive).toHaveBeenCalledWith('t1')
  })

  it('404s when the toggle is a no-op', async () => {
    mockArchive.mockResolvedValue(false)
    const res = await PATCH(req('PATCH', { archived: true }), { params: params('t1') })
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/gym/templates/[id] — replace-all save', () => {
  it('400s when validation fails', async () => {
    mockValidate.mockReturnValue({ ok: false, error: 'at least one exercise is required' })
    const res = await PATCH(req('PATCH', { name: 'X', exercises: [] }), { params: params('t1') })
    expect(res.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('422s when an exerciseId does not exist', async () => {
    mockValidate.mockReturnValue({
      ok: true,
      payload: { name: 'X', folder: null, notes: null, exercises: [{ exerciseId: 'e9', position: 0 }] },
    })
    mockFindMissing.mockResolvedValue('e9')
    const res = await PATCH(req('PATCH', { name: 'X', exercises: [{ exerciseId: 'e9', position: 0 }] }), {
      params: params('t1'),
    })
    expect(res.status).toBe(422)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('404s when the template is missing on update', async () => {
    mockValidate.mockReturnValue({
      ok: true,
      payload: { name: 'X', folder: null, notes: null, exercises: [{ exerciseId: 'e1', position: 0 }] },
    })
    mockFindMissing.mockResolvedValue(null)
    mockUpdate.mockResolvedValue(false)
    const res = await PATCH(req('PATCH', { name: 'X', exercises: [{ exerciseId: 'e1', position: 0 }] }), {
      params: params('t1'),
    })
    expect(res.status).toBe(404)
  })

  it('saves and returns the reloaded template', async () => {
    const payload = { name: 'X', folder: null, notes: null, exercises: [{ exerciseId: 'e1', position: 0 }] }
    mockValidate.mockReturnValue({ ok: true, payload })
    mockFindMissing.mockResolvedValue(null)
    mockUpdate.mockResolvedValue(true)
    const template = { id: 't1', name: 'X', exercises: [] }
    mockGet.mockResolvedValue(template)
    const res = await PATCH(req('PATCH', { name: 'X', exercises: [{ exerciseId: 'e1', position: 0 }] }), {
      params: params('t1'),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ template })
    expect(mockUpdate).toHaveBeenCalledWith('t1', payload)
  })

  it('400s when neither archived nor exercises is provided', async () => {
    const res = await PATCH(req('PATCH', { name: 'X' }), { params: params('t1') })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/gym/templates/[id]', () => {
  it('archives and returns { archived: true }', async () => {
    mockArchive.mockResolvedValue(true)
    const res = await DELETE(req('DELETE'), { params: params('t1') })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ archived: true })
    expect(mockArchive).toHaveBeenCalledWith('t1')
  })

  it('404s when already archived / missing', async () => {
    mockArchive.mockResolvedValue(false)
    const res = await DELETE(req('DELETE'), { params: params('t1') })
    expect(res.status).toBe(404)
  })
})
