/**
 * @vitest-environment jsdom
 *
 * ProposalCard smoke (GYM_PLAN §2.7, §4). Prop-driven + callback-only — no fetch,
 * no store, no localStorage. Covers: a proposal fixture renders its rows + scheme,
 * the stale banner shows only when stale, Start/Edit/Dismiss fire their
 * callbacks, and the no-proposal branch renders the "Draft one for me" surface.
 */
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import { ProposalCard, setsRepsLabel } from '../ProposalCard'
import type { Proposal } from '@/lib/gym-client/plan-client'
import type { MuscleRegion } from '@/lib/fitness/muscles'

function fixture(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    forDate: '2026-07-10',
    status: 'proposed',
    rationale: 'Chest is due and your bench is trending up — hit it while fresh.',
    contextHash: 'abc',
    createdAt: '2026-07-10T08:00:00Z',
    payload: {
      name: 'Chest / Triceps',
      exercises: [
        {
          exerciseId: 'ex-bench',
          name: 'Bench Press',
          sets: 4,
          reps: 8,
          targetWeight: 170,
          supersetGroup: null,
          restSeconds: 120,
          why: 'Primary compound, staler than incline',
          region: 'chest' as MuscleRegion,
        },
        {
          exerciseId: 'ex-push',
          name: 'Tricep Pushdown',
          sets: 3,
          reps: 12,
          targetWeight: null,
          supersetGroup: null,
          restSeconds: 90,
          why: 'Isolation finisher',
          region: 'triceps' as MuscleRegion,
        },
      ],
    },
    ...over,
  }
}

const noop = vi.fn()
function handlers() {
  return {
    onDraft: vi.fn(),
    onStart: vi.fn(),
    onDismiss: vi.fn(),
    onRefresh: vi.fn(),
  }
}

describe('setsRepsLabel', () => {
  it('formats sets × reps with a weight when present', () => {
    expect(setsRepsLabel({ sets: 4, reps: 8, targetWeight: 170, targetDurationS: null })).toBe('4 × 8 reps · 170 lb')
  })
  it('converts canonical targets into the app-wide display unit', () => {
    expect(setsRepsLabel({ sets: 4, reps: 8, targetWeight: 170, targetDurationS: null }, 'kg')).toBe('4 × 8 reps · 77.1 kg')
  })
  it('drops the weight when absent', () => {
    expect(setsRepsLabel({ sets: 3, reps: 12, targetWeight: null, targetDurationS: null })).toBe('3 × 12 reps')
  })
  // #1879: a timed/bodyweight mobility exercise with no reps and no weight used to
  // drop its target entirely ("3 sets") instead of showing the duration it's
  // actually prescribed in.
  it('shows the duration in seconds when reps are null but a duration is set', () => {
    expect(setsRepsLabel({ sets: 3, reps: null, targetWeight: null, targetDurationS: 30 })).toBe('3 × 30s')
  })
  it('falls back to a set count when neither reps nor duration are set', () => {
    expect(setsRepsLabel({ sets: 4, reps: null, targetWeight: null, targetDurationS: null })).toBe('4 sets')
  })
})

