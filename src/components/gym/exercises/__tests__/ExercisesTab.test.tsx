/**
 * Smoke test for the Gym Exercises tab. Fetch is mocked; we assert it renders
 * rows from a fixture and that typing in the search box (debounced 250ms) drives
 * a new query URL to the list endpoint. Intentionally light — per GYM_PLAN §8,
 * no heavy RTL churn on unsettled UI.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { ExercisesTab } from '../ExercisesTab'
import { __resetGymClientForTests } from '@/lib/gym-client/fetch'
import type { ExerciseListItem } from '@/lib/gym-client/types'

const ROW: ExerciseListItem = {
  id: 'ex-bench',
  name: 'Incline Bench Press',
  category: 'strength',
  equipment: 'barbell',
  primaryMuscle: 'chest',
  secondaryMuscles: ['triceps', 'shoulders'],
  regions: [
    { region: 'chest', label: 'Chest', weight: 1 },
    { region: 'triceps', label: 'Triceps', weight: 0.5 },
  ],
  tracks: 'weight_reps',
  isCustom: false,
  aiFilled: false,
  tracked: true,
  disliked: false,
  sets: 430,
  lastPerformed: '2026-07-04',
  hasImages: true,
  slug: 'Incline_Bench_Press',
  imagePath: 'videos/0294-NbVPDMW.gif',
}

/** Capture every list-endpoint URL the component requests. */
let listUrls: string[]

beforeEach(() => {
  __resetGymClientForTests()
  listUrls = []
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/gym/exercises')) {
      listUrls.push(url)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ exercises: [ROW], total: 1 }),
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ExercisesTab', () => {
  it('renders exercise rows from the fetched list', async () => {
    render(<ExercisesTab />)
    expect(await screen.findByText('Incline Bench Press')).toBeInTheDocument()
    // The thumbnail is the muscle figure; no media is fetched for it.
    expect(screen.getByRole('img', { name: 'Incline Bench Press' })).not.toHaveAttribute('src')
    // all-time sets + last-performed line
    expect(screen.getByText(/430 sets/)).toBeInTheDocument()
  })

  it('debounced search drives a new query URL with q=', async () => {
    render(<ExercisesTab />)
    await screen.findByText('Incline Bench Press')

    fireEvent.change(screen.getByLabelText('Search exercises'), {
      target: { value: 'squat' },
    })

    await waitFor(
      () => expect(listUrls.some((u) => u.includes('q=squat'))).toBe(true),
      { timeout: 1500 },
    )
  })
})
