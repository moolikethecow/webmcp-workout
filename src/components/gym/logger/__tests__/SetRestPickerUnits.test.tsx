/**
 * The units guard (#1832). A bare custom number under a minute reads as minutes
 * meant as seconds — real sessions carry a prescribed rest_seconds=3 sitting
 * between 120s siblings. The picker asks instead of silently taking either
 * reading; an explicit min:sec is never questioned.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SetRestPicker } from '../SetRestPicker'

function open(onChange = vi.fn(), onClose = vi.fn()) {
  render(
    <SetRestPicker
      setNumber={3}
      value={null}
      inheritedSeconds={120}
      onChange={onChange}
      onClose={onClose}
    />,
  )
  return { onChange, onClose }
}

function typeCustom(value: string) {
  fireEvent.change(screen.getByLabelText('Custom rest time'), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'Set' }))
}

describe('SetRestPicker units guard', () => {
  it('does not commit a bare "3" — asks which unit was meant', () => {
    const { onChange, onClose } = open()
    typeCustom('3')

    expect(onChange).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('group', { name: 'Confirm rest units' })).toBeInTheDocument()
    expect(screen.getByText(/did you mean 3:00\?/i)).toBeInTheDocument()
  })

  it('commits 180 when the minutes reading is confirmed', () => {
    const { onChange, onClose } = open()
    typeCustom('3')
    // Scoped to the confirm group: "3:00" also labels the 180s preset, which is
    // the point — confirming minutes lands on exactly that value.
    const group = screen.getByRole('group', { name: 'Confirm rest units' })
    fireEvent.click(within(group).getByRole('button', { name: /3:00/ }))

    expect(onChange).toHaveBeenCalledWith(180)
    expect(onClose).toHaveBeenCalled()
  })

  it('still allows a genuine 3-second rest when that reading is confirmed', () => {
    const { onChange } = open()
    typeCustom('3')
    const group = screen.getByRole('group', { name: 'Confirm rest units' })
    fireEvent.click(within(group).getByRole('button', { name: /seconds/ }))

    expect(onChange).toHaveBeenCalledWith(3)
  })

  it('takes an explicit "0:03" at its word — no question', () => {
    const { onChange, onClose } = open()
    typeCustom('0:03')

    expect(onChange).toHaveBeenCalledWith(3)
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Confirm rest units' })).not.toBeInTheDocument()
  })

  it('never questions 0 (straight into the next set) or an ordinary value', () => {
    const { onChange } = open()
    typeCustom('0')
    expect(onChange).toHaveBeenCalledWith(0)
    expect(screen.queryByRole('group', { name: 'Confirm rest units' })).not.toBeInTheDocument()
  })

  it('commits an ordinary custom value immediately', () => {
    const { onChange } = open()
    typeCustom('135')
    expect(onChange).toHaveBeenCalledWith(135)
    expect(screen.queryByRole('group', { name: 'Confirm rest units' })).not.toBeInTheDocument()
  })

  it('clears the question when the field is edited again', () => {
    open()
    typeCustom('4')
    expect(screen.getByRole('group', { name: 'Confirm rest units' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Custom rest time'), { target: { value: '45' } })
    expect(screen.queryByRole('group', { name: 'Confirm rest units' })).not.toBeInTheDocument()
  })
})
