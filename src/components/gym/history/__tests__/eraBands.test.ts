/**
 * eraBands (WeeklyBars.tsx): map program eras onto the 8-week bar axis. Only
 * real-template eras paint; a band spans the week columns its [firstDate, lastDate]
 * overlaps; the null-template (imported) run is deliberately left blank.
 */
import { describe, expect, it } from 'vitest'

import { eraBands } from '../WeeklyBars'
import type { ProgramEra, WeekBar } from '../history-client'

/** 8 consecutive Monday weeks starting 2026-06-01 (a Monday). */
const WEEKS: WeekBar[] = Array.from({ length: 8 }, (_, i) => {
  const monday = new Date('2026-06-01T00:00:00Z')
  monday.setUTCDate(monday.getUTCDate() + i * 7)
  return { weekStart: monday.toISOString().slice(0, 10), workouts: 0, volumeLb: 0 }
})

function era(o: Partial<ProgramEra>): ProgramEra {
  return {
    templateId: 't1',
    templateName: 'Day 1',
    firstDate: '2026-06-01T00:00:00Z',
    lastDate: '2026-06-01T00:00:00Z',
    sessions: 1,
    ...o,
  }
}

describe('eraBands', () => {
  it('maps a mid-window era to the overlapping week columns', () => {
    // Era spanning weeks index 2..4 (2026-06-15 .. 2026-06-29).
    const bands = eraBands(WEEKS, [
      era({ firstDate: '2026-06-15T00:00:00Z', lastDate: '2026-06-29T12:00:00Z' }),
    ])
    expect(bands).toHaveLength(1)
    expect(bands[0]!.startIdx).toBe(2)
    expect(bands[0]!.endIdx).toBe(4)
    expect(bands[0]!.label).toBe('DAY 1 era')
    expect(bands[0]!.wide).toBe(true) // spans ≥2 columns
  })

  it('skips the null-template (imported) era — no band clutter', () => {
    const bands = eraBands(WEEKS, [
      era({ templateId: null, templateName: null, firstDate: '2026-06-01T00:00:00Z', lastDate: '2026-07-20T00:00:00Z' }),
    ])
    expect(bands).toEqual([])
  })

  it('drops an era entirely outside the visible window', () => {
    const bands = eraBands(WEEKS, [
      era({ firstDate: '2025-01-01T00:00:00Z', lastDate: '2025-02-01T00:00:00Z' }),
    ])
    expect(bands).toEqual([])
  })

  it('a single-week era is narrow (no label)', () => {
    const bands = eraBands(WEEKS, [
      era({ firstDate: '2026-06-02T00:00:00Z', lastDate: '2026-06-03T00:00:00Z' }),
    ])
    expect(bands).toHaveLength(1)
    expect(bands[0]!.startIdx).toBe(0)
    expect(bands[0]!.endIdx).toBe(0)
    expect(bands[0]!.wide).toBe(false)
  })

  it('assigns distinct colors to consecutive bands', () => {
    const bands = eraBands(WEEKS, [
      era({ templateId: 'a', templateName: 'A', firstDate: '2026-06-01T00:00:00Z', lastDate: '2026-06-08T00:00:00Z' }),
      era({ templateId: 'b', templateName: 'B', firstDate: '2026-06-15T00:00:00Z', lastDate: '2026-06-22T00:00:00Z' }),
    ])
    expect(bands).toHaveLength(2)
    expect(bands[0]!.color).not.toBe(bands[1]!.color)
  })

  it('empty weeks → empty bands', () => {
    expect(eraBands([], [era({})])).toEqual([])
  })
})
