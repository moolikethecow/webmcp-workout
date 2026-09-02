/**
 * Rest-timer + display-unit pure helpers (GYM_PLAN §4). Timestamp-math is tested
 * with an explicit `now` (no wall clock) so it's deterministic; the unit-conversion
 * half asserts the DISPLAY-only invariant (round-trip stability, null passthrough).
 */
import { describe, it, expect } from 'vitest'

import {
  startRestState,
  adjustRestState,
  remainingMs,
  remainingSeconds,
  isRestDone,
  ringFraction,
  formatRest,
  restSecondsForSet,
  convertWeight,
  KG_TO_LB,
  UNIT_STEPS,
  isAmbiguousBareRest,
  AMBIGUOUS_REST_BELOW_SECONDS,
} from '../rest-timer'

const T0 = 1_000_000

describe('rest countdown (timestamp math)', () => {
  it('startRestState ends `seconds` from now', () => {
    const s = startRestState('ex1', 120, T0)
    expect(s.endsAt).toBe(T0 + 120_000)
    expect(s.totalMs).toBe(120_000)
    expect(s.exerciseId).toBe('ex1')
  })

  it('remaining derives from now — a missed tick still reads correctly', () => {
    const s = startRestState('ex1', 120, T0)
    // Jump forward 90s (as if the tab was backgrounded through several ticks).
    expect(remainingMs(s, T0 + 90_000)).toBe(30_000)
    expect(remainingSeconds(s, T0 + 90_000)).toBe(30)
  })

  it('clamps at zero (never negative)', () => {
    const s = startRestState('ex1', 60, T0)
    expect(remainingMs(s, T0 + 90_000)).toBe(0)
    expect(remainingSeconds(s, T0 + 90_000)).toBe(0)
  })

  it('isRestDone flips at endsAt', () => {
    const s = startRestState('ex1', 60, T0)
    expect(isRestDone(s, T0 + 59_000)).toBe(false)
    expect(isRestDone(s, T0 + 60_000)).toBe(true)
    expect(isRestDone(s, T0 + 61_000)).toBe(true)
  })

  it('remainingSeconds rounds UP so 0:01 shows until true zero', () => {
    const s = startRestState('ex1', 60, T0)
    expect(remainingSeconds(s, T0 + 59_500)).toBe(1)
    expect(remainingSeconds(s, T0 + 59_999)).toBe(1)
    expect(remainingSeconds(s, T0 + 60_000)).toBe(0)
  })

  it('ringFraction goes 1 → 0 across the duration', () => {
    const s = startRestState('ex1', 100, T0)
    expect(ringFraction(s, T0)).toBe(1)
    expect(ringFraction(s, T0 + 50_000)).toBeCloseTo(0.5, 5)
    expect(ringFraction(s, T0 + 100_000)).toBe(0)
    expect(ringFraction(s, T0 + 200_000)).toBe(0)
  })

  it('null state → benign zeros', () => {
    expect(remainingMs(null, T0)).toBe(0)
    expect(isRestDone(null, T0)).toBe(false)
    expect(ringFraction(null, T0)).toBe(0)
  })
})

describe('adjustRestState (+30 / −15)', () => {
  it('+30 pushes endsAt out and grows the ring total', () => {
    const s = startRestState('ex1', 60, T0)
    const next = adjustRestState(s, 30, T0 + 10_000)!
    expect(next.endsAt).toBe(s.endsAt + 30_000)
    expect(remainingSeconds(next, T0 + 10_000)).toBe(80) // 50 left + 30
  })

  it('−15 pulls endsAt in', () => {
    const s = startRestState('ex1', 60, T0)
    const next = adjustRestState(s, -15, T0 + 10_000)!
    expect(remainingSeconds(next, T0 + 10_000)).toBe(35) // 50 left − 15
  })

  it('an adjustment that empties the timer returns null (→ skip)', () => {
    const s = startRestState('ex1', 60, T0)
    // 5s left, −15 → gone.
    expect(adjustRestState(s, -15, T0 + 55_000)).toBeNull()
  })

  it('ringFraction stays within 0..1 after adjustment', () => {
    const s = startRestState('ex1', 60, T0)
    const next = adjustRestState(s, 30, T0 + 10_000)!
    const f = ringFraction(next, T0 + 10_000)
    expect(f).toBeGreaterThanOrEqual(0)
    expect(f).toBeLessThanOrEqual(1)
  })
})

