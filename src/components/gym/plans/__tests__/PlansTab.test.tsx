import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pageContext = vi.hoisted(() => ({ useChatPageContext: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/lib/chat/page-context', () => pageContext)
vi.mock('sonner', () => ({ toast }))

import PlansTab from '../PlansTab'

const TEMPLATE = { id: 'template-1', name: 'Upper A' }

function plan(overrides: Record<string, unknown> = {}) {
  const day = {
    id: 'day-1',
    position: 0,
    name: 'Upper A',
    templateId: TEMPLATE.id,
    templateName: TEMPLATE.name,
    exerciseCount: 5,
    weekday: null,
    notes: null,
    available: true,
  }
  return {
    id: 'plan-1',
    name: 'Upper / Lower',
    goal: 'Slow, repeatable strength gain',
    status: 'active',
    scheduleMode: 'flexible',
    policy: {
      progression: {
        type: 'double_progression',
        repRange: [8, 10],
        increment: 5,
        requiredSets: 3,
        deloadAfterMisses: 2,
        deloadPct: 10,
      },
      applyToUnconfiguredExercises: true,
      autoAdjustTargets: true,
      reviewEverySessions: 4,
      blocks: [],
      repeatBlocks: false,
    },
    version: 2,
    createdAt: '2026-07-15T12:00:00.000Z',
    updatedAt: '2026-07-15T12:00:00.000Z',
    days: [day],
    completedSessions: 3,
    reviewDue: false,
    sessionsUntilReview: 1,
    nextDay: day,
    currentBlock: null,
    recentSessions: [],
    nextTargets: [
      {
        exerciseId: 'bench',
        exerciseName: 'Bench Press',
        unit: 'lb',
        managed: true,
        ruleText: '3×8–10, then add 5 lb',
        decision: 'Bump +5 lb — the progression rule cleared.',
        targets: [{ weight: 140, reps: 8 }],
      },
    ],
    ...overrides,
  }
}

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input.toString()
}

beforeEach(() => {
  pageContext.useChatPageContext.mockReset()
  toast.success.mockReset()
  toast.error.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PlansTab', () => {
  it('renders the next workout and publishes the plan list as page context', async () => {
    const current = plan()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url === '/api/gym/plans') return response({ plans: [current] })
      if (url === '/api/gym/templates') return response({ templates: [TEMPLATE] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<PlansTab />)

    expect(await screen.findByRole('heading', { name: 'Upper / Lower' })).toBeInTheDocument()
    expect(screen.getByText('Bump +5 lb — the progression rule cleared.')).toBeInTheDocument()
    expect(screen.getByText('Next plan review in 1 session.')).toBeInTheDocument()
    expect(screen.getByText('Auto-adjusting progression')).toBeInTheDocument()
    expect(screen.getAllByText('Upper A')).toHaveLength(2)

    expect(pageContext.useChatPageContext).toHaveBeenCalledWith(
      expect.objectContaining({ current_page: '/gym?tab=plans' }),
    )
  })

  it('creates a template-backed plan with the configured progression and periodization', async () => {
    let currentPlans: ReturnType<typeof plan>[] = []
    let createPayload: Record<string, unknown> | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      if (url === '/api/gym/templates') return response({ templates: [TEMPLATE] })
      if (url === '/api/gym/plans' && init?.method === 'POST') {
        createPayload = JSON.parse(String(init.body)) as Record<string, unknown>
        currentPlans = [plan({ name: createPayload.name })]
        return response({ plan: currentPlans[0] }, 201)
      }
      if (url === '/api/gym/plans') return response({ plans: currentPlans })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<PlansTab />)
    expect(await screen.findByText('No training plans yet.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'New plan' }))
    await user.type(screen.getByLabelText('Plan name'), 'Slow Upper / Lower')
    await user.type(screen.getByLabelText('Goal'), 'Add load only after every set clears')
    await user.selectOptions(screen.getByLabelText('Periodization'), 'base-deload')
    await user.click(screen.getByRole('button', { name: 'Create plan' }))

    expect(await screen.findByRole('heading', { name: 'Slow Upper / Lower' })).toBeInTheDocument()
    expect(createPayload).toMatchObject({
      name: 'Slow Upper / Lower',
      goal: 'Add load only after every set clears',
      scheduleMode: 'flexible',
      days: [{ name: 'Upper A', templateId: 'template-1', weekday: null, notes: null }],
      policy: {
        progression: {
          type: 'double_progression',
          repRange: [8, 10],
          increment: 5,
          requiredSets: 3,
          deloadAfterMisses: 2,
          deloadPct: 10,
        },
        blocks: [
          { name: 'Build', weeks: 4 },
          {
            name: 'Deload',
            weeks: 1,
            volumeMultiplier: 0.6,
            loadMultiplier: 0.85,
            targetRpe: 6,
            deload: true,
          },
        ],
        repeatBlocks: true,
      },
    })
  })

  it('starts the next due day through the plan endpoint', async () => {
    const startPending = new Promise<Response>(() => {})
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      if (url === '/api/gym/plans/plan-1/start' && init?.method === 'POST') {
        return startPending
      }
      if (url === '/api/gym/plans') return Promise.resolve(response({ plans: [plan()] }))
      if (url === '/api/gym/templates') return Promise.resolve(response({ templates: [TEMPLATE] }))
      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    const view = render(<PlansTab />)
    await user.click(await screen.findByRole('button', { name: 'Start next' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/gym/plans/plan-1/start', {
        method: 'POST',
        body: '{}',
      })
    })
    expect(screen.getByRole('button', { name: 'Start next' })).toBeDisabled()
    view.unmount()
  })

  it('blocks an archived template day instead of offering a broken start', async () => {
    const current = plan()
    current.days[0]!.available = false
    current.nextDay.available = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url === '/api/gym/plans') return response({ plans: [current] })
      if (url === '/api/gym/templates') return response({ templates: [TEMPLATE] })
      throw new Error(`Unexpected request: ${url}`)
    }))

    render(<PlansTab />)

    expect(await screen.findByText('Template archived — restore or replace it to start.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start next' })).toBeDisabled()
  })

  it('uses the compact shared-tab hierarchy for the empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url === '/api/gym/plans') return response({ plans: [] })
      if (url === '/api/gym/templates') return response({ templates: [TEMPLATE] })
      throw new Error(`Unexpected request: ${url}`)
    }))

    render(<PlansTab />)

    expect(await screen.findByText('No training plans yet.')).toBeInTheDocument()
    expect(screen.getByText('Plans')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Training plans' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Build your first plan' })).toBeInTheDocument()
  })

  it('reports builder failures through the shared toast convention', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      if (url === '/api/gym/templates') return response({ templates: [TEMPLATE] })
      if (url === '/api/gym/plans' && init?.method === 'POST') return response({ error: 'Plan write failed' }, 500)
      if (url === '/api/gym/plans') return response({ plans: [] })
      throw new Error(`Unexpected request: ${url}`)
    }))
    const user = userEvent.setup()

    render(<PlansTab />)
    await screen.findByText('No training plans yet.')
    await user.click(screen.getByRole('button', { name: 'New plan' }))
    await user.type(screen.getByLabelText('Plan name'), 'Test plan')
    await user.click(screen.getByRole('button', { name: 'Create plan' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Plan write failed'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
