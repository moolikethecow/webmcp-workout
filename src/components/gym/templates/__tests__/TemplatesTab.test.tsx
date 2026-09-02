/**
 * Smoke test for the Templates tab (P2b-B1). The card list is fetched via
 * templates-client (mocked global.fetch). Intentionally light per GYM_PLAN §8 (no
 * RTL churn on the editor's unsettled drag/number interactions — the editor's
 * logic is covered by editor-state.test.ts). Proves:
 *   - empty state renders the "build your first" affordance;
 *   - a populated card list renders names + the AI ✦ source hint;
 *   - the archived toggle refetches with archived=1.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetTemplatesClientForTests } from '../templates-client'

// The tab reads ?new=1 (#1381) to open a fresh editor on arrival, so it needs a
// navigation context jsdom doesn't provide. `searchParamString` is mutable so a
// case can arrive with the param set.
let searchParamString = ''
const routerReplace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchParamString),
}))

// The AddExerciseSheet + ProgressionPolicyPicker pull the gym-client + engine; the
// smoke test never opens the editor, so they don't load here.

function mockFetchReturning(payload: unknown) {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => payload,
    }),
  ) as unknown as typeof fetch
}

const EMPTY = { folders: [], allFolders: [] }
const POPULATED = {
  folders: [
    {
      folder: 'PPL',
      templates: [
        {
          id: 't1',
          name: 'Push Day',
          folder: 'PPL',
          notes: null,
          source: 'user',
          exerciseCount: 5,
          lastPerformed: null,
          exercisePreview: ['Bench Press', 'Overhead Press'],
          archived: false,
        },
        {
          id: 't2',
          name: 'Coach Pull',
          folder: 'PPL',
          notes: null,
          source: 'ai',
          exerciseCount: 6,
          lastPerformed: '2026-07-01T10:00:00Z',
          exercisePreview: ['Deadlift'],
          archived: false,
        },
      ],
    },
  ],
  allFolders: ['PPL'],
}

beforeEach(() => {
  __resetTemplatesClientForTests()
  searchParamString = ''
  routerReplace.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('TemplatesTab', () => {
  it('empty → build-your-first affordance', async () => {
    mockFetchReturning(EMPTY)
    const { default: TemplatesTab } = await import('../TemplatesTab')
    render(<TemplatesTab />)
    expect(await screen.findByText(/build your first template/i)).toBeInTheDocument()
  })

  it('renders cards with names and the AI source hint', async () => {
    mockFetchReturning(POPULATED)
    const { default: TemplatesTab } = await import('../TemplatesTab')
    render(<TemplatesTab />)
    expect(await screen.findByText('Push Day')).toBeInTheDocument()
    expect(screen.getByText('Coach Pull')).toBeInTheDocument()
    // The AI-drafted card carries the ✦ (Sparkles) with its aria-label.
    expect(screen.getByLabelText('AI-drafted')).toBeInTheDocument()
    // Folder header renders.
    expect(screen.getByText('PPL')).toBeInTheDocument()
  })

  // Issue #1875: the Start link used to drop the template id, so Train had
  // nothing to start and the user landed on the plain start surface.
  it('Start deep-links to Train with the template id', async () => {
    mockFetchReturning(POPULATED)
    const { default: TemplatesTab } = await import('../TemplatesTab')
    render(<TemplatesTab />)
    const start = await screen.findByLabelText('Start Push Day in Train')
    expect(start).toHaveAttribute('href', '/gym?tab=train&startTemplate=t1')
  })

  it('the archived toggle refetches with archived=1', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => EMPTY }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const { default: TemplatesTab } = await import('../TemplatesTab')
    render(<TemplatesTab />)
    await screen.findByText(/build your first template/i)

    // Toggle to the archived view.
    const toggle = screen.getByRole('button', { name: /archived/i })
    fireEvent.click(toggle)

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('archived=1')),
    )
  })
})

// Issue #1381: the builder existed but Train never pointed at it. Train's
// "Build a template" links here with ?new=1, which must land IN the editor —
// not merely on the tab, which is what made the feature feel missing.
describe('TemplatesTab — ?new=1 deep link (#1381)', () => {
  it('opens a fresh editor on arrival and strips the param', async () => {
    searchParamString = 'tab=templates&new=1'
    mockFetchReturning(EMPTY)
    const { default: TemplatesTab } = await import('../TemplatesTab')
    render(<TemplatesTab />)

    // Assert the editor is OPEN, not that the list's CTA is gone: the editor
    // renders as a sibling AFTER the list, so the empty-state CTA legitimately
    // stays on screen (confirmed on prod). An absence assertion here passes
    // before the templates fetch resolves — green for the wrong reason.
    expect(await screen.findByRole('dialog', { name: 'New template' })).toBeInTheDocument()
    // The param is consumed, so a reload or Back returns to the list.
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith(expect.not.stringContaining('new=1')),
    )
    expect(routerReplace).toHaveBeenCalledWith(expect.stringContaining('tab=templates'))
  })

  it('leaves the list alone without the param', async () => {
    mockFetchReturning(EMPTY)
    const { default: TemplatesTab } = await import('../TemplatesTab')
    render(<TemplatesTab />)

    expect(await screen.findByText(/build your first template/i)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'New template' })).toBeNull()
    expect(routerReplace).not.toHaveBeenCalled()
  })
})
