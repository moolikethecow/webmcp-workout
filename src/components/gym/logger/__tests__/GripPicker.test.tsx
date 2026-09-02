/**
 * The grip control in the live logger (2026-08-31).
 *
 * This exists because "did MAG grip" used to end up in a free-text note, where
 * nothing could read it. The rules that matter here are about not getting in
 * the way mid-set, and about being able to undo a wrong tap.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { EMPTY_GRIP } from '@/lib/gym/grip'
import { GripPicker } from '../GripPicker'

describe('GripPicker', () => {
  it('stays collapsed until asked, showing one line', () => {
    render(<GripPicker grip={EMPTY_GRIP} onChange={vi.fn()} />)
    expect(screen.getByText('Add')).toBeInTheDocument()
    // Three lists of chips on every card would be clutter on the one screen
    // that has to stay fast between sets.
    expect(screen.queryByText('Attachment')).not.toBeInTheDocument()
  })

  it('summarises what is set without opening', () => {
    render(
      <GripPicker
        grip={{ gripWidth: 'wide', gripOrientation: 'pronated', attachment: 'mag' }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByText('Wide overhand · MAG')).toBeInTheDocument()
  })

  it('opens all three lists and reports the field that changed', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<GripPicker grip={EMPTY_GRIP} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /Grip/ }))
    expect(screen.getByText('Attachment')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'MAG' }))
    // Only the field touched — the others must stay untouched, not be nulled.
    expect(onChange).toHaveBeenCalledWith({ attachment: 'mag' })
  })

  // The common mistake is picking the wrong chip; the common fix is un-picking
  // it. A separate clear button would be a third tap for a one-tap error.
  it('tapping the selected chip clears that field', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<GripPicker grip={{ ...EMPTY_GRIP, attachment: 'rope' }} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /Grip/ }))
    const rope = screen.getByRole('button', { name: 'Rope' })
    expect(rope).toHaveAttribute('aria-pressed', 'true')
    await user.click(rope)
    expect(onChange).toHaveBeenCalledWith({ attachment: null })
  })

  // A client mid-deploy can still hold a workout payload from the build before
  // grip existed. Blanking the logger for the length of a deploy is worse than
  // any missing label.
  it('renders when the payload predates grip entirely', () => {
    render(<GripPicker grip={undefined} onChange={vi.fn()} />)
    expect(screen.getByText('Add')).toBeInTheDocument()
  })

  it('every attachment is offered, not a token few', async () => {
    const user = userEvent.setup()
    render(<GripPicker grip={EMPTY_GRIP} onChange={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Grip/ }))
    for (const name of ['MAG', 'Rope', 'V-bar', 'Lat bar', 'Trap bar', 'Towel']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
  })
})
