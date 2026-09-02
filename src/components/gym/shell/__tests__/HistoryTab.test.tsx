/**
 * HistoryTab smoke + interaction test (P2b-B3). The history-client fetch layer is
 * vi.mock()'d so the tab's own composition + state machine are verified without a
 * network:
 *   - loaded payload → calendar + weekly bars + session list all render
 *   - Previous/Next replaces rows and respects both page boundaries
 *   - a failed page fetch preserves the current page; delete resets to page 1
 *   - tapping a workout day with a SINGLE session opens the SessionDetailSheet
 *   - tapping a session row opens the sheet
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type { HistoryResponse, SessionDetail } from '@/components/gym/history/history-client'

// ── mock next/navigation (SessionDetailSheet uses useRouter) ────────────────
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

// ── mock the history-client fetch layer ─────────────────────────────────────
const historyState: { current: { data: HistoryResponse | null; loading: boolean; error: boolean } } = {
  current: { data: null, loading: true, error: false },
}
const detailState: { current: { data: SessionDetail | null; loading: boolean; error: boolean } } = {
  current: { data: null, loading: false, error: false },
}
const fetchSessionsPage = vi.hoisted(() => vi.fn())
const deleteSession = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))

vi.mock('@/components/gym/history/history-client', () => ({
  useHistory: () => historyState.current,
  useSessionDetail: () => detailState.current,
  fetchSessionsPage,
  repeatWorkout: vi.fn(),
  saveWorkoutAsTemplate: vi.fn(),
  deleteSession,
}))

const { default: HistoryTab } = await import('../HistoryTab')

const PAYLOAD: HistoryResponse = {
  calendar: [
    { date: '2026-07-08', workoutIds: ['w-single'], count: 1 },
    { date: '2026-07-10', workoutIds: ['w-a', 'w-b'], count: 2 },
  ],
  weeks: [{ weekStart: '2026-06-29', workouts: 3, volumeLb: 12000 }],
  sessions: [
    { id: 'w-single', name: 'Push Day', date: '2026-07-08T09:00:00Z', durationSeconds: 3600, exerciseCount: 5, setCount: 15, volumeLb: 9000, templateId: 't1', templateName: 'Push' },
  ],
  hasMore: false,
  eras: [],
}

function session(id: string, name: string, date: string): HistoryResponse['sessions'][number] {
  return {
    id,
    name,
    date,
    durationSeconds: 3000,
    exerciseCount: 4,
    setCount: 12,
    volumeLb: 7000,
    templateId: null,
    templateName: null,
  }
}

function pageResponse(
  sessions: HistoryResponse['sessions'],
  hasMore: boolean,
): HistoryResponse {
  return { ...PAYLOAD, sessions, hasMore }
}

const DETAIL: SessionDetail = {
  id: 'w-single',
  name: 'Push Day',
  date: '2026-07-08T09:00:00Z',
  durationSeconds: 3600,
  notes: null,
  templateId: 't1',
  templateName: 'Push',
  exerciseCount: 1,
  setCount: 3,
  volumeLb: 3000,
  exercises: [
    {
      workoutExerciseId: 'we1',
      exerciseId: 'e1',
      name: 'Bench Press',
      tracks: 'weight_reps',
      loadBasis: 'per_side',
      primaryMuscle: 'chest',
      supersetGroup: null,
      notes: null,
      sets: [
        { id: 's1', logicalSetId: 'ls1', setNumber: 1, setType: 'normal', weight: 185, unit: 'lb', reps: 5, distanceM: null, durationS: null, rpe: null, restSeconds: null, side: 'left', completed: true },
        { id: 's2', logicalSetId: 'ls1', setNumber: 2, setType: 'normal', weight: 185, unit: 'lb', reps: 5, distanceM: null, durationS: null, rpe: null, restSeconds: 120, side: 'right', completed: true },
        { id: 's3', logicalSetId: 'ls2', setNumber: 3, setType: 'normal', weight: 190, unit: 'lb', reps: 5, distanceM: null, durationS: null, rpe: null, restSeconds: null, side: null, completed: false },
      ],
    },
  ],
}

// The tab opens on the CURRENT month (`currentMonth()` in history/format.ts) and
// the calendar only renders cells belonging to it — but every fixture here is
// July 2026. With a live clock these assertions therefore held only *during*
// July 2026 and went red on the Aug 1 rollover, which is a broken test, not a
// broken tab. Pin the clock to the fixture month. `shouldAdvanceTime` keeps
// real time flowing underneath so the `waitFor`/`findBy` calls still settle.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
  historyState.current = { data: PAYLOAD, loading: false, error: false }
  detailState.current = { data: null, loading: false, error: false }
  fetchSessionsPage.mockReset()
  deleteSession.mockReset()
  deleteSession.mockResolvedValue({ deleted: true, habitCompletionRemoved: false })
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('HistoryTab', () => {
  it('renders the first session page immediately when the async payload arrives', () => {
    historyState.current = { data: null, loading: true, error: false }
    const view = render(<HistoryTab />)

    historyState.current = { data: PAYLOAD, loading: false, error: false }
    view.rerender(<HistoryTab />)

    expect(screen.getByText('Push Day')).toBeInTheDocument()
    expect(screen.queryByText('No completed sessions yet.')).not.toBeInTheDocument()
  })

  it('renders the calendar, weekly bars, and session list', () => {
    render(<HistoryTab />)
    // Calendar section label + a month title.
    expect(screen.getByText('Calendar')).toBeInTheDocument()
    // Weekly-bars label.
    expect(screen.getByText('Workouts / week')).toBeInTheDocument()
    // Sessions section + the one row.
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('Push Day')).toBeInTheDocument()
    expect(screen.getByText('3 workouts on 2 days')).toBeInTheDocument()
    expect(screen.getByLabelText(/July 8: 1 workout/)).toHaveStyle({ height: '48px' })
  })

  it('keeps the full month collapsed until the user asks for it', () => {
    render(<HistoryTab />)

    const toggle = screen.getByRole('button', { name: 'Show full month' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('group', { name: /Full calendar for/ })).not.toBeInTheDocument()

    fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: 'Hide full month' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('group', { name: /Full calendar for/ })).toBeInTheDocument()
  })

  it('bounds the compact activity row in a busy month', () => {
    historyState.current = {
      data: {
        ...PAYLOAD,
        calendar: Array.from({ length: 8 }, (_, index) => ({
          date: `2026-07-${String(index + 1).padStart(2, '0')}`,
          workoutIds: [`w-${index + 1}`],
          count: 1,
        })),
      },
      loading: false,
      error: false,
    }

    render(<HistoryTab />)

    const activity = screen.getByRole('list', { name: /Workout days in/ })
    expect(within(activity).getAllByRole('button')).toHaveLength(5)
    expect(within(activity).getByText('+3 earlier')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /Full calendar for/ })).not.toBeInTheDocument()
  })

  it('replaces rows while paging forward and backward with bounded offsets', async () => {
    const firstPage = pageResponse(PAYLOAD.sessions, true)
    const secondPage = pageResponse(
      [session('w-page-2', 'Pull Day', '2026-06-30T09:00:00Z')],
      true,
    )
    const finalPage = pageResponse(
      [session('w-page-3', 'Leg Day', '2026-06-20T09:00:00Z')],
      false,
    )
    historyState.current = { data: firstPage, loading: false, error: false }
    fetchSessionsPage
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(finalPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(firstPage)

    render(<HistoryTab />)

    expect(screen.getByText('Page 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(fetchSessionsPage).toHaveBeenNthCalledWith(1, 20, 20))
    expect(await screen.findByText('Pull Day')).toBeInTheDocument()
    expect(screen.queryByText('Push Day')).not.toBeInTheDocument()
    expect(screen.getByText('Page 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(fetchSessionsPage).toHaveBeenNthCalledWith(2, 40, 20))
    expect(await screen.findByText('Leg Day')).toBeInTheDocument()
    expect(screen.queryByText('Pull Day')).not.toBeInTheDocument()
    expect(screen.getByText('Page 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await waitFor(() => expect(fetchSessionsPage).toHaveBeenNthCalledWith(3, 20, 20))
    expect(await screen.findByText('Pull Day')).toBeInTheDocument()
    expect(screen.queryByText('Leg Day')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await waitFor(() => expect(fetchSessionsPage).toHaveBeenNthCalledWith(4, 0, 20))
    expect(await screen.findByText('Push Day')).toBeInTheDocument()
    expect(screen.queryByText('Pull Day')).not.toBeInTheDocument()
    expect(screen.getByText('Page 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
  })

  it('keeps the current page when a page request fails', async () => {
    historyState.current = {
      data: pageResponse(PAYLOAD.sessions, true),
      loading: false,
      error: false,
    }
    fetchSessionsPage.mockRejectedValueOnce(new Error('offline'))

    render(<HistoryTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't load that page."))
    expect(screen.getByText('Push Day')).toBeInTheDocument()
    expect(screen.getByText('Page 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
  })

  it('shows a new base payload immediately instead of one frame of the old later page', async () => {
    const firstPage = pageResponse(PAYLOAD.sessions, true)
    historyState.current = { data: firstPage, loading: false, error: false }
    fetchSessionsPage.mockResolvedValueOnce(
      pageResponse([session('w-page-2', 'Pull Day', '2026-06-30T09:00:00Z')], false),
    )
    const view = render(<HistoryTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('Pull Day')).toBeInTheDocument()

    historyState.current = {
      data: pageResponse([session('w-new-base', 'New Base Session', '2026-07-15T09:00:00Z')], false),
      loading: false,
      error: false,
    }
    view.rerender(<HistoryTab />)

    expect(screen.getByText('New Base Session')).toBeInTheDocument()
    expect(screen.queryByText('Pull Day')).not.toBeInTheDocument()
  })

  it('resets to page 1 after deleting a session from a later page', async () => {
    const firstPage = pageResponse(PAYLOAD.sessions, true)
    const secondPage = pageResponse(
      [session('w-page-2', 'Pull Day', '2026-06-30T09:00:00Z')],
      false,
    )
    historyState.current = { data: firstPage, loading: false, error: false }
    detailState.current = { data: { ...DETAIL, id: 'w-page-2', name: 'Pull Day' }, loading: false, error: false }
    fetchSessionsPage.mockResolvedValueOnce(secondPage)

    render(<HistoryTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByLabelText(/Open Pull Day/))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete session' }))
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete session' })
    fireEvent.click(deleteButtons[deleteButtons.length - 1]!)

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith('w-page-2'))
    expect(await screen.findByText('Push Day')).toBeInTheDocument()
    expect(screen.queryByText('Pull Day')).not.toBeInTheDocument()
    expect(screen.getByText('Page 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
  })

  it('keeps the current history page when session detail is only closed', async () => {
    historyState.current = {
      data: pageResponse(PAYLOAD.sessions, true),
      loading: false,
      error: false,
    }
    detailState.current = { data: { ...DETAIL, id: 'w-page-2', name: 'Pull Day' }, loading: false, error: false }
    fetchSessionsPage.mockResolvedValueOnce(
      pageResponse([session('w-page-2', 'Pull Day', '2026-06-30T09:00:00Z')], false),
    )

    render(<HistoryTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByLabelText(/Open Pull Day/))
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))

    expect(screen.getByText('Pull Day')).toBeInTheDocument()
    expect(screen.getByText('Page 2')).toBeInTheDocument()
    expect(fetchSessionsPage).toHaveBeenCalledTimes(1)
  })

  it('opens the session detail when a single-workout day is tapped', async () => {
    detailState.current = { data: DETAIL, loading: false, error: false }
    render(<HistoryTab />)
    // The 8th has one workout → its cell is a button with an aria-label mentioning 1 workout.
    const dayBtn = screen.getByLabelText(/July 8: 1 workout/)
    fireEvent.click(dayBtn)
    await waitFor(() => {
      // The sheet renders the exercise name from the detail.
      expect(screen.getByText('Bench Press')).toBeInTheDocument()
    })
  })

  it('opens the sheet from a session-list row', async () => {
    detailState.current = { data: DETAIL, loading: false, error: false }
    render(<HistoryTab />)
    fireEvent.click(screen.getByLabelText(/Open Push Day/))
    await waitFor(() => {
      expect(screen.getByText('Bench Press')).toBeInTheDocument()
    })
    expect(screen.getByText('Left')).toBeInTheDocument()
    expect(screen.getByText('Right')).toBeInTheDocument()
    expect(screen.getByText('⏱ 2:00')).toBeInTheDocument()
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.getByText('Per side · 1 × sets')).toBeInTheDocument()
  })

  it('deletes a completed session through an explicit confirmation', async () => {
    detailState.current = { data: DETAIL, loading: false, error: false }
    render(<HistoryTab />)
    fireEvent.click(screen.getByLabelText(/Open Push Day/))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete session' }))
    expect(screen.getByText('Delete this session?')).toBeInTheDocument()
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete session' })
    fireEvent.click(deleteButtons[deleteButtons.length - 1]!)
    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith('w-single'))
  })

  it('Escape dismisses delete confirmation before closing session detail', async () => {
    detailState.current = { data: DETAIL, loading: false, error: false }
    render(<HistoryTab />)
    fireEvent.click(screen.getByLabelText(/Open Push Day/))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete session' }))

    expect(screen.getByRole('alertdialog', { name: 'Delete this session?' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('alertdialog', { name: 'Delete this session?' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Push Day' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Push Day' })).not.toBeInTheDocument()
  })

  it('shows an error state when the payload fails', () => {
    historyState.current = { data: null, loading: false, error: true }
    render(<HistoryTab />)
    expect(screen.getByText(/Couldn’t load your history/)).toBeInTheDocument()
  })
})
