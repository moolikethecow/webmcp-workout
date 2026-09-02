/**
 * StartNoticesBanner (#1790).
 *
 * The user: "you're thinking only chat surface, there's a UI too" — the eased-weight
 * notice and its undo have to exist where the lifter is actually standing, not just as
 * an MCP field. These pin the two things that make it consent rather than a
 * silent change: it is always visible, and the restore is one tap.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StartNoticesBanner } from '../StartNoticesBanner'

const eased = {
  eased: [
    {
      exercise: 'Incline Bench Press (Dumbbell)',
      from: 150,
      to: 110,
      unit: 'lb' as const,
      reason: '7 weeks since you last trained this — starting at 72% to ease back in.',
    },
  ],
  injuries: [],
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('StartNoticesBanner', () => {
  it('renders nothing when there is nothing to say', () => {
    const { container } = render(<StartNoticesBanner notices={null} />)
    expect(container).toBeEmptyDOMElement()
    const empty = render(<StartNoticesBanner notices={{ eased: [], injuries: [] }} />)
    expect(empty.container).toBeEmptyDOMElement()
  })

  it('shows the change, the reason, and that the template is untouched', () => {
    render(<StartNoticesBanner notices={eased} />)
    expect(screen.getByText(/150→110lb/)).toBeInTheDocument()
    expect(screen.getByText(/7 weeks since you last trained this/)).toBeInTheDocument()
    expect(screen.getByText(/template is unchanged/i)).toBeInTheDocument()
  })

  it('restores template weights in one tap and tells the logger to refresh', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ restored: 3 }), { status: 200 }))
    const onRestored = vi.fn()
    render(<StartNoticesBanner notices={eased} onRestored={onRestored} />)

    fireEvent.click(screen.getByRole('button', { name: /use template weights/i }))

    await waitFor(() => expect(onRestored).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/gym/workouts/active/restore-weights',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('surfaces a failure instead of pretending it restored', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'That workout is no longer active.' }), { status: 400 }),
    )
    const onRestored = vi.fn()
    render(<StartNoticesBanner notices={eased} onRestored={onRestored} />)

    fireEvent.click(screen.getByRole('button', { name: /use template weights/i }))

    await waitFor(() =>
      expect(screen.getByText(/no longer active/i)).toBeInTheDocument(),
    )
    expect(onRestored).not.toHaveBeenCalled()
  })

  // Flagged, never removed — a physio-cleared movement carries injury_override
  // precisely so it survives, and silently dropping an exercise is its own
  // surprise. There is deliberately no "fix it for me" button here.
  it('flags an injury conflict without offering to remove the exercise', () => {
    render(
      <StartNoticesBanner
        notices={{
          eased: [],
          injuries: [{ exercise: 'Barbell Back Squat', reason: 'conflicts with a live injury (knee)' }],
        }}
      />,
    )
    expect(screen.getByText('Barbell Back Squat')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /use template weights/i })).not.toBeInTheDocument()
  })
})
