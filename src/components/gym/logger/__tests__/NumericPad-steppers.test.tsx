/**
 * Regression for #1389: the weight pad's plate steppers must read decrement-left,
 * increment-right (the standard convention) and share one neutral color, not an
 * accent-vs-dim split that read as "the + button is red/alarming."
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
          weight: null,
          weightUnit: 'lb',
          reps: null,
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

describe('weight pad steppers (#1389)', () => {
  it('orders steppers decrement-then-increment and styles them identically', async () => {
    render(
      <ActiveWorkoutProvider>
        <NumericPadHost>
          <LoggerExerciseList />
        </NumericPadHost>
      </ActiveWorkoutProvider>,
    )
    fireEvent.click(await screen.findByRole('textbox', { name: /weight$/i }))

    let steppers: Element | null = null
    await waitFor(() => {
      steppers = document.querySelector('[aria-label="Weight steppers"]')
      expect(steppers).not.toBeNull()
    })
    const buttons = steppers!.querySelectorAll('button')
    const labels = Array.from(buttons).map((b) => b.textContent)

    // Decrement buttons come first (left), increment buttons second (right).
    const firstPlusIndex = labels.findIndex((l) => l?.startsWith('+'))
    const lastMinusIndex = labels.map((l) => l?.startsWith('−')).lastIndexOf(true)
    expect(lastMinusIndex).toBeLessThan(firstPlusIndex)

    // No accent-vs-dim split: every stepper renders the same color.
    const colors = new Set(Array.from(buttons).map((b) => (b as HTMLElement).style.color))
    expect(colors.size).toBe(1)
  })

  it('labels the RPE controls and echoes the selected value', async () => {
    render(
      <ActiveWorkoutProvider>
        <NumericPadHost>
          <LoggerExerciseList />
        </NumericPadHost>
      </ActiveWorkoutProvider>,
    )
    fireEvent.click(await screen.findByRole('textbox', { name: /weight$/i }))

    expect(await screen.findByText('RPE')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '8.5' }))
    expect(await screen.findByText('RPE · 8.5')).toBeVisible()
  })
})