describe('restSecondsForSet', () => {
  it('an exact set override wins before warmup and working defaults', () => {
    expect(restSecondsForSet(false, 120, 45, 90)).toBe(90)
    expect(restSecondsForSet(true, 120, 45, 30)).toBe(30)
    expect(restSecondsForSet(true, 120, 45, 0)).toBe(0)
  })
  it('working set uses the working rest', () => {
    expect(restSecondsForSet(false, 120, 45)).toBe(120)
  })
  it('warmup set uses the warmup rest when configured', () => {
    expect(restSecondsForSet(true, 120, 45)).toBe(45)
  })
  it('warmup set falls back to working rest when no warmup rest set', () => {
    expect(restSecondsForSet(true, 120, null)).toBe(120)
    expect(restSecondsForSet(true, 120, undefined)).toBe(120)
    expect(restSecondsForSet(true, 120, 0)).toBe(120)
  })
  it('null explicitly inherits the warmup/working fallback', () => {
    expect(restSecondsForSet(false, 120, 45, null)).toBe(120)
    expect(restSecondsForSet(true, 120, 45, null)).toBe(45)
  })
})

describe('formatRest', () => {
  it('mm:ss with zero-padded seconds', () => {
    expect(formatRest(90)).toBe('1:30')
    expect(formatRest(5)).toBe('0:05')
    expect(formatRest(0)).toBe('0:00')
    expect(formatRest(-3)).toBe('0:00')
  })
})

describe('convertWeight (DISPLAY only)', () => {
  it('same-unit passthrough is identity (no rounding drift)', () => {
    expect(convertWeight(185, 'lb', 'lb')).toBe(185)
    expect(convertWeight(62.5, 'kg', 'kg')).toBe(62.5)
  })

  it('lb → kg and kg → lb', () => {
    expect(convertWeight(100, 'kg', 'lb')).toBeCloseTo(220.46, 2)
    expect(convertWeight(220.46, 'lb', 'kg')).toBeCloseTo(100, 1)
  })

  it('null passes through', () => {
    expect(convertWeight(null, 'lb', 'kg')).toBeNull()
  })

  it('KG_TO_LB is the canonical constant', () => {
    expect(KG_TO_LB).toBeCloseTo(2.20462, 5)
  })
})

describe('UNIT_STEPS', () => {
  it('lb + kg plate-stepper increments', () => {
    expect(UNIT_STEPS.lb).toEqual([2.5, 5, 10])
    expect(UNIT_STEPS.kg).toEqual([1.25, 2.5, 5])
  })
})

/**
 * The units rule behind #1832. Both rest inputs — the logger's SetRestPicker and
 * history's inline RestLine — call this, so it is the one place the question is
 * defined and the only place it can drift.
 */
describe('isAmbiguousBareRest', () => {
  it('questions a bare number that almost certainly meant minutes', () => {
    // The two values actually found in a real session, between 120s siblings.
    expect(isAmbiguousBareRest('3', 3)).toBe(true)
    expect(isAmbiguousBareRest('4', 4)).toBe(true)
    expect(isAmbiguousBareRest('14', 14)).toBe(true)
  })

  it('takes an explicit min:sec at its word', () => {
    expect(isAmbiguousBareRest('0:03', 3)).toBe(false)
    expect(isAmbiguousBareRest('0:04', 4)).toBe(false)
  })

  it('never questions 0 — straight into the next set is a real choice', () => {
    expect(isAmbiguousBareRest('0', 0)).toBe(false)
  })

  it('leaves ordinary rests alone', () => {
    expect(isAmbiguousBareRest(String(AMBIGUOUS_REST_BELOW_SECONDS), AMBIGUOUS_REST_BELOW_SECONDS)).toBe(false)
    expect(isAmbiguousBareRest('30', 30)).toBe(false)
    expect(isAmbiguousBareRest('135', 135)).toBe(false)
  })
})
