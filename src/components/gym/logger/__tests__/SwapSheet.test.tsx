/**
 * @vitest-environment jsdom
 *
 * SwapSheet smoke (GYM_PLAN §4 replace / §6). The deterministic alternatives fetch
 * (plan-client) + the catalog search hook (gym-client/fetch) are mocked, so this is
 * a pure render + interaction test: suggested alternatives render with their
 * freshness + muscle chips, and picking one calls
 * onPick(workoutExerciseId, newId, keepPrescription, newName) — the seam the
 * parent wires to store.replaceExercise. NO LLM path exists here. #1876: a slot
 * with a prescribed target asks "keep this as your target?" before committing;
 * with none it commits straight through (the existing behavior).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import type { AlternativesResponse } from '@/app/api/gym/exercises/alternatives/shape'

// ── mock the deterministic alternatives fetch ──────────────────────────────
const fetchAlternatives = vi.fn()
vi.mock('@/lib/gym-client/plan-client', () => ({
  fetchAlternatives: (...args: unknown[]) => fetchAlternatives(...args),
}))

// ── mock the catalog search hook (manual lane) ─────────────────────────────
vi.mock('@/lib/gym-client/fetch', () => ({
  useDebounced: (v: string) => v,
  useGymExercises: () => ({
    data: { exercises: [{ id: 'searched', name: 'Cable Crossover', primaryMuscle: 'chest', equipment: 'cable' }], total: 1 },
    loading: false,
    error: false,
  }),
}))

import { SwapSheet } from '../SwapSheet'

const alts: AlternativesResponse = {
  region: 'chest',
  regionLabel: 'Chest',
  alternatives: [
    {
      exerciseId: 'alt1',
      name: 'Incline DB Press',
      pattern: 'horizontal-push',
      region: 'chest',
      regionLabel: 'Chest',
      staleness: 42,
      daysSinceLast: 42,
      freshness: 'fresh · 6w since last',
    },
    {
      exerciseId: 'alt2',
      name: 'Dip',
      pattern: 'horizontal-push',
      region: 'chest',
      regionLabel: 'Chest',
      staleness: 60,
      daysSinceLast: null,
      freshness: 'new — never done',
    },
  ],
}

beforeEach(() => {
  fetchAlternatives.mockReset()
})

describe('SwapSheet', () => {
  it('renders deterministic alternatives with freshness + region chips', async () => {
    fetchAlternatives.mockResolvedValue(alts)
    render(
      <SwapSheet
        workoutExerciseId="we-1"
        sourceExerciseId="src"
        sourceName="Bench Press"
        sourceTracks="weight_reps"
        sourceTargets={[]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    // Fetched with the source id.
    expect(fetchAlternatives).toHaveBeenCalledWith('src', 8)

    await waitFor(() => expect(screen.getByText('Incline DB Press')).toBeInTheDocument())
    expect(screen.getByText('Dip')).toBeInTheDocument()
    expect(screen.getByText('fresh · 6w since last')).toBeInTheDocument()
    expect(screen.getByText('new — never done')).toBeInTheDocument()
    // same-muscles section label
    expect(screen.getByText(/Same muscles · Chest/i)).toBeInTheDocument()
  })

  it('picking an alternative with no prescribed target commits straight through', async () => {
    fetchAlternatives.mockResolvedValue(alts)
    const onPick = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    render(
      <SwapSheet
        workoutExerciseId="we-1"
        sourceExerciseId="src"
        sourceName="Bench Press"
        sourceTracks="weight_reps"
        sourceTargets={[]}
        onPick={onPick}
        onClose={onClose}
      />,
    )

    await waitFor(() => expect(screen.getByText('Incline DB Press')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Replace with Incline DB Press'))

    await waitFor(() => expect(onPick).toHaveBeenCalledWith('we-1', 'alt1', false, 'Incline DB Press'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('falls back to manual search, and a search pick also replaces', async () => {
    fetchAlternatives.mockResolvedValue({ region: null, regionLabel: null, alternatives: [] })
    const onPick = vi.fn().mockResolvedValue(undefined)
    render(
      <SwapSheet
        workoutExerciseId="we-1"
        sourceExerciseId="src"
        sourceName="Bench Press"
        sourceTracks="weight_reps"
        sourceTargets={[]}
        onPick={onPick}
        onClose={vi.fn()}
      />,
    )

    // No same-muscle alts → the manual-search toggle is offered.
    await waitFor(() =>
      expect(screen.getByText(/No same-muscle alternatives/i)).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: /Search all exercises instead/i }))

    // The mocked search hook returns Cable Crossover.
    const searchRow = await screen.findByLabelText('Replace with Cable Crossover')
    fireEvent.click(searchRow)
    await waitFor(() => expect(onPick).toHaveBeenCalledWith('we-1', 'searched', false, 'Cable Crossover'))
  })

  // #1876 — replacing a prescribed exercise asks before wiping the target.
  it('asks to keep the prescribed target when the slot has one, and honors the answer', async () => {
    fetchAlternatives.mockResolvedValue(alts)
    const onPick = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    render(
      <SwapSheet
        workoutExerciseId="we-1"
        sourceExerciseId="src"
        sourceName="Bent Over Row (Barbell)"
        sourceTracks="weight_reps"
        sourceTargets={[
          { setNumber: 1, setType: 'normal', weight: 105, reps: 10 },
          { setNumber: 2, setType: 'normal', weight: 105, reps: 10 },
          { setNumber: 3, setType: 'normal', weight: 105, reps: 10 },
        ]}
        onPick={onPick}
        onClose={onClose}
      />,
    )

    await waitFor(() => expect(screen.getByText('Incline DB Press')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Replace with Incline DB Press'))

    // Doesn't commit yet — asks first, with the prescribed summary in the prompt.
    expect(onPick).not.toHaveBeenCalled()
    expect(await screen.findByText(/3 sets · 105×10 top/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Keep as target' }))
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith('we-1', 'alt1', true, 'Incline DB Press'),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('"Start blank" replaces without carrying the prescribed target forward', async () => {
    fetchAlternatives.mockResolvedValue(alts)
    const onPick = vi.fn().mockResolvedValue(undefined)
    render(
      <SwapSheet
        workoutExerciseId="we-1"
        sourceExerciseId="src"
        sourceName="Bent Over Row (Barbell)"
        sourceTracks="weight_reps"
        sourceTargets={[{ setNumber: 1, setType: 'normal', weight: 105, reps: 10 }]}
        onPick={onPick}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByText('Incline DB Press')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Replace with Incline DB Press'))
    fireEvent.click(await screen.findByRole('button', { name: 'Start blank' }))

    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith('we-1', 'alt1', false, 'Incline DB Press'),
    )
  })
})
