import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockAuth = vi.hoisted(() => vi.fn(() => true))
const mockGetProposal = vi.hoisted(() => vi.fn())
const mockGeneratePlan = vi.hoisted(() => vi.fn())
const mockWeightUnit = vi.hoisted(() => vi.fn().mockResolvedValue('kg'))
const MockProposalWriteConflictError = vi.hoisted(() =>
  class ProposalWriteConflictError extends Error {
    constructor(readonly proposalId: string) {
      super(`Workout proposal ${proposalId} changed while its shuffle was being generated.`)
      this.name = 'ProposalWriteConflictError'
    }
  },
)

vi.mock('@/lib/auth', () => ({ authenticateRequest: mockAuth }))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/gym/unit-preferences', () => ({ getGymWeightUnit: mockWeightUnit }))
vi.mock('@/lib/gym/plan', () => ({
  dismissProposal: vi.fn(),
  generatePlan: mockGeneratePlan,
  getTodayProposal: mockGetProposal,
  ProposalWriteConflictError: MockProposalWriteConflictError,
  proposalToWorkoutStart: vi.fn(),
}))

const { GET, POST } = await import('../route')

const proposal = {
  id: 'p1',
  forDate: '2026-07-14',
  status: 'proposed',
  rationale: 'Fresh legs.',
  payload: { name: 'Leg day', exercises: [] },
  contextHash: 'abc',
  createdAt: '2026-07-14T12:00:00Z',
}

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(true)
  mockGetProposal.mockReset().mockResolvedValue(proposal)
  mockGeneratePlan.mockReset().mockResolvedValue(proposal)
  mockWeightUnit.mockReset().mockResolvedValue('kg')
})

describe('/api/gym/plan display-unit seam', () => {
  it('annotates a saved proposal with the current app unit on GET', async () => {
    const response = await GET(new NextRequest('http://localhost/api/gym/plan'))
    const body = await response.json()
    expect(body.proposal).toMatchObject({ id: 'p1', weightUnit: 'kg' })
    expect(proposal).not.toHaveProperty('weightUnit')
  })

  it('annotates a newly generated proposal without changing canonical payload weights', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/gym/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'draft' }),
      }),
    )
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.proposal.weightUnit).toBe('kg')
    expect(mockGeneratePlan).toHaveBeenCalledWith({
      mode: 'draft',
      templateId: undefined,
      proposalId: undefined,
      focus: undefined,
    })
  })

  it('returns a typed 409 when a shuffle loses the proposal compare-and-swap', async () => {
    mockGeneratePlan.mockRejectedValue(new MockProposalWriteConflictError('p-stale'))

    const response = await POST(
      new NextRequest('http://localhost/api/gym/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'shuffle', proposalId: 'p-stale' }),
      }),
    )
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toMatchObject({ code: 'proposal_conflict', proposalId: 'p-stale' })
    expect(body.error).toMatch(/re-read the current draft/i)
  })
})
