/**
 * @vitest-environment jsdom
 *
 * ActiveExerciseCard collapse-on-complete smoke test (GYM_PLAN §4). The card is
 * prop-driven; the only heavy dependency is ExerciseDetailSheet (self-fetches),
 * which is mocked to a stub so this stays a pure render test — no store, no
 * localStorage mirror, no network.
 *
 * Covers:
 *   - all sets completed → the card collapses to a one-line summary row
 *   - not-all-completed → the full set table renders (add-set affordance present)
 *   - tapping the collapsed row re-expands the card
 */
import { render, screen, fireEvent, within } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'

import type { ActiveExercise, ActiveSet } from '@/lib/gym-client/active-types'

// Stub the exercises barrel (ExerciseDetailSheet self-fetches — irrelevant here).
vi.mock('@/components/gym/exercises', () => ({
  ExerciseDetailSheet: ({ onExerciseChanged }: { onExerciseChanged?: (patch: { loadBasis: 'per_side' }) => void }) => (
    <button type="button" onClick={() => onExerciseChanged?.({ loadBasis: 'per_side' })}>
      Simulate load-basis save
    </button>
  ),
}))

import { ActiveExerciseCard } from '../ActiveExerciseCard'
import { EMPTY_GRIP } from '@/lib/gym/grip'

function mkSet(over: Partial<ActiveSet> = {}): ActiveSet {
  return {
    clientSetId: crypto.randomUUID(),
    setNumber: 1,
    setType: 'normal',
    weight: 170,
    weightUnit: 'lb',
    reps: 8,
    distanceM: null,
    durationS: null,
    rpe: null,
    side: null,
    completed: false,
    ...over,
    logicalSetId: over.logicalSetId ?? crypto.randomUUID(),
  }
}

function mkExercise(over: Partial<ActiveExercise> = {}): ActiveExercise {
  return {
    grip: EMPTY_GRIP,
    workoutExerciseId: 'we1',
    exerciseId: 'ex1',
    name: 'Bench Press',
    tracks: 'weight_reps',
    modality: 'strength',
    perSide: false,
    section: 'main',
    position: 0,
    supersetGroup: null,
    restSeconds: 120,
    preferredUnit: 'lb',
    notes: null,
    targets: [],
    ruleText: '',
    previous: [],
    sets: [mkSet()],
    ...over,
    loadBasis: over.loadBasis ?? 'total',
  }
}

const handlers = {
  onCompleteSet: vi.fn(),
  onAddSet: vi.fn(),
  onAddWarmupSet: vi.fn(),
  onDeleteSet: vi.fn(),
  onCycleSetType: vi.fn(),
  onUpdateSetRest: vi.fn(),
  onUpdateNotes: vi.fn(),
  onRemove: vi.fn(),
  onReplace: vi.fn(),
  onMoveUp: vi.fn(),
  onMoveDown: vi.fn(),
  onSideModeChange: vi.fn(),
  onExerciseLoadBasisChange: vi.fn(),
}

beforeEach(() => vi.clearAllMocks())

describe('ActiveExerciseCard collapse-on-complete', () => {
  it('renders the full table with an add-set row when sets are incomplete', () => {
    render(
      <ActiveExerciseCard
        exercise={mkExercise({ sets: [mkSet({ setNumber: 1, completed: false })] })}
        {...handlers}
      />,
    )
    // The full card exposes the ✓ + add-set affordance.
    expect(screen.getByLabelText('Complete set 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Add set to Bench Press')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Add warm-up set to Bench Press'))
    expect(handlers.onAddWarmupSet).toHaveBeenCalledWith('we1')
  })

  it('collapses to a one-line summary when every set is completed', () => {
    render(
      <ActiveExerciseCard
        exercise={mkExercise({
          sets: [
            mkSet({ setNumber: 1, weight: 170, reps: 8, completed: true }),
            mkSet({ setNumber: 2, weight: 165, reps: 8, completed: true }),
          ],
        })}
        {...handlers}
      />,
    )
    // Collapsed → the expand button carries the summary; no live ✓ / add-set row.
    const expand = screen.getByLabelText('Expand Bench Press')
    expect(within(expand).getByText(/2 sets · 170×8 top/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Add set to Bench Press')).toBeNull()
  })

  it('re-expands when the collapsed summary row is tapped', () => {
    render(
      <ActiveExerciseCard
        exercise={mkExercise({ sets: [mkSet({ setNumber: 1, completed: true })] })}
        {...handlers}
      />,
    )
    fireEvent.click(screen.getByLabelText('Expand Bench Press'))
    // Back to the full card.
    expect(screen.getByLabelText('Add set to Bench Press')).toBeInTheDocument()
  })

  it('offers accessible move controls while the workout is running', () => {
    render(
      <ActiveExerciseCard
        exercise={mkExercise()}
        canMoveUp
        canMoveDown
        {...handlers}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Move Bench Press up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move Bench Press down' }))
    expect(handlers.onMoveUp).toHaveBeenCalledWith('we1')
    expect(handlers.onMoveDown).toHaveBeenCalledWith('we1')
  })

  it('shows the per-side strength mode control and reports Split selection', () => {
    render(
      <ActiveExerciseCard
        exercise={mkExercise({ loadBasis: 'per_side' })}
        sideMode="both"
        {...handlers}
      />,
    )

    const group = screen.getByRole('group', { name: 'Bench Press side mode' })
    expect(screen.getByText('Applies to blank + future sets')).toBeInTheDocument()
    expect(within(group).getByRole('button', { name: 'Both' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(group).getByRole('button', { name: 'Split' }))
    expect(handlers.onSideModeChange).toHaveBeenCalledWith('we1', 'split')
  })

  it('refreshes the active workout after load basis changes in the detail sheet', () => {
    render(<ActiveExerciseCard exercise={mkExercise()} {...handlers} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Bench Press details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Simulate load-basis save' }))

    expect(handlers.onExerciseLoadBasisChange).toHaveBeenCalledWith('we1', 'per_side')
  })

  it('counts a completed Split pair as one collapsed set', () => {
    const logicalSetId = crypto.randomUUID()
    render(
      <ActiveExerciseCard
        exercise={mkExercise({
          loadBasis: 'per_side',
          sets: [
            mkSet({ setNumber: 1, logicalSetId, side: 'left', completed: true }),
            mkSet({ setNumber: 2, logicalSetId, side: 'right', completed: true }),
          ],
        })}
        {...handlers}
      />,
    )

    expect(within(screen.getByLabelText('Expand Bench Press')).getByText(/1 set ·/)).toBeInTheDocument()
  })
})
