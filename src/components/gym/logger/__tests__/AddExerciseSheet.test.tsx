/**
 * @vitest-environment jsdom
 *
 * Smoke test for the in-workout AddExerciseSheet (GYM_PLAN §4). Fetch is
 * mocked; we assert offset paging makes the full result set reachable and that
 * picking a muscle-region chip drives a new query URL with `muscle=`, mirroring
 * the Exercises tab's filter (issue #1386).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { AddExerciseSheet } from '../AddExerciseSheet'
import { __resetGymClientForTests } from '@/lib/gym-client/fetch'
import type { ExerciseListItem } from '@/lib/gym-client/types'

const ROW: ExerciseListItem = {
  id: 'ex-bench',
  name: 'Incline Bench Press',
  category: 'strength',
  equipment: 'barbell',
  primaryMuscle: 'chest',
  secondaryMuscles: ['triceps'],
  regions: [{ region: 'chest', label: 'Chest', weight: 1 }],
  tracks: 'weight_reps',
  isCustom: false,
  aiFilled: false,
  tracked: true,
  disliked: false,
  sets: 12,
  lastPerformed: null,
  hasImages: false,
  slug: null,
  imagePath: null,
}

let listUrls: string[]

function row(index: number): ExerciseListItem {
  return { ...ROW, id: `ex-${index}`, name: `Exercise ${index}` }
}

beforeEach(() => {
  __resetGymClientForTests()
  listUrls = []
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/gym/exercises')) {
      listUrls.push(url)
      const params = new URL(url, 'https://gym.test').searchParams
      const offset = Number(params.get('offset') ?? 0)
      const total = 75
      const exercises = Array.from(
        { length: Math.min(50, Math.max(0, total - offset)) },
        (_, index) => row(offset + index + 1),
      )
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ exercises, total }),
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AddExerciseSheet', () => {
  it('loads subsequent pages by offset until every exercise is reachable', async () => {
    render(<AddExerciseSheet onAdd={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Exercise 50')

    fireEvent.click(screen.getByRole('button', { name: 'Load more — 50 of 75' }))
    await screen.findByText('Exercise 75')

    expect(listUrls.some((u) => u.includes('limit=50') && u.includes('offset=50'))).toBe(true)
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument()
  })

  it('picking a muscle-region chip drives a new query URL with muscle=', async () => {
    render(<AddExerciseSheet onAdd={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Exercise 1')

    fireEvent.click(screen.getByRole('button', { name: 'Chest' }))

    await waitFor(() => expect(listUrls.some((u) => u.includes('muscle=chest'))).toBe(true))
  })

  it('toggling a chip back off clears the muscle filter', async () => {
    render(<AddExerciseSheet onAdd={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Exercise 1')

    const chestChip = screen.getByRole('button', { name: 'Chest' })
    fireEvent.click(chestChip)
    await waitFor(() => expect(chestChip).toHaveAttribute('aria-pressed', 'true'))
    expect(listUrls.some((u) => u.includes('muscle=chest'))).toBe(true)

    fireEvent.click(chestChip)
    await waitFor(() => expect(chestChip).toHaveAttribute('aria-pressed', 'false'))
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
  })
})
