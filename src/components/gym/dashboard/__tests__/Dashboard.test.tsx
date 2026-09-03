import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))
// The anatomical figure pulls in the motion runtime; the dashboard's contract
// with it is just "hand it the readiness rows".
vi.mock('../ReadinessBlock', () => ({
  ReadinessBlock: ({ regions }: { regions: unknown[] }) => <div>Readiness: {regions.length} regions</div>,
}))

import Dashboard, { DEMO_PROMPTS } from '../Dashboard'
import { invalidateResources } from '@/lib/stores/data-sync-store'

const originalFetch = global.fetch

function jsonRoute(map: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const key = Object.keys(map).find((path) => url.startsWith(path))
    if (!key) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    return { ok: true, status: 200, json: async () => map[key] } as unknown as Response
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', jsonRoute({}))
})
afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('Dashboard', () => {
  it('renders the three demo prompts verbatim plus the browser line', async () => {
    render(<Dashboard />)

    for (const prompt of DEMO_PROMPTS) {
      expect(await screen.findByText(`“${prompt}”`)).toBeInTheDocument()
    }
    // No WebMCP in jsdom: the panel says so and says where to open it instead.
    expect(await screen.findByText('No WebMCP in this browser.')).toBeInTheDocument()
    expect(screen.getAllByText(/Sol or Terra/).length).toBeGreaterThan(0)
  })

  it('degrades to empty states when every fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    render(<Dashboard />)

    expect(await screen.findByText('No session yet today.')).toBeInTheDocument()
    expect(screen.getByText('No completed sessions yet.')).toBeInTheDocument()
    expect(screen.getByText('No active constraints.')).toBeInTheDocument()
    expect(screen.getByText('Readiness: 0 regions')).toBeInTheDocument()
  })

  it('shows the active workout, constraints and recent sessions', async () => {
    vi.stubGlobal(
      'fetch',
      jsonRoute({
        '/api/gym/workouts/active': { id: 'w1', name: 'Push A', exercises: [{}, {}, {}] },
        '/api/gym/plan': { proposal: null },
        '/api/gym/agent/readiness': { regions: [{ region: 'chest' }, { region: 'lats' }] },
        '/api/gym/injuries': {
          injuries: [{ id: 'i1', region: 'shoulder_left', label: 'Left shoulder', severity: 'limiting' }],
        },
        '/api/gym/history': {
          weightUnit: 'lb',
          sessions: [
            {
              id: 's1',
              name: 'Pull B',
              date: '2026-08-30T10:00:00.000Z',
              exerciseCount: 5,
              setCount: 18,
              volume: 12400,
            },
          ],
        },
      }),
    )
    render(<Dashboard />)

    expect(await screen.findByText('Push A')).toBeInTheDocument()
    expect(screen.getByText('3 exercises on the board.')).toBeInTheDocument()
    expect(screen.getByText('Left shoulder')).toBeInTheDocument()
    expect(screen.getByText('Pull B')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Readiness: 2 regions')).toBeInTheDocument())
  })

  it('refetches when an agent changes something, instead of waiting for a reload', async () => {
    // The bug this pins: the dashboard read once on mount and never again, so a
    // draft an agent had just created sat on the server while the page kept
    // saying "No session yet today". The Train tab subscribed to the same bus;
    // this page did not, so agent work was narrated on one screen and silently
    // dropped on the other.
    const fetchSpy = jsonRoute({})
    vi.stubGlobal('fetch', fetchSpy)

    render(<Dashboard />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const afterMount = fetchSpy.mock.calls.length

    await act(async () => {
      invalidateResources(['gym'])
    })

    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(afterMount))
  })

  it('ignores invalidations for other parts of the app', async () => {
    const fetchSpy = jsonRoute({})
    vi.stubGlobal('fetch', fetchSpy)

    render(<Dashboard />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const afterMount = fetchSpy.mock.calls.length

    await act(async () => {
      invalidateResources(['finance'])
    })

    expect(fetchSpy.mock.calls.length).toBe(afterMount)
  })
})
