/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { FinishSheet } from '../FinishSheet'
import type { FinishSummary } from '../store-contract'

const mockSaveAsTemplate = vi.hoisted(() => vi.fn())
vi.mock('../templates-fetch', () => ({
  saveWorkoutAsTemplate: mockSaveAsTemplate,
  applyTemplateUpdate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function summaryWith(over: Partial<FinishSummary> = {}): FinishSummary {
  return {
    durationSeconds: 900,
    totalVolumeLb: 2_205,
    totalVolume: 1_000,
    weightUnit: 'kg',
    setsCompleted: 3,
    exercisesCompleted: 1,
    prs: [],
    habitLogged: false,
    templateDiff: { verdict: 'values_changed', canUpdate: true },
    sourceTemplate: null,
    ...over,
  }
}

describe('FinishSheet display unit', () => {
  it('renders converted volume and PR values from the finish response', () => {
    const summary: FinishSummary = {
      durationSeconds: 900,
      totalVolumeLb: 2_205,
      totalVolume: 1_000,
      weightUnit: 'kg',
      setsCompleted: 3,
      exercisesCompleted: 1,
      prs: [
        {
          exerciseName: 'Squat',
          kind: 'weight',
          value: 100,
          unit: 'kg',
          prev: 90,
        },
      ],
      habitLogged: false,
      templateDiff: { verdict: 'unchanged', canUpdate: false },
      sourceTemplate: null,
    }

    render(
      <FinishSheet
        workoutId="w1"
        workoutName="Leg day"
        summary={summary}
        hadTemplate
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('1,000 kg')).toBeInTheDocument()
    expect(screen.getByText('100 kg')).toBeInTheDocument()
    expect(screen.getByText(/from 90 kg/)).toBeInTheDocument()
    expect(screen.queryByText(/2,205 lb/)).toBeNull()
  })
})

describe('FinishSheet records list', () => {
  it('condenses one exercise into one row, title-cases the name, and headlines by exercise count', () => {
    render(
      <FinishSheet
        workoutId="w1"
        workoutName="Upper A"
        summary={summaryWith({
          prs: [
            { exerciseName: 'lever bent-over row with v-bar', kind: 'weight', value: 90, unit: 'lb', prev: 80 },
            { exerciseName: 'lever bent-over row with v-bar', kind: 'e1rm', value: 120, unit: 'lb', prev: 110 },
            { exerciseName: 'lever bent-over row with v-bar', kind: 'volume', value: 900, unit: 'lb', prev: 850 },
            { exerciseName: 'lever bent-over row with v-bar', kind: 'reps', value: 10, unit: 'reps', prev: 8 },
          ],
        })}
        hadTemplate
        onClose={vi.fn()}
      />,
    )

    // One row for the exercise (title-cased), not four.
    expect(screen.getAllByText('Lever Bent-Over Row With V-Bar')).toHaveLength(1)
    // Headline reflects the exercise count, not the per-kind badge count.
    expect(screen.getByText('New personal record')).toBeInTheDocument()
    // All four record kinds still show up, inline on that one row.
    expect(screen.getByText('Top weight')).toBeInTheDocument()
    expect(screen.getByText('Est. 1RM')).toBeInTheDocument()
    expect(screen.getByText('Best set')).toBeInTheDocument()
    expect(screen.getByText('Most reps')).toBeInTheDocument()
  })

  it('calls out a debut exercise as a first log instead of a new record', () => {
    render(
      <FinishSheet
        workoutId="w1"
        workoutName="Upper A"
        summary={summaryWith({
          prs: [
            { exerciseName: 'Cable Fly', kind: 'weight', value: 40, unit: 'lb', prev: null, isDebut: true },
            { exerciseName: 'Cable Fly', kind: 'e1rm', value: 45, unit: 'lb', prev: null, isDebut: true },
          ],
        })}
        hadTemplate
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Logged for the first time')).toBeInTheDocument()
    expect(screen.queryByText(/new record/i)).toBeNull()
  })
})

describe('FinishSheet habit line', () => {
  it('renders a single checkmark next to "Gym habit logged"', () => {
    render(
      <FinishSheet
        workoutId="w1"
        workoutName="Upper A"
        summary={summaryWith({ habitLogged: true })}
        hadTemplate
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Gym habit logged')).toBeInTheDocument()
    expect(screen.queryByText(/✓/)).toBeNull()
  })
})

describe('FinishSheet template branching', () => {
  beforeEach(() => {
    mockSaveAsTemplate.mockReset().mockResolvedValue({ id: 'tpl-2' })
  })

  it('offers "Save as new" on a deviated template session and carries progression by default', async () => {
    render(
      <FinishSheet
        workoutId="w1"
        workoutName="Leg day"
        summary={summaryWith({
          sourceTemplate: { name: 'Leg Day A', progressionExercises: 2 },
        })}
        hadTemplate
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save as new' }))
    // The offer names the source template and how much carries over.
    expect(screen.getByText(/Carry over 2 progression rules from Leg Day A/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(mockSaveAsTemplate).toHaveBeenCalledWith('w1', 'Leg day', { carryProgression: true }),
    )
  })

  it('honours declining the progression carry-over', async () => {
    render(
      <FinishSheet
        workoutId="w1"
        workoutName="Leg day"
        summary={summaryWith({
          sourceTemplate: { name: 'Leg Day A', progressionExercises: 1 },
        })}
        hadTemplate
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save as new' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(mockSaveAsTemplate).toHaveBeenCalledWith('w1', 'Leg day', { carryProgression: false }),
    )
  })

  it('does not offer a carry-over when the session had no template policies', () => {
    render(
      <FinishSheet
        workoutId="w1"
        workoutName="Freestyle"
        summary={summaryWith({ templateDiff: { verdict: 'unchanged', canUpdate: false } })}
        hadTemplate={false}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Save this workout as a template?')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
