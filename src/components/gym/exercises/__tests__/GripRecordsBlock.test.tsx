/**
 * Per-handle bests on the exercise detail sheet (2026-08-31).
 *
 * A wide-grip pulldown and one on the MAG handle are not equally hard, so a
 * single "best set" quietly rewards whichever was easier.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { GripRecordsSummary } from '@/lib/gym-client/types'
import { GripRecordsBlock } from '../GripRecordsBlock'

const records = (over: Partial<GripRecordsSummary['records']> = {}) => ({
  bestWeight: null,
  bestE1rm: null,
  bestSetVolume: null,
  repMaxes: [],
  excludedFromE1rm: false,
  bestDuration: null,
  bestDistance: null,
  ...over,
})

const group = (over: Partial<GripRecordsSummary> = {}): GripRecordsSummary => ({
  key: 'wide|pronated|lat_bar',
  label: 'Wide overhand · Lat bar',
  sets: 48,
  sessions: 12,
  records: records({ bestWeight: { value: 140, unit: 'lb', reps: 10, date: '2026-08-01' } }),
  ...over,
})

describe('GripRecordsBlock', () => {
  // Most exercises are done one way, and every set logged before grip existed
  // has no handle recorded. An empty "no grip data" panel would be noise on
  // almost every exercise in the catalog.
  it.each([[undefined], [[]]])('renders nothing when there is nothing to compare (%s)', (v) => {
    const { container } = render(<GripRecordsBlock gripRecords={v as GripRecordsSummary[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a best per handle with its sample size', () => {
    render(<GripRecordsBlock gripRecords={[group()]} />)
    expect(screen.getByText('Wide overhand · Lat bar')).toBeInTheDocument()
    expect(screen.getByText('140 lb × 10')).toBeInTheDocument()
    expect(screen.getByText('48 sets · 12 sessions')).toBeInTheDocument()
  })

  it('marks the per-side unit so a unilateral best is not read as total', () => {
    render(<GripRecordsBlock gripRecords={[group()]} perSide />)
    expect(screen.getByText('140 lb/side × 10')).toBeInTheDocument()
  })

  // Real work, honestly not comparable handle-to-handle — it should read as
  // that rather than as a handle called "null".
  it('names the unrecorded bucket in words', () => {
    render(<GripRecordsBlock gripRecords={[group({ key: 'unspecified', label: null })]} />)
    expect(screen.getByText('Grip not recorded')).toBeInTheDocument()
  })

  it('states the bar, so a missing handle is explained rather than mysterious', () => {
    render(<GripRecordsBlock gripRecords={[group()]} />)
    expect(screen.getByText(/6 sets across 2 sessions/)).toBeInTheDocument()
  })

  it('falls back to a rep max when the track carries no weight', () => {
    render(
      <GripRecordsBlock
        gripRecords={[group({ records: records({ repMaxes: [{ reps: 12, weight: 0, unit: 'lb', date: '2026-08-01' }] }) })]}
      />,
    )
    expect(screen.getByText('12 reps')).toBeInTheDocument()
  })
})
