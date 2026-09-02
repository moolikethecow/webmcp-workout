/**
 * /api/gym/templates route — GET (start surface + ?view=cards) + POST (full
 * builder create · duplicate · save-as-template). The lib layer is mocked; these
 * tests assert the route wiring: auth gate, body dispatch by shape, validation
 * pass-through (400 invalid payload, 422 missing exercise), and the created
 * resource is returned (201).
 *
 * NOTE the P2b change: POST now returns 201 (was 200) for creates.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockList = vi.hoisted(() => vi.fn())
const mockCreateFromWorkout = vi.hoisted(() => vi.fn())
const mockListCards = vi.hoisted(() => vi.fn())
const mockCreateFromEditor = vi.hoisted(() => vi.fn())
const mockDuplicate = vi.hoisted(() => vi.fn())
const mockFindMissing = vi.hoisted(() => vi.fn())
const mockGetEditor = vi.hoisted(() => vi.fn())
const mockValidate = vi.hoisted(() => vi.fn())
const mockAuth = vi.hoisted(() => vi.fn(() => true))
const mockWeightUnit = vi.hoisted(() => vi.fn().mockResolvedValue('lb'))

vi.mock('@/lib/auth', () => ({ authenticateRequest: mockAuth }))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/gym/unit-preferences', () => ({ getGymWeightUnit: mockWeightUnit }))
vi.mock('@/lib/gym/templates-read', () => ({
  listTemplatesForStart: mockList,
  createTemplateFromWorkout: mockCreateFromWorkout,
  listTemplateCards: mockListCards,
  createTemplateFromEditor: mockCreateFromEditor,
  duplicateTemplate: mockDuplicate,
  findMissingExerciseId: mockFindMissing,
  getTemplateForEditor: mockGetEditor,
  validateEditorPayload: mockValidate,
}))

const { GET, POST } = await import('../route')

function getReq(qs = '') {
  return new NextRequest(`http://localhost/api/gym/templates${qs}`)
}
function postReq(body: unknown) {
  return new NextRequest('http://localhost/api/gym/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(true)
  mockWeightUnit.mockReset().mockResolvedValue('lb')
  for (const m of [
    mockList,
    mockCreateFromWorkout,
    mockListCards,
    mockCreateFromEditor,
    mockDuplicate,
    mockFindMissing,
    mockGetEditor,
    mockValidate,
  ]) {
    m.mockReset()
  }
})

describe('GET /api/gym/templates', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockReturnValue(false)
    const res = await GET(getReq())
    expect(res.status).toBe(401)
    expect(mockList).not.toHaveBeenCalled()
  })

  it('returns the start-surface payload by default', async () => {
    const payload = { templates: [], lastWorkout: null }
    mockList.mockResolvedValue(payload)
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(payload)
    expect(mockListCards).not.toHaveBeenCalled()
  })

  it('returns folder-grouped cards for ?view=cards', async () => {
    const cards = { folders: [{ folder: 'PPL', templates: [] }], allFolders: ['PPL'] }
    mockListCards.mockResolvedValue(cards)
    const res = await GET(getReq('?view=cards'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cards)
    expect(mockListCards).toHaveBeenCalledWith(false)
  })

  it('passes archived=1 through to the cards query', async () => {
    mockListCards.mockResolvedValue({ folders: [], allFolders: [] })
    await GET(getReq('?view=cards&archived=1'))
    expect(mockListCards).toHaveBeenCalledWith(true)
  })

  it('500s when the lib throws', async () => {
    mockList.mockRejectedValue(new Error('boom'))
    const res = await GET(getReq())
    expect(res.status).toBe(500)
  })
})

describe('POST /api/gym/templates — dispatch', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockReturnValue(false)
    const res = await POST(postReq({ exercises: [] }))
    expect(res.status).toBe(401)
  })

  it('400s on invalid JSON', async () => {
    const res = await POST(postReq('{not json'))
    expect(res.status).toBe(400)
  })

  it('400s when no recognizable shape is provided', async () => {
    const res = await POST(postReq({ nonsense: true }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/gym/templates — duplicate', () => {
  it('duplicates and returns 201', async () => {
    const template = { id: 'copy', name: 'Push (copy)', folder: null, exerciseCount: 4 }
    mockDuplicate.mockResolvedValue(template)
    const res = await POST(postReq({ duplicateOf: 'src' }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ template })
    expect(mockDuplicate).toHaveBeenCalledWith('src')
  })

  it('404s when the source template is missing', async () => {
    mockDuplicate.mockResolvedValue(null)
    const res = await POST(postReq({ duplicateOf: 'gone' }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/gym/templates — save-as-template', () => {
  it('400s when name is blank', async () => {
    const res = await POST(postReq({ fromWorkoutId: 'w1', name: '   ' }))
    expect(res.status).toBe(400)
    expect(mockCreateFromWorkout).not.toHaveBeenCalled()
  })

  it('422s when the workout has no exercises', async () => {
    mockCreateFromWorkout.mockResolvedValue(null)
    const res = await POST(postReq({ fromWorkoutId: 'w1', name: 'Push' }))
    expect(res.status).toBe(422)
  })

  it('creates from a workout and returns 201', async () => {
    const template = { id: 'tpl', name: 'Push', folder: null, exerciseCount: 4 }
    mockCreateFromWorkout.mockResolvedValue(template)
    const res = await POST(postReq({ fromWorkoutId: 'w1', name: 'Push' }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ template })
    expect(mockCreateFromWorkout).toHaveBeenCalledWith('w1', 'Push', { carryProgression: false })
  })

  it('passes the progression carry-over through when the finish sheet asks for it', async () => {
    mockCreateFromWorkout.mockResolvedValue({ id: 'tpl', name: 'Push B', folder: null, exerciseCount: 4 })
    await POST(postReq({ fromWorkoutId: 'w1', name: 'Push B', carryProgression: true }))
    expect(mockCreateFromWorkout).toHaveBeenCalledWith('w1', 'Push B', { carryProgression: true })
  })
})

describe('POST /api/gym/templates — full builder create', () => {
  it('400s when validation fails', async () => {
    mockValidate.mockReturnValue({ ok: false, error: 'name is required' })
    const res = await POST(postReq({ exercises: [{ exerciseId: 'e1', position: 0 }] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'name is required' })
    expect(mockCreateFromEditor).not.toHaveBeenCalled()
  })

  it('422s when an exerciseId does not exist', async () => {
    mockValidate.mockReturnValue({
      ok: true,
      payload: { name: 'P', folder: null, notes: null, exercises: [{ exerciseId: 'e1', position: 0 }] },
    })
    mockFindMissing.mockResolvedValue('e1')
    const res = await POST(postReq({ name: 'P', exercises: [{ exerciseId: 'e1', position: 0 }] }))
    expect(res.status).toBe(422)
    expect(mockCreateFromEditor).not.toHaveBeenCalled()
  })

  it('creates from the editor payload and returns 201 with the reloaded template', async () => {
    const payload = {
      name: 'Push',
      folder: 'PPL',
      notes: null,
      exercises: [{ exerciseId: 'e1', position: 0 }],
    }
    mockValidate.mockReturnValue({ ok: true, payload })
    mockFindMissing.mockResolvedValue(null)
    mockCreateFromEditor.mockResolvedValue('new-id')
    const template = { id: 'new-id', name: 'Push', folder: 'PPL', exercises: [] }
    mockGetEditor.mockResolvedValue(template)

    const res = await POST(postReq({ name: 'Push', folder: 'PPL', exercises: [{ exerciseId: 'e1', position: 0 }] }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ template })
    expect(mockCreateFromEditor).toHaveBeenCalledWith(payload)
    expect(mockGetEditor).toHaveBeenCalledWith('new-id')
  })
})
