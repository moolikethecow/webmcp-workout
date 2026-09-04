/**
 * Smoke test for the Train tab (P2a-A3). A2's optimistic store + logger barrel are
 * IN FLIGHT, so both are vi.mock()'d here — this proves the tab's own state machine
 * without depending on A2's implementation:
 *   - no active workout → <StartSurfaces> renders (empty-workout affordance).
 *   - active workout    → <ActiveWorkoutView> renders (name + Finish bar).
 * Intentionally light per GYM_PLAN §8 (no RTL churn on unsettled interactions).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type { ActiveWorkout, ActiveWorkoutStore } from '@/components/gym/train/store-contract'

// Stable push spy — StartSurfaces navigates to the template builder (#1381), so
// a fresh vi.fn() per call would be unassertable. `searchParamString` is mutable
// so a case can arrive with ?startTemplate=<id> set (#1875).
const routerPush = vi.fn()
const routerReplace = vi.fn()
let searchParamString = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(searchParamString),
}))

// ── mock A2's store module (values not landed yet) ──────────────────────────
const probe = vi.fn().mockResolvedValue(undefined)
const storeState: { current: ActiveWorkoutStore } = { current: null as unknown as ActiveWorkoutStore }

vi.mock('@/lib/gym-client/active-workout-store', () => ({
  ActiveWorkoutProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useActiveWorkoutStore: () => storeState.current,
}))

// ── mock A2's logger barrel ─────────────────────────────────────────────────
// A2's real shapes: NumericPadHost wraps children (Provider + portal host),
// SyncPill self-sources the store (no props), LoggerExerciseList is the set-table
// tree. Mirror those here so the smoke test matches the integration seam.
vi.mock('@/components/gym/logger', () => ({
  LoggerExerciseList: () => <div data-testid="logger-list" />,
  NumericPadHost: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="numeric-pad-host">{children}</div>
  ),
  SyncPill: () => <span data-testid="sync-pill" />,
  RestTimerBar: () => <div data-testid="rest-timer-bar" />,
}))

function makeStore(workout: ActiveWorkout | null, restTimer: ActiveWorkoutStore['restTimer'] = null): ActiveWorkoutStore {
  // The Train shell only touches a subset of the store; the rest of A2's API is
  // stubbed as no-ops. Cast through the index-signature'd type (test mock).
  return {
    workout,
    loading: false,
    syncState: 'saved',
    pendingCount: 0,
    elapsedSeconds: 0,
    restTimer,
    probe,
    start: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn(),
    discard: vi.fn().mockResolvedValue(undefined),
    updateHeader: vi.fn().mockResolvedValue(undefined),
    completeSet: vi.fn(),
    updateSetField: vi.fn(),
    addSet: vi.fn(),
    deleteSet: vi.fn(),
    cycleSetType: vi.fn(),
    addExercise: vi.fn().mockResolvedValue(undefined),
    removeExercise: vi.fn().mockResolvedValue(undefined),
    replaceExercise: vi.fn().mockResolvedValue(undefined),
    reorderExercise: vi.fn().mockResolvedValue(undefined),
    updateExerciseNotes: vi.fn(),
  } as unknown as ActiveWorkoutStore
}

const ACTIVE: ActiveWorkout = {
  id: 'w-1',
  revision: 0,
  name: 'Push Day',
  status: 'active',
  startedAt: new Date().toISOString(),
  templateId: null,
  templateName: null,
  exercises: [],
}

beforeEach(() => {
  probe.mockClear()
  routerPush.mockClear()
  routerReplace.mockClear()
  searchParamString = ''
  storeState.current = makeStore(null)
  // The start surface fetches /api/gym/templates on mount.
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ templates: [], lastWorkout: null }),
    }),
  ) as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TrainTab', () => {
  it('probes on mount', async () => {
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    await waitFor(() => expect(probe).toHaveBeenCalled())
  })

  it('no active workout → start surfaces (empty-workout button)', async () => {
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    expect(await screen.findByText(/Start empty workout/i)).toBeInTheDocument()
    expect(screen.queryByTestId('logger-list')).not.toBeInTheDocument()
  })

  it('active workout → ActiveWorkoutView (logger + finish bar)', async () => {
    storeState.current = makeStore(ACTIVE)
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    // The logger core + numeric pad host mount, and the Finish button shows.
    expect(await screen.findByTestId('logger-list')).toBeInTheDocument()
    expect(screen.getByTestId('numeric-pad-host')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /finish/i })).toBeInTheDocument()
    // The editable workout name is seeded from the store.
    expect(screen.getByLabelText('Workout name')).toHaveValue('Push Day')
  })

  it('Finish stays available with nothing logged, and says so', async () => {
    // A session can end for reasons unrelated to what got logged. The button
    // stays live and names the state rather than trapping the user.
    storeState.current = makeStore(ACTIVE)
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    const finish = await screen.findByRole('button', { name: /finish workout \(nothing logged\)/i })
    expect(finish).toBeEnabled()
  })

  it('cancels via the overflow menu and describes soft-discard honestly', async () => {
    const store = makeStore(ACTIVE)
    storeState.current = store
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)

    fireEvent.click(await screen.findByRole('button', { name: 'Workout options' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cancel workout' }))
    expect(screen.getByText('Cancel this workout?')).toBeInTheDocument()
    expect(screen.getByText(/marks the session discarded/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel workout' }))
    await waitFor(() => expect(store.discard).toHaveBeenCalled())
  })

  it('normalizes an all-lowercase generated workout name in the logger', async () => {
    storeState.current = makeStore({ ...ACTIVE, name: 'upper body volume' })
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    expect(await screen.findByLabelText('Workout name')).toHaveValue('Upper Body Volume')
  })

  it('grows the bottom reserve while the rest timer bar is showing, so it clears the last set instead of covering it', async () => {
    storeState.current = makeStore(ACTIVE, { endsAt: Date.now() + 60_000, exerciseId: 'ex-1' } as ActiveWorkoutStore['restTimer'])
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    const content = await screen.findByTestId('active-workout-content')
    expect(content.style.paddingBottom).toBe('132px')
  })

  it('reserves only the finish bar height when no rest timer is running', async () => {
    storeState.current = makeStore(ACTIVE)
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    const content = await screen.findByTestId('active-workout-content')
    expect(content.style.paddingBottom).toBe('76px')
  })
})

// Issue #1875: Templates' Start button deep-links to Train with
// ?startTemplate=<id> instead of just navigating and leaving the user to start
// manually — Train's mount effect must fire the same start('template', id) the
// StartSurfaces template row uses, and strip the param so Back/reload is inert.
describe('TrainTab — deep-linked template start (#1875)', () => {
  it('starts the deep-linked template on mount instead of just probing', async () => {
    searchParamString = 'tab=train&startTemplate=tpl-1'
    const store = makeStore(null)
    storeState.current = store
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    await waitFor(() => expect(store.start).toHaveBeenCalledWith('template', 'tpl-1'))
    expect(probe).not.toHaveBeenCalled()
  })

  it('strips startTemplate from the URL so a reload cannot refire it', async () => {
    searchParamString = 'tab=train&startTemplate=tpl-1'
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/gym?tab=train'))
  })
})

// Issue #1381: the template builder had lived on the Templates tab since #1102,
// but Train — where the user actually goes to work out — never pointed at it, so
// building a template read as something you could only do by finishing a
// workout first. These pin the signpost.
describe('TrainTab — template builder entry point (#1381)', () => {
  it('offers "Build a template" on the start surface', async () => {
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    expect(await screen.findByRole('button', { name: /build a template/i })).toBeInTheDocument()
  })

  it('deep-links straight into the builder, not just the Templates tab', async () => {
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    fireEvent.click(await screen.findByRole('button', { name: /build a template/i }))
    expect(routerPush).toHaveBeenCalledWith('/gym?tab=templates&new=1')
  })

  it('is present with zero templates — the case that made it feel missing', async () => {
    // global.fetch already returns { templates: [], lastWorkout: null }.
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    expect(await screen.findByRole('button', { name: /build a template/i })).toBeInTheDocument()
    // ...and the first-run hint now names it rather than only offering
    // save-after-an-empty-workout.
    expect(await screen.findByText(/Build a template to reuse a workout/i)).toBeInTheDocument()
  })

  it('stays out of the way during an active workout', async () => {
    storeState.current = makeStore(ACTIVE)
    const { default: TrainTab } = await import('../TrainTab')
    render(<TrainTab />)
    await screen.findByTestId('logger-list')
    expect(screen.queryByRole('button', { name: /build a template/i })).not.toBeInTheDocument()
  })
})
