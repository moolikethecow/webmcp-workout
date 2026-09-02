/**
 * Pad entry on a field that ALREADY holds a value must REPLACE it, not append
 * (tapping a "12" reps cell and typing 9 yields 9, not 129 — the 2026-08-17 gym
 * session complaint). Backspace still edits the existing value. The pad also
 * carries an always-visible "Hide keypad" dismissal.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { ActiveWorkoutProvider } from '@/lib/gym-client/active-workout-store'
import { LoggerExerciseList, NumericPadHost } from '@/components/gym/logger'

const ACTIVE = {
  id: 'w1',
  name: 'Workout',
  status: 'active',
  startedAt: new Date().toISOString(),
  templateId: null,
  templateName: null,
  exercises: [
    {
      workoutExerciseId: 'we1',
      exerciseId: 'e1',
      name: 'Bayesian Bicep Curl',
      tracks: 'weight_reps',
      position: 0,
      supersetGroup: null,
      restSeconds: 120,
      preferredUnit: 'lb',
      notes: null,
      targets: [],
      ruleText: 'Repeating last session.',
      previous: [{ setNumber: 1, weight: 85, unit: 'lb', reps: 10, durationS: null, distanceM: null }],
      sets: [
        {
          clientSetId: 'cs1',
          setNumber: 1,
          setType: 'normal',
          weight: 85,
          weightUnit: 'lb',
          reps: 12,
          distanceM: null,
          durationS: null,
          rpe: null,
          completed: false,
        },
      ],
    },
  ],
}

beforeEach(() => {
  globalThis.localStorage?.setItem?.('gym-queue-v1', '')
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes('/api/gym/workouts/active')) {
      return new Response(JSON.stringify(ACTIVE), { status: 200 })
    }
    if (u.includes('/sets')) {
      return new Response(JSON.stringify({ byExercise: {} }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as unknown as typeof fetch
})

function mount() {
  render(
    <ActiveWorkoutProvider>
      <NumericPadHost>
        <LoggerExerciseList />
      </NumericPadHost>
    </ActiveWorkoutProvider>,
  )
}

describe('numeric pad overwrite-on-open', () => {
  it('replaces an existing value with the first typed digit, then appends', async () => {
    mount()
    const repsCell = await screen.findByRole('textbox', { name: /reps$/i })
    expect((repsCell as HTMLInputElement).value).toBe('12')
    fireEvent.click(repsCell)
    await screen.findByRole('dialog', { name: 'Numeric pad' })

    fireEvent.click(screen.getByRole('button', { name: 'Digit 9' }))
    await waitFor(() => expect((repsCell as HTMLInputElement).value).toBe('9'))

    // The field is no longer pristine — the next digit APPENDS.
    fireEvent.click(screen.getByRole('button', { name: 'Digit 5' }))
    await waitFor(() => expect((repsCell as HTMLInputElement).value).toBe('95'))
  })

  it('backspace edits the existing value instead of replacing it', async () => {
    mount()
    const repsCell = await screen.findByRole('textbox', { name: /reps$/i })
    fireEvent.click(repsCell)
    await screen.findByRole('dialog', { name: 'Numeric pad' })

    fireEvent.click(screen.getByRole('button', { name: 'Backspace' }))
    await waitFor(() => expect((repsCell as HTMLInputElement).value).toBe('1'))
    // And digits now append to the edited value.
    fireEvent.click(screen.getByRole('button', { name: 'Digit 0' }))
    await waitFor(() => expect((repsCell as HTMLInputElement).value).toBe('10'))
  })

  it('offers an always-visible Hide keypad control that closes the pad', async () => {
    mount()
    fireEvent.click(await screen.findByRole('textbox', { name: /reps$/i }))
    await screen.findByRole('dialog', { name: 'Numeric pad' })

    fireEvent.click(screen.getByRole('button', { name: 'Hide keypad' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Numeric pad' })).toBeNull(),
    )
  })
})
