/**
 * The load-bearing PR/volume/chart math (lib/gym/records.ts). PURE — no DB, no LLM.
 * Covers every GYM_PLAN §3a exclusion + the mixed-unit rule, because a wrong record
 * is a wrong motivational surface.
 */
import { describe, it, expect } from 'vitest'

import {
  computeCharts,
  computeRecords,
  epley,
  toLb,
  type SetInput,
  type Tracks,
} from '../records'

/** Terse set-row builder (weight in its stored unit). */
function s(partial: Partial<SetInput> & { date: string }): SetInput {
  return {
    setType: 'normal',
    weight: null,
    unit: 'lb',
    reps: null,
    distanceM: null,
    durationS: null,
    ...partial,
  }
}

describe('epley', () => {
  it('matches training.ts formula weight × (1 + reps/30)', () => {
    expect(epley(100, 0)).toBe(100)
    expect(epley(100, 30)).toBe(200)
    expect(epley(225, 5)).toBeCloseTo(262.5, 5)
    expect(epley(315, 1)).toBeCloseTo(325.5, 5)
  })
})

describe('toLb', () => {
  it('passes lb through and converts kg by 2.20462', () => {
    expect(toLb(100, 'lb')).toBe(100)
    expect(toLb(100, 'kg')).toBeCloseTo(220.462, 3)
    expect(toLb(50, null)).toBe(50) // unknown unit treated as lb
  })
})

describe('computeRecords — weight_reps', () => {
  const tracks: Tracks = 'weight_reps'

  it('computes best weight, e1RM, set volume, and rep-max table', () => {
    const sets = [
      s({ date: '2026-01-01', weight: 185, reps: 5 }),
      s({ date: '2026-01-08', weight: 225, reps: 3 }),
      s({ date: '2026-01-15', weight: 205, reps: 5 }),
    ]
    const r = computeRecords(sets, tracks)
    expect(r.bestWeight).toEqual({ value: 225, unit: 'lb', reps: 3, date: '2026-01-08' })
    // e1RM: 205×(1+5/30)=239.17 vs 225×(1+3/30)=247.5 → 205×5? no, 247.5 wins.
    expect(r.bestE1rm?.value).toBeCloseTo(247.5, 3)
    expect(r.bestE1rm?.date).toBe('2026-01-08')
    // Best single-set volume: 205×5=1025 beats 185×5=925 and 225×3=675.
    expect(r.bestSetVolume?.value).toBe(1025)
    expect(r.excludedFromE1rm).toBe(false)
    // repMaxes: reps 3 → 225; reps 5 → 205 (heaviest at that rep count).
    expect(r.repMaxes).toEqual([
      { reps: 3, weight: 225, unit: 'lb', date: '2026-01-08' },
      { reps: 5, weight: 205, unit: 'lb', date: '2026-01-15' },
    ])
  })

  it('EXCLUDES warmup sets from every record', () => {
    const r = computeRecords(
      [
        s({ date: '2026-02-01', weight: 500, reps: 1, setType: 'warmup' }), // huge, ignored
        s({ date: '2026-02-01', weight: 200, reps: 5 }),
      ],
      tracks,
    )
    expect(r.bestWeight?.value).toBe(200)
    expect(r.bestE1rm?.weight).toBe(200)
    expect(r.repMaxes.some((rm) => rm.weight === 500)).toBe(false)
  })

  it('COUNTS drop and failure sets as working', () => {
    const r = computeRecords(
      [
        s({ date: '2026-03-01', weight: 135, reps: 8, setType: 'drop' }),
        s({ date: '2026-03-01', weight: 315, reps: 2, setType: 'failure' }),
      ],
      tracks,
    )
    expect(r.bestWeight?.value).toBe(315) // failure set counts
    expect(r.bestSetVolume?.value).toBe(1080) // 135×8 (drop) counts
  })

  it('ignores sets with reps<=0 or weight<=0 for weight records', () => {
    const r = computeRecords(
      [
        s({ date: '2026-04-01', weight: 0, reps: 5 }),
        s({ date: '2026-04-01', weight: 100, reps: 0 }),
        s({ date: '2026-04-01', weight: 135, reps: 10 }),
      ],
      tracks,
    )
    expect(r.bestWeight?.value).toBe(135)
    expect(r.repMaxes).toEqual([{ reps: 10, weight: 135, unit: 'lb', date: '2026-04-01' }])
  })

  it('mixes lb + kg rows → converts to lb and reports unit lb', () => {
    const r = computeRecords(
      [
        s({ date: '2026-05-01', weight: 100, reps: 5, unit: 'kg' }), // 220.462 lb
        s({ date: '2026-05-08', weight: 200, reps: 5, unit: 'lb' }),
      ],
      tracks,
    )
    // 100kg = 220.462lb beats 200lb.
    expect(r.bestWeight?.value).toBeCloseTo(220.462, 3)
    expect(r.bestWeight?.unit).toBe('lb')
    expect(r.bestSetVolume?.value).toBeCloseTo(1102.31, 2) // 220.462×5
  })

  it('caps the rep-max table at reps 1..12', () => {
    const r = computeRecords(
      [
        s({ date: '2026-06-01', weight: 95, reps: 15 }), // >12, excluded from table
        s({ date: '2026-06-01', weight: 135, reps: 12 }),
      ],
      tracks,
    )
    expect(r.repMaxes.map((rm) => rm.reps)).toEqual([12])
  })

  it('keeps weight/e1RM per-side while Both and paired L/R have equal logical-set volume', () => {
    const both = computeRecords([
      s({
        date: '2026-06-08',
        weight: 42.5,
        reps: 10,
        loadBasis: 'per_side',
        side: null,
        logicalSetId: 'both-round',
      }),
    ], tracks)
    const split = computeRecords([
      s({
        date: '2026-06-08',
        weight: 42.5,
        reps: 10,
        loadBasis: 'per_side',
        side: 'left',
        logicalSetId: 'split-round',
      }),
      s({
        date: '2026-06-08',
        weight: 42.5,
        reps: 10,
        loadBasis: 'per_side',
        side: 'right',
        logicalSetId: 'split-round',
      }),
    ], tracks)

    expect(both.bestWeight?.value).toBe(42.5)
    expect(split.bestWeight?.value).toBe(42.5)
    expect(both.bestE1rm?.value).toBeCloseTo(42.5 * (1 + 10 / 30), 5)
    expect(split.bestE1rm?.value).toBeCloseTo(both.bestE1rm!.value, 5)
    expect(both.bestSetVolume?.value).toBe(850)
    expect(split.bestSetVolume?.value).toBe(850)
  })
})