describe('ProposalCard (proposal present)', () => {
  it('renders the name, each exercise row + scheme, and no stale banner when fresh', () => {
    render(<ProposalCard proposal={fixture()} busy={null} {...handlers()} />)

    expect(screen.getByText('Chest / Triceps')).toBeInTheDocument()
    expect(screen.getByText('Bench Press')).toBeInTheDocument()
    expect(screen.getByText('4 × 8 reps · 170 lb')).toBeInTheDocument()
    expect(screen.getByText('Tricep Pushdown')).toBeInTheDocument()
    expect(screen.getByText('3 × 12 reps')).toBeInTheDocument()
    // the per-exercise "why" sub-line
    expect(screen.getByText('Primary compound, staler than incline')).toBeInTheDocument()
    // fresh → no stale banner
    expect(screen.queryByText(/Things changed/i)).toBeNull()
  })

  it('uses the proposal display unit without mutating its canonical target', () => {
    const proposal = fixture({ weightUnit: 'kg' })
    render(<ProposalCard proposal={proposal} busy={null} {...handlers()} />)
    expect(screen.getByText('4 × 8 reps · 77.1 kg')).toBeInTheDocument()
    expect(proposal.payload.exercises[0]!.targetWeight).toBe(170)
  })

  it('shows exact warm-up sets separately from working sets and normalizes a lowercase stored name', () => {
    const proposal = fixture()
    proposal.payload.exercises[0]!.name = 'dumbbell bench press'
    proposal.payload.exercises[0]!.setPrescriptions = [
      { setType: 'warmup', targetWeight: 45, reps: 10, targetDurationS: null, targetRpe: 4, restSeconds: 45, side: null },
      { setType: 'warmup', targetWeight: 95, reps: 5, targetDurationS: null, targetRpe: 5, restSeconds: 60, side: null },
      { setType: 'normal', targetWeight: 135, reps: 8, targetDurationS: null, targetRpe: 8, restSeconds: 120, side: null },
      { setType: 'normal', targetWeight: 135, reps: 8, targetDurationS: null, targetRpe: 8, restSeconds: 120, side: null },
      { setType: 'failure', targetWeight: 135, reps: 6, targetDurationS: null, targetRpe: 10, restSeconds: 150, side: null },
    ]

    render(<ProposalCard proposal={proposal} busy={null} {...handlers()} />)

    expect(screen.getByText('Dumbbell Bench Press')).toBeInTheDocument()
    expect(screen.getByText(/Warm-up sets \(2\):/)).toHaveTextContent('45 lb · 10 reps')
    expect(screen.getByText(/Working sets \(3\):/)).toHaveTextContent('Failure · 135 lb · 6 reps')
  })

  it('normalizes an all-lowercase generated workout name for display', () => {
    const proposal = fixture()
    proposal.payload.name = 'upper body / pull focus'
    render(<ProposalCard proposal={proposal} busy={null} {...handlers()} />)
    expect(screen.getByText('Upper Body / Pull Focus')).toBeInTheDocument()
  })

  it('never renders Shuffle', () => {
    render(<ProposalCard proposal={fixture()} busy={null} {...handlers()} />)
    expect(screen.queryByLabelText('Shuffle exercises')).not.toBeInTheDocument()
  })

  it('shows the stale banner + fires onRefresh when stale', () => {
    const h = handlers()
    render(<ProposalCard proposal={fixture({ stale: true })} busy={null} {...h} />)
    expect(screen.getByText(/Things changed since this was drafted/i)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Refresh proposal'))
    expect(h.onRefresh).toHaveBeenCalledTimes(1)
  })

  it('Start / Dismiss fire their callbacks', () => {
    const h = handlers()
    render(<ProposalCard proposal={fixture()} busy={null} {...h} />)

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(h.onStart).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByLabelText('Dismiss proposal'))
    expect(h.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('disables the actions while busy', () => {
    render(<ProposalCard proposal={fixture()} busy="start" {...handlers()} />)
    expect(screen.getByRole('button', { name: /Starting/i })).toBeDisabled()
    expect(screen.getByLabelText('Dismiss proposal')).toBeDisabled()
  })
})

describe('ProposalCard (no proposal → draft surface)', () => {
  it('renders the "Draft one for me" affordance and fires onDraft with the focus', () => {
    const h = handlers()
    render(<ProposalCard proposal={null} busy={null} {...h} onStart={noop} />)

    const btn = screen.getByRole('button', { name: /Draft one for me/i })
    expect(btn).toBeInTheDocument()

    const input = screen.getByLabelText('Optional focus for the draft')
    fireEvent.change(input, { target: { value: 'legs but easy on knees' } })
    fireEvent.click(btn)
    expect(h.onDraft).toHaveBeenCalledWith('legs but easy on knees')
  })

  it('shows the drafting skeleton when busy=draft', () => {
    render(<ProposalCard proposal={null} busy="draft" {...handlers()} />)
    expect(screen.getByText(/Drafting/i)).toBeInTheDocument()
    // The draft button is replaced by the skeleton while drafting.
    expect(screen.queryByRole('button', { name: /Draft one for me/i })).toBeNull()
  })
})
