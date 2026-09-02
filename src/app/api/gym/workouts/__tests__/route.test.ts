/**
 * POST /api/gym/workouts route — start a new active workout. Focus of this suite is
 * the P2b `from:'workout'` (History "Repeat") path added alongside the existing
 * template/empty/repeat_last froms: body validation (workoutId required), the
 * workoutId passthrough, the 404 on an unknown source workout, the 409 conflict
 * relay, plus a regression that repeat_last still validates. The lib is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockStart = vi.hoisted(() => vi.fn())
const mockAuth = vi.hoisted(() => vi.fn(() => true))

vi.mock('@/lib/auth', () => ({ authenticateRequest: mockAuth }))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/gym/active-workout', () => ({ startWorkout: mockStart }))

const { POST } = await import('../route')

function postReq(body: unknown) {
  return new NextRequest('http://localhost/api/gym/workouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(true)
  mockStart.mockReset()
})

describe('POST /api/gym/workouts — from:workout (Repeat)', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockReturnValue(false)
    const res = await POST(postReq({ from: 'workout', workoutId: 'w1' }))
    expect(res.status).toBe(401)
  })

  it('400s when workoutId is missing for from=workout', async () => {
    const res = await POST(postReq({ from: 'workout' }))
    expect(res.status).toBe(400)
    expect(mockStart).not.toHaveBeenCalled()
  })

  it('starts a workout copying the specific source, passing workoutId through', async () => {
    const workout = { id: 'new', name: 'Legacy Push', status: 'active', startedAt: 'x', templateId: null, templateName: null, exercises: [] }
    mockStart.mockResolvedValue({ workout })
    const res = await POST(postReq({ from: 'workout', workoutId: 'src-1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(workout)
    // signature: startWorkout(from, templateId, workoutId)
    expect(mockStart).toHaveBeenCalledWith('workout', undefined, 'src-1')
  })

  it('409s (conflict) when an active workout already exists', async () => {
    mockStart.mockResolvedValue({ conflictActiveWorkoutId: 'already' })
    const res = await POST(postReq({ from: 'workout', workoutId: 'src-1' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ activeWorkoutId: 'already' })
  })

  it('404s when the source workout is not found', async () => {
    mockStart.mockRejectedValue(new Error('workout not found'))
    const res = await POST(postReq({ from: 'workout', workoutId: 'gone' }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/gym/workouts — other froms still work', () => {
  it('rejects an unknown from', async () => {
    const res = await POST(postReq({ from: 'nope' }))
    expect(res.status).toBe(400)
    expect(mockStart).not.toHaveBeenCalled()
  })

  it('400s when templateId is missing for from=template', async () => {
    const res = await POST(postReq({ from: 'template' }))
    expect(res.status).toBe(400)
    expect(mockStart).not.toHaveBeenCalled()
  })

  it('repeat_last needs no id and passes through', async () => {
    const workout = { id: 'r', name: null, status: 'active', startedAt: 'x', templateId: null, templateName: null, exercises: [] }
    mockStart.mockResolvedValue({ workout })
    const res = await POST(postReq({ from: 'repeat_last' }))
    expect(res.status).toBe(200)
    expect(mockStart).toHaveBeenCalledWith('repeat_last', undefined, undefined)
  })

  it('404s on unknown template', async () => {
    mockStart.mockRejectedValue(new Error('template not found'))
    const res = await POST(postReq({ from: 'template', templateId: 't-gone' }))
    expect(res.status).toBe(404)
  })
})