describe('computeRecords — weighted_bodyweight', () => {
  const tracks: Tracks = 'weighted_bodyweight'
  it('volume counts added weight, EXCLUDES e1RM, keeps bestWeight + repMaxes', () => {
    const r = computeRecords(
      [
        s({ date: '2026-07-01', weight: 45, reps: 5 }),
        s({ date: '2026-07-08', weight: 90, reps: 3 }),
      ],
      tracks,
    )
    expect(r.excludedFromE1rm).toBe(true)
    expect(r.bestE1rm).toBeNull()
    expect(r.bestWeight?.value).toBe(90) // added weight
    // best SINGLE-set volume: 90×3=270 beats 45×5=225 (added weight counts).
    expect(r.bestSetVolume?.value).toBe(270)
    expect(r.repMaxes.length).toBe(2)
  })
})

describe('computeRecords — assisted_bodyweight', () => {
  const tracks: Tracks = 'assisted_bodyweight'
  it('EXCLUDES volume AND e1RM; bestWeight = LEAST assistance', () => {
    const r = computeRecords(
      [
        s({ date: '2026-08-01', weight: 60, reps: 5 }), // more assistance
        s({ date: '2026-08-08', weight: 30, reps: 5 }), // less assistance = better
      ],
      tracks,
    )
    expect(r.excludedFromE1rm).toBe(true)
    expect(r.bestE1rm).toBeNull()
    expect(r.bestSetVolume).toBeNull()
    // least assistance = smallest stored positive weight.
    expect(r.bestWeight?.value).toBe(30)
    // rep-max table also uses least assistance (min).
    expect(r.repMaxes).toEqual([{ reps: 5, weight: 30, unit: 'lb', date: '2026-08-08' }])
  })
})

describe('computeRecords — reps only', () => {
  it('produces a max-reps table and no weight/e1RM/volume', () => {
    const r = computeRecords(
      [
        s({ date: '2026-09-01', reps: 12, setType: 'warmup' }), // warmup excluded
        s({ date: '2026-09-01', reps: 20 }),
        s({ date: '2026-09-08', reps: 25 }),
      ],
      'reps',
    )
    expect(r.bestWeight).toBeNull()
    expect(r.bestE1rm).toBeNull()
    expect(r.bestSetVolume).toBeNull()
    expect(r.excludedFromE1rm).toBe(true)
    // reps>12 land in the table only up to 12; 20 and 25 exceed the cap → no entries.
    // (rep-track "repMax" keeps the 1..12 cap like weight tracks.)
    expect(r.repMaxes).toEqual([])
  })

  it('records rep counts within 1..12 with weight 0', () => {
    const r = computeRecords([s({ date: '2026-09-01', reps: 8 })], 'reps')
    expect(r.repMaxes).toEqual([{ reps: 8, weight: 0, unit: 'lb', date: '2026-09-01' }])
  })
})

