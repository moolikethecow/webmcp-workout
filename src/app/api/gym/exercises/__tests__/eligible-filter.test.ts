/**
 * GET /api/gym/exercises?eligible=1 — the opt-in training-constraint filter.
 *
 * The catalog browser must keep showing everything; the agent surface must
 * never be offered a movement a live constraint excludes. This asserts that one
 * flag is the only difference, and that the real `exerciseAllowedWithInjuries`
 * gate (not a stand-in) decides.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockAuth = vi.hoisted(() => vi.fn(() => true))
const mockQuery = vi.hoisted(() => vi.fn())
const mockListInjuries = vi.hoisted(() => vi.fn())
const mockExecute = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({ authenticateRequest: mockAuth }))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/db/client', () => ({ db: { execute: mockExecute } }))
vi.mock('@/lib/gym/exercise-detail', () => ({ createExerciseWithFill: vi.fn() }))
vi.mock('@/lib/gym/search', () => ({ queryExercises: mockQuery }))
vi.mock('@/lib/gym/injuries-gyms', () => ({ listInjuries: mockListInjuries }))

const { GET } = await import('../route')

const SHOULDER_PROFILE = {
  schemaVersion: 1,
  provenance: 'catalog-derived',
  sites: { shoulder_joint: ['primary'] },
  traits: [],
}
const LEG_PROFILE = {
  schemaVersion: 1,
  provenance: 'catalog-derived',
  sites: { quads: ['primary'] },
  traits: [],
}

function req(url: string) {
  return new NextRequest(url, { method: 'GET' })
}

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(true)
  mockQuery.mockReset().mockResolvedValue({
    exercises: [
      { id: 'ex-press', name: 'Overhead Press' },
      { id: 'ex-squat', name: 'Back Squat' },
    ],
    total: 2,
  })
  mockListInjuries.mockReset().mockResolvedValue([])
  mockExecute.mockReset().mockResolvedValue({
    rows: [
      { id: 'ex-press', injury_profile: SHOULDER_PROFILE, injury_override: false },
      { id: 'ex-squat', injury_profile: LEG_PROFILE, injury_override: false },
    ],
  })
})

describe('GET /api/gym/exercises', () => {
  it('returns the unfiltered catalog without eligible=1, even with a live constraint', async () => {
    mockListInjuries.mockResolvedValue([{ region: 'shoulder_joint', severity: 'limiting' }])
    const body = await (await GET(req('http://localhost/api/gym/exercises?q=press'))).json()
    expect(body.exercises).toHaveLength(2)
    expect(body.eligibility).toBeUndefined()
    expect(mockListInjuries).not.toHaveBeenCalled()
  })

  it('excludes a movement that conflicts with an active constraint when eligible=1', async () => {
    mockListInjuries.mockResolvedValue([{ region: 'shoulder_joint', severity: 'limiting' }])

    const body = await (await GET(req('http://localhost/api/gym/exercises?eligible=1'))).json()

    expect(body.exercises.map((e: { name: string }) => e.name)).toEqual(['Back Squat'])
    expect(body.excluded_count).toBe(1)
    expect(body.total).toBe(1)
    expect(body.eligibility).toBe('filtered')
  })

  it('keeps a conflicting movement that carries injury_override', async () => {
    mockListInjuries.mockResolvedValue([{ region: 'shoulder_joint', severity: 'limiting' }])
    mockExecute.mockResolvedValue({
      rows: [
        { id: 'ex-press', injury_profile: SHOULDER_PROFILE, injury_override: true },
        { id: 'ex-squat', injury_profile: LEG_PROFILE, injury_override: false },
      ],
    })

    const body = await (await GET(req('http://localhost/api/gym/exercises?eligible=1'))).json()
    expect(body.exercises).toHaveLength(2)
    expect(body.excluded_count).toBe(0)
  })

  it('short-circuits with no active constraints — nothing is excluded', async () => {
    const body = await (await GET(req('http://localhost/api/gym/exercises?eligible=1'))).json()
    expect(body.exercises).toHaveLength(2)
    expect(body.excluded_count).toBe(0)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('a nagging constraint is not a hard exclusion', async () => {
    mockListInjuries.mockResolvedValue([{ region: 'shoulder_joint', severity: 'nagging' }])
    const body = await (await GET(req('http://localhost/api/gym/exercises?eligible=1'))).json()
    expect(body.exercises).toHaveLength(2)
    expect(body.excluded_count).toBe(0)
  })
})
