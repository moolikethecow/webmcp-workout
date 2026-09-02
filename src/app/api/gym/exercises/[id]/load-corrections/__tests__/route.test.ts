import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockAuth = vi.hoisted(() => vi.fn(() => true))
const mockEnsure = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockList = vi.hoisted(() => vi.fn())
const mockPreview = vi.hoisted(() => vi.fn())
const mockApply = vi.hoisted(() => vi.fn())
const mockRevert = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({ authenticateRequest: mockAuth }))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: mockEnsure }))
vi.mock('@/lib/gym/load-corrections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gym/load-corrections')>()
  return {
    ...actual,
    listLoadCorrections: mockList,
    previewLoadCorrection: mockPreview,
    applyLoadCorrection: mockApply,
    revertLoadCorrection: mockRevert,
  }
})

const { GET, POST } = await import('../route')

const EXERCISE_ID = '11111111-1111-4111-8111-111111111111'
const CORRECTION_ID = '22222222-2222-4222-8222-222222222222'
const ctx = (id = EXERCISE_ID) => ({ params: Promise.resolve({ id }) })

function post(body: unknown) {
  return new NextRequest(`http://localhost/api/gym/exercises/${EXERCISE_ID}/load-corrections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockReturnValue(true)
  mockEnsure.mockResolvedValue(undefined)
  mockList.mockResolvedValue([])
  mockPreview.mockResolvedValue({ affectedSets: 192, divisor: 2 })
  mockApply.mockResolvedValue({ correction: { id: CORRECTION_ID }, preview: { affectedSets: 192 } })
  mockRevert.mockResolvedValue({ correction: { id: CORRECTION_ID, active: false }, restoredSets: 192 })
})

describe('/api/gym/exercises/[id]/load-corrections', () => {
  it('lists active corrections and an aggregate summary', async () => {
    mockList.mockResolvedValue([
      { id: CORRECTION_ID, active: true, revertedAt: null, affectedSets: 192 },
    ])
    const req = new NextRequest(
      `http://localhost/api/gym/exercises/${EXERCISE_ID}/load-corrections?includeReverted=true`,
    )
    const response = await GET(req, ctx())
    expect(response.status).toBe(200)
    expect(mockList).toHaveBeenCalledWith(EXERCISE_ID, true)
    expect(await response.json()).toMatchObject({
      summary: { active: 1, affectedSets: 192 },
    })
  })

  it('previews with divisor 2 by default', async () => {
    const response = await POST(
      post({ action: 'preview', startDate: '2024-10-16', endDate: '2026-07-08' }),
      ctx(),
    )
    expect(response.status).toBe(200)
    expect(mockPreview).toHaveBeenCalledWith(expect.objectContaining({
      exerciseId: EXERCISE_ID,
      startDate: '2024-10-16',
      endDate: '2026-07-08',
      divisor: undefined,
    }))
  })

  it('applies a validated correction and returns 201', async () => {
    const response = await POST(
      post({ action: 'apply', divisor: 2, reason: 'Both arms were added together' }),
      ctx(),
    )
    expect(response.status).toBe(201)
    expect(mockApply).toHaveBeenCalledWith(expect.objectContaining({
      exerciseId: EXERCISE_ID,
      divisor: 2,
    }))
  })

  it('reverts by correction id', async () => {
    const response = await POST(
      post({ action: 'revert', correctionId: CORRECTION_ID }),
      ctx(),
    )
    expect(response.status).toBe(200)
    expect(mockRevert).toHaveBeenCalledWith(EXERCISE_ID, CORRECTION_ID)
  })

  it.each([
    [{ action: 'apply', startDate: '2026-02-30' }, 'invalid calendar date'],
    [{ action: 'apply', startDate: '2026-07-08', endDate: '2024-10-16' }, 'reversed dates'],
    [{ action: 'apply', divisor: 0 }, 'zero divisor'],
    [{ action: 'revert' }, 'missing correction id'],
  ])('rejects %s (%s)', async (body, _label) => {
    const response = await POST(post(body), ctx())
    expect(response.status).toBe(400)
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRevert).not.toHaveBeenCalled()
  })

  it('rejects invalid exercise UUIDs before touching the service', async () => {
    const response = await POST(post({ action: 'preview' }), ctx('not-a-uuid'))
    expect(response.status).toBe(400)
    expect(mockEnsure).not.toHaveBeenCalled()
    expect(mockPreview).not.toHaveBeenCalled()
  })

  it('maps overlap and already-reverted errors to 409', async () => {
    const { LoadCorrectionError } = await import('@/lib/gym/load-corrections')
    mockApply.mockRejectedValueOnce(new LoadCorrectionError('overlap', 'overlap'))
    const overlap = await POST(post({ action: 'apply' }), ctx())
    expect(overlap.status).toBe(409)

    mockRevert.mockRejectedValueOnce(new LoadCorrectionError('inactive', 'already reverted'))
    const inactive = await POST(
      post({ action: 'revert', correctionId: CORRECTION_ID }),
      ctx(),
    )
    expect(inactive.status).toBe(409)
  })

  it('authenticates before reading body or schema', async () => {
    mockAuth.mockReturnValue(false)
    const response = await POST(post({ action: 'apply' }), ctx())
    expect(response.status).toBe(401)
    expect(mockEnsure).not.toHaveBeenCalled()
    expect(mockApply).not.toHaveBeenCalled()
  })
})
