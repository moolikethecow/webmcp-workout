/**
 * RecordsBlock null-handling smoke test — the records payload is heavily
 * nullable (fresh custom exercises, assisted movements excluded from e1RM) and
 * the block must never crash or render "NaN"/"null". Asserts:
 *   - all-null records → em-dashes + "no records yet" note
 *   - excludedFromE1rm → the e1RM tile shows the exclusion note, not a value
 *   - a populated record renders its value + unit
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'

import { RecordsBlock } from '../RecordsBlock'
import type { ExerciseRecords } from '@/lib/gym-client/types'

const EMPTY: ExerciseRecords = {
  bestWeight: null,
  bestE1rm: null,
  bestSetVolume: null,
  repMaxes: [],
  excludedFromE1rm: false,
}

describe('RecordsBlock', () => {
  it('renders em-dashes and a no-records note when every record is null', () => {
    render(<RecordsBlock records={EMPTY} />)
    expect(screen.getByText(/no records yet/i)).toBeInTheDocument()
    // Every value tile falls back to an em-dash, never "null" or "NaN".
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3)
    expect(screen.queryByText(/null|NaN/)).toBeNull()
  })

  it('shows the exclusion note instead of an e1RM value when excludedFromE1rm', () => {
    render(<RecordsBlock records={{ ...EMPTY, excludedFromE1rm: true }} />)
    expect(screen.getByText(/e1RM not computed for assisted movements/i)).toBeInTheDocument()
  })

  it('renders a populated record with its value + unit and rep-max rows', () => {
    const records: ExerciseRecords = {
      bestWeight: { value: 225, unit: 'lb', reps: 5, date: '2026-06-01' },
      bestE1rm: { value: 253, unit: 'lb', weight: 225, reps: 5, date: '2026-06-01' },
      bestSetVolume: { value: 1125, unit: 'lb', weight: 225, reps: 5, date: '2026-06-01' },
      repMaxes: [{ reps: 5, weight: 225, unit: 'lb', date: '2026-06-01' }],
      excludedFromE1rm: false,
    }
    render(<RecordsBlock records={records} />)
    // "225 lb" appears in both the best-weight tile and the 5RM row — assert ≥1.
    expect(screen.getAllByText('225 lb').length).toBeGreaterThanOrEqual(1)
    // The e1RM value is unique to its tile.
    expect(screen.getByText('253 lb')).toBeInTheDocument()
    expect(screen.getByText('5RM')).toBeInTheDocument()
    // No records-empty note when data exists.
    expect(screen.queryByText(/no records yet/i)).toBeNull()
  })

  it('renders timed and distance records from the canonical record shape', () => {
    render(
      <RecordsBlock
        distanceUnit="km"
        records={{
          ...EMPTY,
          bestDuration: { value: 90, date: '2026-06-01' },
          bestDistance: { value: 1500, paceSecPerM: 0.3, date: '2026-06-01' },
        }}
      />,
    )

    expect(screen.getByText('1:30')).toBeInTheDocument()
    expect(screen.getByText('1.5 km')).toBeInTheDocument()
    expect(screen.getByText(/5:00 min\/km/)).toBeInTheDocument()
  })

  it('labels load records per side while keeping logical-set volume total', () => {
    render(
      <RecordsBlock
        perSide
        records={{
          bestWeight: { value: 42.5, unit: 'lb', reps: 10, date: '2026-07-01' },
          bestE1rm: { value: 56.7, unit: 'lb', weight: 42.5, reps: 10, date: '2026-07-01' },
          bestSetVolume: { value: 850, unit: 'lb', weight: 42.5, reps: 10, date: '2026-07-01' },
          repMaxes: [{ reps: 10, weight: 42.5, unit: 'lb', date: '2026-07-01' }],
          excludedFromE1rm: false,
        }}
      />,
    )

    expect(screen.getAllByText('42.5 lb/side').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('56.7 lb/side')).toBeInTheDocument()
    expect(screen.getByText('850 lb')).toBeInTheDocument()
  })
})
