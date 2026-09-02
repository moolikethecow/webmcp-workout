/**
 * Plate calculator (GYM_PLAN §4) — the pure per-side breakdown. Edge cases the plan
 * calls out: below the bar, unachievable remainder flagged, kg + lb sets, custom bar.
 */
import { describe, it, expect } from 'vitest'

import {
  computePlates,
  formatPlateLabel,
  isBarbellExercise,
  DEFAULT_BAR,
  STANDARD_PLATES,
} from '../plate-calc'

describe('computePlates — standard lb', () => {
  it('225 on a 45 bar → 45 + 45 per side, exact', () => {
    const b = computePlates(225, 'lb')
    expect(b.barWeight).toBe(45)
    expect(b.perSide).toEqual([45, 45])
    expect(b.remainderPerSide).toBe(0)
    expect(b.achievable).toBe(true)
    expect(b.belowBar).toBe(false)
  })

  it('135 → 45 per side', () => {
    expect(computePlates(135, 'lb').perSide).toEqual([45])
  })

  it('185 → 45 + 25 per side (the plan example row)', () => {
    const b = computePlates(185, 'lb')
    // (185-45)/2 = 70 = 45 + 25
    expect(b.perSide).toEqual([45, 25])
    expect(b.achievable).toBe(true)
  })

  it('greedy heaviest-first: 100 → 25 + 2.5 (27.5 per side)', () => {
    // (100-45)/2 = 27.5 → 25 + 2.5
    const b = computePlates(100, 'lb')
    expect(b.perSide).toEqual([25, 2.5])
    expect(b.remainderPerSide).toBe(0)
  })
})

describe('computePlates — edge cases', () => {
  it('exactly the bar → nothing to load, achievable, not below', () => {
    const b = computePlates(45, 'lb')
    expect(b.perSide).toEqual([])
    expect(b.belowBar).toBe(false)
    expect(b.achievable).toBe(true)
  })

  it('below the bar → belowBar true, not achievable', () => {
    const b = computePlates(30, 'lb')
    expect(b.belowBar).toBe(true)
    expect(b.achievable).toBe(false)
    expect(b.perSide).toEqual([])
  })

  it('flags an unachievable remainder (odd leftover)', () => {
    // (46-45)/2 = 0.5 per side — no 0.5 plate → remainder 0.5 flagged.
    const b = computePlates(46, 'lb')
    expect(b.perSide).toEqual([])
    expect(b.remainderPerSide).toBeCloseTo(0.5, 5)
    expect(b.achievable).toBe(false)
  })

  it('remainder after some plates fit: 187 → 45+25 with 1 leftover per side', () => {
    // (187-45)/2 = 71 → 45 + 25 = 70, leftover 1
    const b = computePlates(187, 'lb')
    expect(b.perSide).toEqual([45, 25])
    expect(b.remainderPerSide).toBeCloseTo(1, 5)
    expect(b.achievable).toBe(false)
  })
})

describe('computePlates — kg + custom bar', () => {
  it('100kg on a 20 bar → 25 + 15 per side (greedy heaviest-first)', () => {
    // (100-20)/2 = 40 per side → 25 + 15 (fewest, heaviest plates)
    const b = computePlates(100, 'kg')
    expect(b.barWeight).toBe(20)
    expect(b.perSide).toEqual([25, 15])
    expect(b.achievable).toBe(true)
  })

  it('uses a custom bar weight', () => {
    // 95 total on a 35 lb bar → (95-35)/2 = 30 → 25 + 5
    const b = computePlates(95, 'lb', 35)
    expect(b.barWeight).toBe(35)
    expect(b.perSide).toEqual([25, 5])
  })

  it('62.5 kg → 20 bar, (62.5-20)/2 = 21.25 = 20 + 1.25 (no float drift)', () => {
    const b = computePlates(62.5, 'kg')
    expect(b.perSide).toEqual([20, 1.25])
    expect(b.remainderPerSide).toBe(0)
  })
})

describe('formatPlateLabel', () => {
  it('lists per-side plates', () => {
    expect(formatPlateLabel(computePlates(185, 'lb'), 'lb')).toBe('45 · 25 per side')
  })
  it('just the bar', () => {
    expect(formatPlateLabel(computePlates(45, 'lb'), 'lb')).toBe('just the bar')
  })
  it('below the bar', () => {
    expect(formatPlateLabel(computePlates(30, 'lb'), 'lb')).toContain('below')
  })
  it('approximate when a remainder is left', () => {
    expect(formatPlateLabel(computePlates(187, 'lb'), 'lb')).toContain('≈')
  })
})

describe('isBarbellExercise', () => {
  it('structured equipment=barbell → true', () => {
    expect(isBarbellExercise({ name: 'Whatever', equipment: 'barbell' })).toBe(true)
  })
  it('structured equipment=dumbbell → false even for a barbell-sounding name', () => {
    expect(isBarbellExercise({ name: 'Bench Press', equipment: 'dumbbell' })).toBe(false)
  })
  it('name heuristic: "Barbell Row" → true', () => {
    expect(isBarbellExercise({ name: 'Barbell Row' })).toBe(true)
  })
  it('classic barbell lifts → true', () => {
    expect(isBarbellExercise({ name: 'Back Squat' })).toBe(true)
    expect(isBarbellExercise({ name: 'Squat' })).toBe(true)
    expect(isBarbellExercise({ name: 'Deadlift' })).toBe(true)
    expect(isBarbellExercise({ name: 'Bench Press' })).toBe(true)
  })
  it('dumbbell / machine variants → false', () => {
    expect(isBarbellExercise({ name: 'Dumbbell Bench Press' })).toBe(false)
    expect(isBarbellExercise({ name: 'Machine Chest Press' })).toBe(false)
    expect(isBarbellExercise({ name: 'Cable Row' })).toBe(false)
  })
  it('empty input → false', () => {
    expect(isBarbellExercise({})).toBe(false)
  })
})

describe('exported constants', () => {
  it('default bars + standard plate sets are sane', () => {
    expect(DEFAULT_BAR.lb).toBe(45)
    expect(DEFAULT_BAR.kg).toBe(20)
    expect(STANDARD_PLATES.lb[0]).toBe(45)
    expect(STANDARD_PLATES.kg[0]).toBe(25)
  })
})
