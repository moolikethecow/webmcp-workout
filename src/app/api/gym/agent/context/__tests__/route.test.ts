/**
 * GET /api/gym/agent/context — the orientation payload behind
 * `get_training_context`.
 *
 * The regression this pins: the payload reported the active workout, the draft,
 * the constraints and the equipment, and said nothing about the training plan.
 * An agent asked "what's next up" therefore had only readiness and history to
 * reason from, and answered by naming whichever day looked least recently
 * trained — fluently, specifically, and wrongly — while an active plan sat
 * there holding the real answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockActive = vi.hoisted(() => vi.fn())
const mockInjuries = vi.hoisted(() => vi.fn())
const mockGyms = vi.hoisted(() => vi.fn())
const mockUnits = vi.hoisted(() => vi.fn())
const mockProposal = vi.hoisted(() => vi.fn())
const mockPlans = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/gym/active-workout', () => ({ getActiveWorkout: mockActive }))
vi.mock('@/lib/gym/injuries-gyms', () => ({ listInjuries: mockInjuries, listGyms: mockGyms }))
vi.mock('@/lib/gym/unit-preferences', () => ({ getGymUnitPreferences: mockUnits }))
vi.mock('@/lib/gym/plan', () => ({ getTodayProposal: mockProposal }))
vi.mock('@/lib/gym/training-plans', () => ({ listTrainingPlans: mockPlans }))

const { GET } = await import('../route')

const PLAN = {
  id: 'plan-1',
  name: 'Base Block',
  status: 'active',
  scheduleMode: 'flexible',
  completedSessions: 3,
  nextDay: { id: 'day-1', name: 'Upper A', templateId: 'tpl-1', templateName: 'Upper A', available: true },
}

beforeEach(() => {
  mockActive.mockReset().mockResolvedValue(null)
  mockInjuries.mockReset().mockResolvedValue([])
  mockGyms.mockReset().mockResolvedValue([])
  mockUnits.mockReset().mockResolvedValue({ weightUnit: 'lb', distanceUnit: 'mi' })
  mockProposal.mockReset().mockResolvedValue(null)
  mockPlans.mockReset().mockResolvedValue([PLAN])
})

describe('agent context', () => {
  it('names the active plan and the day it says is next', async () => {
    const body = await (await GET()).json()

    expect(body.state.activePlan).toMatchObject({
      name: 'Base Block',
      completedSessions: 3,
      nextDay: { name: 'Upper A', templateName: 'Upper A', available: true },
    })
  })

  it('carries the templateId, because a name cannot be staged', async () => {
    const body = await (await GET()).json()

    // Staging the day is draft_workout(mode:"tune", templateId). Returning only
    // the name leaves that call undrivable: the agent can describe a session it
    // has no way to put on screen, which is exactly what "the workout never
    // showed up in the staging area" looks like from the outside.
    expect(body.state.activePlan.nextDay.templateId).toBe('tpl-1')
  })

  it('tells an agent to stage the day, not just name it', async () => {
    const body = await (await GET()).json()
    const rule = (body.rules as string[]).find((line) => line.includes('decides which session is next'))

    expect(rule).toMatch(/stage it with draft_workout/)
    expect(rule).toMatch(/templateId/)
  })

  it('tells an agent the plan decides the next session, not readiness', async () => {
    const body = await (await GET()).json()
    const rule = (body.rules as string[]).find((line) => line.includes('decides which session is next'))

    expect(rule).toBeDefined()
    expect(rule).toMatch(/readiness/i)
    expect(rule).toMatch(/least recently/i)
  })

  it('is null when no plan is running, so drafting is the honest next step', async () => {
    mockPlans.mockResolvedValue([{ ...PLAN, status: 'archived' }])

    const body = await (await GET()).json()

    expect(body.state.activePlan).toBeNull()
  })

  it('still answers when the plan lookup fails — orientation must not go down with it', async () => {
    mockPlans.mockRejectedValue(new Error('db down'))

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.state.activePlan).toBeNull()
    expect(body.state.gymEquipment).toBeNull()
  })
})
