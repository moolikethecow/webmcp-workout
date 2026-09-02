/**
 * @vitest-environment jsdom
 *
 * SetTable component smoke test (GYM_PLAN §4, §3a). SetTable is a pure prop-driven
 * component (no store/localStorage dependency), so this exercises it directly with
 * fixtures + spy callbacks. Covers:
 *   - renders the per-tracks fields (weight_reps → weight + reps inputs; reps → reps only)
 *   - shows the previous-session ghost as the input PLACEHOLDER on an untouched row
 *   - ✓ fires completeSet with the exercise + set ids (the store does the commit)
 *
 * Queries are within()-scoped to a row; no real timers; no mirror dependency.
 */
import { render, screen, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import { SetTable } from '../SetTable'
import type { ActiveExercise, ActiveSet } from '@/lib/gym-client/active-types'
import { EMPTY_GRIP } from '@/lib/gym/grip'

function mkSet(over: Partial<ActiveSet> = {}): ActiveSet {
  return {
    clientSetId: 's1',
    setNumber: 1,
    setType: 'normal',
    weight: null,
    weightUnit: 'lb',
    reps: null,
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

const noop = () => {}
const noChain = () => []

describe('SetTable per-tracks rendering', () => {
  it('renders weight + reps inputs for a weight_reps exercise', () => {
    render(
      <SetTable
        exercise={mkExercise({ tracks: 'weight_reps' })}
        onCompleteSet={noop}
        onDeleteSet={noop}
        onCycleSetType={noop}
        onUpdateSetRest={noop}
        buildChain={noChain}
      />,
    )
    expect(screen.getByLabelText('Set 1 weight')).toBeInTheDocument()
    expect(screen.getByLabelText('Set 1 reps')).toBeInTheDocument()
  })

  it('shows a × separator between the weight and reps fields', () => {
    render(
      <SetTable
        exercise={mkExercise({ tracks: 'weight_reps' })}
        onCompleteSet={noop}
        onDeleteSet={noop}
        onCycleSetType={noop}
        onUpdateSetRest={noop}
        buildChain={noChain}
      />,
    )
    expect(screen.getByText('×')).toBeInTheDocument()
  })

  it('does not show a × separator for a reps-only exercise', () => {
    render(
      <SetTable
        exercise={mkExercise({ tracks: 'reps' })}
        onCompleteSet={noop}
        onDeleteSet={noop}
        onCycleSetType={noop}
        onUpdateSetRest={noop}
        buildChain={noChain}
      />,
    )
    expect(screen.queryByText('×')).toBeNull()
  })

  it('renders ONLY a reps input for a reps-tracks exercise', () => {
    render(
      <SetTable
        exercise={mkExercise({ tracks: 'reps' })}
        onCompleteSet={noop}
        onDeleteSet={noop}
        onCycleSetType={noop}
        onUpdateSetRest={noop}
        buildChain={noChain}
      />,
    )
    expect(screen.getByLabelText('Set 1 reps')).toBeInTheDocument()
    expect(screen.queryByLabelText('Set 1 weight')).toBeNull()
  })

  it('labels per-side hold rows round + side, never bare L/R (§10b.2, #1840)', () => {
    // Two rounds of a unilateral hold (e.g. a side plank programmed 2×30s per
    // side) — a bare "L"/"R" chip on every row would be indistinguishable
    // between rounds; the chip must read 1L/1R/2L/2R like Split-mode strength.
    const round1 = crypto.randomUUID()
    const round2 = crypto.randomUUID()
    render(
      <SetTable
        exercise={mkExercise({
          tracks: 'time',
          perSide: true,
          sets: [
            mkSet({ clientSetId: 's1L', logicalSetId: round1, setNumber: 1, side: 'left' }),
            mkSet({ clientSetId: 's1R', logicalSetId: round1, setNumber: 2, side: 'right' }),
            mkSet({ clientSetId: 's2L', logicalSetId: round2, setNumber: 3, side: 'left' }),
            mkSet({ clientSetId: 's2R', logicalSetId: round2, setNumber: 4, side: 'right' }),
          ],
        })}
        onCompleteSet={noop}
        onDeleteSet={noop}
        onCycleSetType={noop}
        onUpdateSetRest={noop}
        buildChain={noChain}
      />,
    )
    expect(screen.getByText('Time/side')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set 1 (left) — tag' })).toHaveTextContent('1L')
    expect(screen.getByRole('button', { name: 'Set 1 (right) — tag' })).toHaveTextContent('1R')
    expect(screen.getByRole('button', { name: 'Set 2 (left) — tag' })).toHaveTextContent('2L')
    expect(screen.getByRole('button', { name: 'Set 2 (right) — tag' })).toHaveTextContent('2R')
  })

  it('labels per-side strength load per side and numbers Split rows as one round', () => {
    const logicalSetId = crypto.randomUUID()
    render(
      <SetTable
        exercise={mkExercise({
          loadBasis: 'per_side',
          sets: [
            mkSet({ clientSetId: 'sL', logicalSetId, setNumber: 1, side: 'left' }),
            mkSet({ clientSetId: 'sR', logicalSetId, setNumber: 2, side: 'right' }),
          ],
        })}
        onCompleteSet={noop}
        onDeleteSet={noop}
        onCycleSetType={noop}
        onUpdateSetRest={noop}
        buildChain={noChain}
      />,
    )

    expect(screen.getByText('Weight/side (lb)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set 1 (left) — tag' })).toHaveTextContent('1L')
    expect(screen.getByRole('button', { name: 'Set 1 (right) — tag' })).toHaveTextContent('1R')
  })

  it('keeps L/R visible when Split rows carry a warm-up tag', () => {
    const logicalSetId = crypto.randomUUID()
    render(
      <SetTable
        exercise={mkExercise({
          loadBasis: 'per_side',
          sets: [
            mkSet({ clientSetId: 'wL', logicalSetId, setNumber: 1, setType: 'warmup', side: 'left' }),
            mkSet({ clientSetId: 'wR', logicalSetId, setNumber: 2, setType: 'warmup', side: 'right' }),
          ],
        })}
        onCompleteSet={noop}
        onDeleteSet={noop}
        onCycleSetType={noop}
        onUpdateSetRest={noop}
        buildChain={noChain}
      />,
    )

    expect(screen.getByRole('button', { name: 'Set 1 (left) (Warm-up) — tag' })).toHaveTextContent('WL')
    expect(screen.getByRole('button', { name: 'Set 1 (right) (Warm-up) — tag' })).toHaveTextContent('WR')
  })

  it('shows the previous-session value as the ghost placeholder on an untouched row', () => {
    const exercise = mkExercise({
      previous: [{ setNumber: 1, weight: 185, unit: 'lb', reps: 8, durationS: null, distanceM: null }],
      sets: [mkSet({ weight: null, reps: null })],
    })
    render(
      <SetTable exercise={exercise} onCompleteSet={noop} onDeleteSet={noop} onCycleSetType={noop} onUpdateSetRest={noop} buildChain={noChain} />,
    )
    const weight = screen.getByLabelText('Set 1 weight') as HTMLInputElement
    const reps = screen.getByLabelText('Set 1 reps') as HTMLInputElement
    expect(weight.value).toBe('') // untouched → empty value
    expect(weight.placeholder).toBe('185') // ghost as placeholder
    expect(reps.placeholder).toBe('8')
  })

  it('renders the target nudge as a single tooltip trigger inside the Previous cell', () => {
    const exercise = mkExercise({
      previous: [{ setNumber: 1, weight: 185, unit: 'lb', reps: 8, durationS: null, distanceM: null }],
      targets: [{ setNumber: 1, setType: 'normal', weight: 190, reps: 8, side: null }],
      sets: [mkSet({ weight: null, reps: null })],
    })
    render(
      <SetTable exercise={exercise} onCompleteSet={noop} onDeleteSet={noop} onCycleSetType={noop} onUpdateSetRest={noop} buildChain={noChain} />,
    )
    const row = screen.getByRole('row')
    const nudge = within(row).getByText('→ 190×8')
    // Same cell as the ghost — the pair must stay inside the row's grid.
    expect(within(row).getByText('185 × 8')?.parentElement).toBe(nudge.parentElement)
    expect(nudge).not.toHaveAttribute('title')
    expect(nudge.parentElement).not.toHaveAttribute('title')
    expect(nudge).not.toHaveStyle({ cursor: 'help' })
  })

  it('explains a reps-only target hint in plain language', () => {
    const exercise = mkExercise({
      previous: [{ setNumber: 1, weight: 0, unit: 'lb', reps: 10, durationS: null, distanceM: null }],
      targets: [{ setNumber: 1, setType: 'normal', reps: 12, side: null }],
      sets: [mkSet({ weight: null, reps: null })],
    })
    render(
      <SetTable exercise={exercise} onCompleteSet={noop} onDeleteSet={noop} onCycleSetType={noop} onUpdateSetRest={noop} buildChain={noChain} />,
    )

    expect(screen.getByText('→ ×12')).not.toHaveAttribute('title')
  })

  it('leaves a new warm-up blank while keeping working ghosts ordinally aligned', () => {
    const previous = [
      { setNumber: 1, setType: 'normal', weight: 185, unit: 'lb', reps: 8, durationS: null, distanceM: null },
      { setNumber: 2, setType: 'normal', weight: 180, unit: 'lb', reps: 9, durationS: null, distanceM: null },
    ] as Array<ActiveExercise['previous'][number] & { setType: string }>
    const exercise = mkExercise({
      previous,
      targets: [
        { setNumber: 1, setType: 'normal', weight: 190, reps: 8 },
        { setNumber: 2, setType: 'normal', weight: 190, reps: 8 },
      ],
      sets: [
        mkSet({ clientSetId: 'warmup', setNumber: 1, setType: 'warmup' }),
        mkSet({ clientSetId: 'work-1', setNumber: 2 }),
        mkSet({ clientSetId: 'work-2', setNumber: 3 }),
      ],
    })

    render(
      <SetTable exercise={exercise} onCompleteSet={noop} onDeleteSet={noop} onCycleSetType={noop} onUpdateSetRest={noop} buildChain={noChain} />,
    )

    expect((screen.getByLabelText('Set 1 weight') as HTMLInputElement).placeholder).toBe('')
    expect((screen.getByLabelText('Set 1 reps') as HTMLInputElement).placeholder).toBe('')
    expect((screen.getByLabelText('Set 2 weight') as HTMLInputElement).placeholder).toBe('185')
    expect((screen.getByLabelText('Set 2 reps') as HTMLInputElement).placeholder).toBe('8')
    expect((screen.getByLabelText('Set 3 weight') as HTMLInputElement).placeholder).toBe('180')
    expect((screen.getByLabelText('Set 3 reps') as HTMLInputElement).placeholder).toBe('9')
  })
})

describe('SetTable ✓ completes the set', () => {
  it('fires completeSet with the exercise + set ids when ✓ is tapped', () => {
    const onCompleteSet = vi.fn()
    const exercise = mkExercise({
      previous: [{ setNumber: 1, weight: 185, unit: 'lb', reps: 8, durationS: null, distanceM: null }],
      sets: [mkSet({ clientSetId: 's1', weight: null, reps: null })],
    })
    render(
      <SetTable exercise={exercise} onCompleteSet={onCompleteSet} onDeleteSet={noop} onCycleSetType={noop} onUpdateSetRest={noop} buildChain={noChain} />,
    )
    fireEvent.click(screen.getByLabelText('Complete set 1'))
    expect(onCompleteSet).toHaveBeenCalledWith('we1', 's1')
  })

  it('renders committed values (not placeholders) once a set carries them', () => {
    const exercise = mkExercise({ sets: [mkSet({ weight: 225, reps: 3, completed: true })] })
    render(
      <SetTable exercise={exercise} onCompleteSet={noop} onDeleteSet={noop} onCycleSetType={noop} onUpdateSetRest={noop} buildChain={noChain} />,
    )
    expect((screen.getByLabelText('Set 1 weight') as HTMLInputElement).value).toBe('225')
    expect((screen.getByLabelText('Set 1 reps') as HTMLInputElement).value).toBe('3')
  })

  it('shows a persistent RPE badge on the reps field once a set carries an RPE', () => {
    const exercise = mkExercise({ sets: [mkSet({ weight: 225, reps: 3, rpe: 8.5, completed: true })] })
    render(
      <SetTable exercise={exercise} onCompleteSet={noop} onDeleteSet={noop} onCycleSetType={noop} onUpdateSetRest={noop} buildChain={noChain} />,
    )
    expect(screen.getByLabelText('Set 1 reps, RPE 8.5')).toBeInTheDocument()
    expect(screen.getByTitle('RPE 8.5')).toBeInTheDocument()
  })

  it('shows no RPE badge when the set has no RPE logged', () => {
    const exercise = mkExercise({ sets: [mkSet({ weight: 225, reps: 3, rpe: null })] })
    render(
      <SetTable exercise={exercise} onCompleteSet={noop} onDeleteSet={noop} onCycleSetType={noop} onUpdateSetRest={noop} buildChain={noChain} />,
    )
    expect(screen.queryByTitle(/RPE/)).toBeNull()
  })
})

describe('SetTable tag menu', () => {
  it('does not clip the tag menu behind the row when opened (#1471)', () => {
    render(
      <SetTable exercise={mkExercise()} onCompleteSet={noop} onDeleteSet={noop} onCycleSetType={noop} onUpdateSetRest={noop} buildChain={noChain} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set 1 — tag' }))
    expect(screen.getByRole('menu', { name: 'Set type' })).toBeInTheDocument()
    const rowWrapper = screen.getByRole('row').parentElement as HTMLElement
    expect(rowWrapper.style.overflow).not.toBe('hidden')
  })
})

describe('SetTable per-set rest', () => {
  it('sets a preset override from the clock picker', () => {
    const onUpdateSetRest = vi.fn()
    render(
      <SetTable
        exercise={mkExercise({ restSeconds: 120, sets: [mkSet({ restSeconds: null })] })}
        onCompleteSet={noop}
        onDeleteSet={noop}
        onCycleSetType={noop}
        onUpdateSetRest={onUpdateSetRest}
        buildChain={noChain}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set 1 rest: inherit (2:00)' }))
    fireEvent.click(screen.getByRole('button', { name: '1:30' }))
    expect(onUpdateSetRest).toHaveBeenCalledWith('s1', 90)
  })

  it('returns an overridden set to inherited rest', () => {
    const onUpdateSetRest = vi.fn()
    render(
      <SetTable
        exercise={mkExercise({ restSeconds: 120, sets: [mkSet({ restSeconds: 90 })] })}
        onCompleteSet={noop}
        onDeleteSet={noop}
        onCycleSetType={noop}
        onUpdateSetRest={onUpdateSetRest}
        buildChain={noChain}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set 1 rest: 1:30' }))
    fireEvent.click(screen.getByRole('button', { name: /Inherit/ }))
    expect(onUpdateSetRest).toHaveBeenCalledWith('s1', null)
  })
})
