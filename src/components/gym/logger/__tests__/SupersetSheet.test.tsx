/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ActiveExercise } from '@/lib/gym-client/active-types'
import { SupersetSheet } from '../SupersetSheet'
import { EMPTY_GRIP } from '@/lib/gym/grip'

function exercise(id: string, name: string, position: number): ActiveExercise {
  return {
    grip: EMPTY_GRIP,
    workoutExerciseId: id,
    exerciseId: `exercise-${id}`,
    name,
    tracks: 'weight_reps',
    modality: 'strength',
    perSide: false,
    loadBasis: 'total',
    section: 'main',
    position,
    supersetGroup: null,
    restSeconds: 120,
    preferredUnit: 'lb',
    notes: null,
    targets: [],
    ruleText: '',
    previous: [],
    sets: [],
  }
}

describe('SupersetSheet', () => {
  it('groups any selected exercises, not only adjacent rows', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <SupersetSheet
        exercises={[
          exercise('we1', 'Bench Press', 0),
          exercise('we2', 'Cable Row', 1),
          exercise('we3', 'Lateral Raise', 2),
        ]}
        initialSelectedIds={['we1']}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )

    // Select the non-adjacent third exercise; the middle stays out.
    fireEvent.click(screen.getByRole('checkbox', { name: /Lateral Raise/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save superset' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['we1', 'we3']))
  })

  it('requires two exercises and labels three or more as a circuit', () => {
    render(
      <SupersetSheet
        exercises={[
          exercise('we1', 'Bench Press', 0),
          exercise('we2', 'Cable Row', 1),
          exercise('we3', 'Lateral Raise', 2),
        ]}
        initialSelectedIds={['we1']}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Save superset' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /Cable Row/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Lateral Raise/ }))
    expect(screen.getByRole('button', { name: 'Save circuit' })).toBeEnabled()
  })
})
