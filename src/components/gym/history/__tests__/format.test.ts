/**
 * Pure date/format helpers for the History tab (components/gym/history/format.ts).
 * The load-bearing one is monthGrid (Monday-first, correct leading blanks + week
 * padding) — an off-by-one there puts every dot on the wrong square.
 */
import { describe, expect, it } from 'vitest'

import {
  duration,
  monthGrid,
  monthLabel,
  parseMonth,
  setValue,
  shiftMonth,
  trimNum,
  volume,
} from '../format'

describe('parseMonth', () => {
  it('splits YYYY-MM', () => {
    expect(parseMonth('2026-07')).toEqual({ year: 2026, month: 7 })
  })
})

describe('shiftMonth', () => {
  it('advances within a year', () => {
    expect(shiftMonth('2026-07', 1)).toBe('2026-08')
  })
  it('rolls forward across December', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  })
  it('rolls back across January', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  })
  it('multi-month jumps', () => {
    expect(shiftMonth('2026-07', -8)).toBe('2025-11')
  })
})

describe('monthLabel', () => {
  it('renders a friendly month + year', () => {
    expect(monthLabel('2026-07')).toBe('July 2026')
  })
})

describe('monthGrid', () => {
  it('July 2026 starts on a Wednesday → 2 leading blanks (Mon,Tue)', () => {
    // 2026-07-01 is a Wednesday. Monday-first index of Wed = 2.
    const cells = monthGrid('2026-07')
    expect(cells[0]).toEqual({ date: null, day: null })
    expect(cells[1]).toEqual({ date: null, day: null })
    expect(cells[2]).toEqual({ date: '2026-07-01', day: 1 })
  })

  it('has 31 real day cells for July and pads to a full week multiple', () => {
    const cells = monthGrid('2026-07')
    const real = cells.filter((c) => c.date != null)
    expect(real).toHaveLength(31)
    expect(cells.length % 7).toBe(0)
  })

  it('February 2026 (starts Sunday) → 6 leading blanks, 28 days', () => {
    // 2026-02-01 is a Sunday → Monday-first index 6.
    const cells = monthGrid('2026-02')
    expect(cells.slice(0, 6).every((c) => c.date == null)).toBe(true)
    expect(cells[6]).toEqual({ date: '2026-02-01', day: 1 })
    expect(cells.filter((c) => c.date != null)).toHaveLength(28)
  })
})

describe('duration', () => {
  it('formats hours + minutes', () => {
    expect(duration(4320)).toBe('1h 12m')
  })
  it('minutes only', () => {
    expect(duration(2880)).toBe('48m')
  })
  it('null / zero → dash', () => {
    expect(duration(null)).toBe('—')
    expect(duration(0)).toBe('—')
  })
})

describe('volume', () => {
  it('thousands-separated with lb suffix', () => {
    expect(volume(12340)).toBe('12,340 lb')
  })
  it('null / zero → dash', () => {
    expect(volume(0)).toBe('—')
    expect(volume(null)).toBe('—')
  })
})

describe('setValue', () => {
  it('weight × reps with unit', () => {
    expect(setValue(185, 5, 'lb')).toBe('185 lb × 5')
  })
  it('keeps decimals', () => {
    expect(setValue(62.5, 8, 'kg')).toBe('62.5 kg × 8')
  })
  it('bodyweight → reps only', () => {
    expect(setValue(null, 12, 'lb')).toBe('12 reps')
    expect(setValue(0, 12, 'lb')).toBe('12 reps')
  })
})

describe('trimNum', () => {
  it('drops trailing .0 but keeps real decimals', () => {
    expect(trimNum(185)).toBe('185')
    expect(trimNum(62.5)).toBe('62.5')
  })
})