describe('computeRecords — time', () => {
  it('records the longest duration, warmup excluded', () => {
    const r = computeRecords(
      [
        s({ date: '2026-10-01', durationS: 300, setType: 'warmup' }),
        s({ date: '2026-10-01', durationS: 60 }),
        s({ date: '2026-10-08', durationS: 120 }),
      ],
      'time',
    )
    expect(r.bestDuration).toEqual({ value: 120, date: '2026-10-08' })
    expect(r.bestWeight).toBeNull()
    expect(r.excludedFromE1rm).toBe(true)
  })
})

describe('computeRecords — distance_time', () => {
  it('records the longest distance and its pace', () => {
    const r = computeRecords(
      [
        s({ date: '2026-11-01', distanceM: 5000, durationS: 1500 }), // 0.3 s/m
        s({ date: '2026-11-08', distanceM: 10000, durationS: 3600 }), // 0.36 s/m
      ],
      'distance_time',
    )
    expect(r.bestDistance?.value).toBe(10000)
    expect(r.bestDistance?.paceSecPerM).toBeCloseTo(0.36, 5)
    expect(r.bestDistance?.date).toBe('2026-11-08')
  })

  it('leaves pace null when no duration was logged', () => {
    const r = computeRecords([s({ date: '2026-11-01', distanceM: 4000 })], 'distance_time')
    expect(r.bestDistance?.paceSecPerM).toBeNull()
  })
})

describe('computeCharts', () => {
  it('aggregates e1RM / volume / bestSet per workout day, chronological', () => {
    const sets = [
      // day 2 out of order first, to prove sorting.
      s({ date: '2026-01-08', weight: 200, reps: 5 }),
      s({ date: '2026-01-01', weight: 185, reps: 5 }),
      s({ date: '2026-01-01', weight: 135, reps: 8, setType: 'warmup' }), // excluded
      s({ date: '2026-01-01', weight: 190, reps: 3 }),
    ]
    const c = computeCharts(sets, 'weight_reps')
    expect(c.e1rm.map((p) => p.date)).toEqual(['2026-01-01', '2026-01-08'])
    // day1 best e1RM: 185×(1+5/30)=215.83 vs 190×(1+3/30)=209 → 215.8.
    expect(c.e1rm[0]!.value).toBeCloseTo(215.8, 1)
    // day1 volume: 185×5 + 190×3 = 925+570 = 1495 (warmup excluded).
    expect(c.volume[0]!.value).toBe(1495)
    // day1 best single set: 185×5 = 925.
    expect(c.bestSet[0]!.value).toBe(925)
  })

  it('produces empty series for non-weight tracks', () => {
    const c = computeCharts([s({ date: '2026-01-01', reps: 10 })], 'reps')
    expect(c.e1rm).toEqual([])
    expect(c.volume).toEqual([])
    expect(c.bestSet).toEqual([])
  })

  it('assisted_bodyweight has no e1RM chart but no volume either', () => {
    const c = computeCharts([s({ date: '2026-01-01', weight: 40, reps: 5 })], 'assisted_bodyweight')
    // assisted excluded from volume AND e1RM → all empty.
    expect(c.e1rm).toEqual([])
    expect(c.volume).toEqual([])
  })

  it('weighted_bodyweight has a volume chart but no e1RM chart', () => {
    const c = computeCharts([s({ date: '2026-01-01', weight: 45, reps: 5 })], 'weighted_bodyweight')
    expect(c.e1rm).toEqual([])
    expect(c.volume).toEqual([{ date: '2026-01-01', value: 225 }])
  })

  it('charts Both and paired L/R as the same per-side work', () => {
    const both = computeCharts([
      s({
        date: '2026-01-01', weight: 42.5, reps: 10,
        loadBasis: 'per_side', side: null, logicalSetId: 'both',
      }),
    ], 'weight_reps')
    const split = computeCharts([
      s({
        date: '2026-01-01', weight: 42.5, reps: 10,
        loadBasis: 'per_side', side: 'left', logicalSetId: 'pair',
      }),
      s({
        date: '2026-01-01', weight: 42.5, reps: 10,
        loadBasis: 'per_side', side: 'right', logicalSetId: 'pair',
      }),
    ], 'weight_reps')

    expect(both.volume).toEqual([{ date: '2026-01-01', value: 850 }])
    expect(split.volume).toEqual(both.volume)
    expect(split.bestSet).toEqual(both.bestSet)
    expect(split.e1rm).toEqual(both.e1rm)
  })
})
