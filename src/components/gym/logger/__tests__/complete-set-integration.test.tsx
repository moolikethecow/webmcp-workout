/**
 * Integration regression: a ✓ tap on an untouched row must flip local state
 * (completed + ghost-committed values) THROUGH the real provider + list wiring
 * — not just at the reducer level. Written after a prod smoke found ✓ no-oping
 * end-to-end while the unit layers were green.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

import { ActiveWorkoutProvider } from '@/lib/gym-client/active-workout-store'
import { LoggerExerciseList } from '@/components/gym/logger'

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

describe('complete-set through the real provider wiring', () => {
  it('✓ on an untouched row commits the ghosts and marks completed locally', async () => {
    render(
      <ActiveWorkoutProvider>
        <LoggerExerciseList />
      </ActiveWorkoutProvider>,
    )
    const check = await screen.findByRole('button', { name: /Complete set 1/ })
    fireEvent.click(check)
    // Ghost-commit happened (85×10) and the card collapse-on-complete kicked in.
    await waitFor(() => {
      expect(screen.getByText(/85×10 top/)).toBeInTheDocument()
    })
    // Re-expand: the row is completed and carries the committed ghosts.
    fireEvent.click(screen.getByRole('button', { name: /Expand Bayesian Bicep Curl/ }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Uncomplete set 1/ })).toBeInTheDocument()
    })
    // The flush sent the COMMITTED state (the prod bug sent a stale snapshot).
    const putCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) =>
      String(u).includes('/sets'),
    )
    expect(putCalls.length).toBeGreaterThan(0)
    const lastBody = JSON.parse(String(putCalls[putCalls.length - 1]![1]!.body))
    const sent = lastBody.sets.find((s: { clientSetId: string }) => s.clientSetId === 'cs1')
    expect(sent.completed).toBe(true)
    expect(sent.weight).toBe(85)
    expect(sent.reps).toBe(10)
  })
})
