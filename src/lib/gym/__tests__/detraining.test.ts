/**
 * Return-to-training engine (#1790).
 *
 * The bug that started this: a saved Day 1 template prescribed a deliberate
 * post-injury 95lb restart; starting it produced 150lb — the pre-injury working
 * weight from 7 weeks earlier — because the progression overlay asked "what did
 * he last lift?" and never "when?".
 *
 * Two traps are pinned here because both were live in the first design:
 *  - a flat -10%/week decays to ZERO at week 10 (hence DELOAD_FLOOR)
 *  - ramping off the MOST RECENT session walks the load downward forever, since
 *    after one de-loaded session back the newest weight IS the de-loaded one
 *    (hence baselineLb = last loaded session BEFORE the layoff)
 */
import { describe, expect, it } from 'vitest'

import { applyReEntry } from '../active-workout'
import type { SetPrescriptionInput } from '../active-workout'
import {
  DELOAD_FLOOR,
  deloadHistoryDefaults,
  NO_DELOAD_DAYS,
  RAMP_SESSIONS,
  dayGap,
  deloadedTargetLb,
  detrainingSignal,
  reEntryFactor,
  specificityFactor,
  SPECIFICITY_FLOOR,
  type SessionMark,
} from '../detraining'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 7, 27) // 2026-08-27, fixed — never read the clock

/** Sessions NEWEST→OLDEST, given as "days before NOW". */
function marks(...rows: Array<[daysAgo: number, weight: number | null]>): SessionMark[] {
  return rows.map(([daysAgo, topWeightLb]) => ({ at: NOW - daysAgo * DAY, topWeightLb }))
}

describe('reEntryFactor — the band table', () => {
  it('leaves ordinary life alone', () => {
    expect(reEntryFactor(0)).toBe(1)
    expect(reEntryFactor(NO_DELOAD_DAYS)).toBe(1)
  })

  it('eases back rather than resetting, in the first weeks', () => {
    expect(reEntryFactor(14)).toBe(0.9)
    expect(reEntryFactor(30)).toBe(0.8)
  })

  it('lands the user\'s 7-week #1790 case at 72%', () => {
    expect(reEntryFactor(49)).toBe(0.72)
  })

  // The whole reason a floor exists: -10%/week reaches 0% at ten weeks and goes
  // NEGATIVE after. A very long layoff must still prescribe real work.
  it('never decays toward zero, however long the layoff', () => {
    // 70 is the inclusive top of the 0.72 band; the floor starts past it.
    for (const days of [71, 100, 365, 3650, 36_500]) {
      expect(reEntryFactor(days)).toBe(DELOAD_FLOOR)
      expect(reEntryFactor(days)).toBeGreaterThanOrEqual(0.7)
    }
  })

  it('is monotonic — a longer break never prescribes MORE', () => {
    let prev = 1
    for (let d = 0; d <= 200; d += 1) {
      const f = reEntryFactor(d)
      expect(f).toBeLessThanOrEqual(prev)
      prev = f
    }
  })
})

describe('detrainingSignal', () => {
  it('is a no-op with no history — a new movement is not a layoff', () => {
    expect(detrainingSignal({ exercise: [] }, NOW).factor).toBe(1)
    expect(detrainingSignal({ exercise: [] }, NOW).reason).toBeNull()
  })

  it('is a no-op for steady training', () => {
    const s = detrainingSignal({ exercise: marks([2, 150], [9, 145], [16, 145], [23, 140]) }, NOW)
    expect(s.factor).toBe(1)
    expect(s.reason).toBeNull()
  })

  it('ignores an ordinary short break', () => {
    expect(detrainingSignal({ exercise: marks([NO_DELOAD_DAYS, 150], [20, 150]) }, NOW).factor).toBe(1)
  })

  // ── the #1790 case ───────────────────────────────────────────────────────
  it('flags the first session back after 7 weeks off and anchors on the pre-layoff weight', () => {
    const s = detrainingSignal({ exercise: marks([50, 150], [57, 150], [64, 145]) }, NOW)
    expect(s.factor).toBe(0.72)
    expect(s.gapDays).toBe(50)
    expect(s.sessionsSinceReturn).toBe(0)
    expect(s.baselineLb).toBe(150)
    expect(s.reason).toMatch(/7 weeks since you last trained this/i)
  })

  it('prescribes ~110lb, not 150 — and not 95', () => {
    const s = detrainingSignal({ exercise: marks([50, 150], [57, 150]) }, NOW)
    // 150 * 0.72 = 108 → nearest 5 = 110.
    expect(deloadedTargetLb(s, 'lb')).toBe(110)
  })

  // ── the ramp ─────────────────────────────────────────────────────────────
  it('climbs across sessions instead of snapping back to full load', () => {
    // One session back (2 days ago) after a 50-day gap.
    const back1 = detrainingSignal({ exercise: marks([2, 110], [52, 150], [59, 150]) }, NOW)
    expect(back1.sessionsSinceReturn).toBe(1)
    expect(back1.factor).toBeCloseTo(0.79, 5)
    expect(back1.rampSessionsRemaining).toBe(3)

    const back2 = detrainingSignal({ exercise: marks([1, 120], [4, 110], [54, 150]) }, NOW)
    expect(back2.sessionsSinceReturn).toBe(2)
    expect(back2.factor).toBeCloseTo(0.86, 5)
  })

  // The trap: the newest session is the DE-LOADED one. Anchoring there would
  // prescribe 110*0.79 = 87 and walk downward every session.
  it('ramps off the pre-layoff baseline, never off the de-loaded session', () => {
    const s = detrainingSignal({ exercise: marks([2, 110], [52, 150], [59, 150]) }, NOW)
    expect(s.baselineLb).toBe(150)
    expect(deloadedTargetLb(s, 'lb')).toBe(120) // 150*0.79=118.5 → 120, i.e. UP from 110
  })

  it('produces a strictly rising ramp that reaches full load', () => {
    // m = completed sessions since the return. m=0 is the still-open layoff.
    const factors = [detrainingSignal({ exercise: marks([50, 150], [57, 150]) }, NOW).factor]
    for (let m = 1; m < RAMP_SESSIONS; m += 1) {
      const rows: Array<[number, number | null]> = []
      for (let j = 0; j < m; j += 1) rows.push([2 + j, 110])
      rows.push([60, 150])
      const s = detrainingSignal({ exercise: marks(...rows) }, NOW)
      expect(s.sessionsSinceReturn).toBe(m)
      factors.push(s.factor)
    }
    for (let i = 1; i < factors.length; i += 1) {
      expect(factors[i]!).toBeGreaterThan(factors[i - 1]!)
    }
    expect(factors[0]).toBe(0.72)
    expect(factors[factors.length - 1]).toBeLessThan(1)
  })

  it('stops adjusting once the ramp is served', () => {
    const rows: Array<[number, number | null]> = []
    for (let k = 0; k < RAMP_SESSIONS; k += 1) rows.push([2 + k, 130])
    rows.push([60, 150])
    const s = detrainingSignal({ exercise: marks(...rows) }, NOW)
    expect(s.factor).toBe(1)
    expect(s.reason).toBeNull()
  })

  it('skips unloaded sessions when resolving the baseline', () => {
    const s = detrainingSignal({ exercise: marks([50, 150], [57, null], [64, 140]) }, NOW)
    expect(s.baselineLb).toBe(150)
    const t = detrainingSignal({ exercise: marks([50, null], [57, 140]) }, NOW)
    expect(t.baselineLb).toBe(140)
  })

  it('yields no target when nothing loaded precedes the layoff', () => {
    const s = detrainingSignal({ exercise: marks([50, null], [57, null]) }, NOW)
    expect(s.baselineLb).toBeNull()
    expect(deloadedTargetLb(s, 'lb')).toBeNull()
  })

  it('rounds to the unit step', () => {
    const s = detrainingSignal({ exercise: marks([50, 100], [57, 100]) }, NOW)
    expect(deloadedTargetLb(s, 'lb')).toBe(70) // 100*0.72=72 → 70
    expect(deloadedTargetLb(s, 'kg')).toBe(72.5) // → nearest 2.5
  })

  it('is total — never throws, always in range', () => {
    const inputs: SessionMark[][] = [
      [],
      marks([0, 0]),
      marks([99999, 150]),
      marks([5, -10]),
      [{ at: Number.NaN, topWeightLb: 100 }],
    ]
    for (const rows of inputs) {
      const s = detrainingSignal({ exercise: rows }, NOW)
      expect(s.factor).toBeGreaterThanOrEqual(DELOAD_FLOOR)
      expect(s.factor).toBeLessThanOrEqual(1)
    }
  })
})

describe('dayGap', () => {
  it('floors and never goes negative', () => {
    expect(dayGap(NOW, NOW - 3 * DAY)).toBe(3)
    expect(dayGap(NOW, NOW + 5 * DAY)).toBe(0)
    expect(dayGap(NOW, NOW - (2 * DAY + 3600_000))).toBe(2)
  })
})

describe('deloadHistoryDefaults — the drafting path (#1790)', () => {
  const marksFor = (id: string, rows: Array<[number, number | null]>) =>
    new Map([[id, marks(...rows)]])

  it('eases a stale history-implied default', () => {
    const { defaults, reasons } = deloadHistoryDefaults(
      new Map([['bench', { weight: 150, reps: 10 }]]),
      marksFor('bench', [[50, 150], [57, 150]]),
      NOW,
    )
    expect(defaults.get('bench')).toEqual({ weight: 110, reps: 10 })
    expect(reasons.get('bench')).toMatch(/7 weeks/i)
  })

  it('leaves a freshly-trained exercise completely alone', () => {
    const { defaults, reasons } = deloadHistoryDefaults(
      new Map([['bench', { weight: 150, reps: 10 }]]),
      marksFor('bench', [[2, 150], [9, 145]]),
      NOW,
    )
    expect(defaults.get('bench')).toEqual({ weight: 150, reps: 10 })
    expect(reasons.size).toBe(0)
  })

  it('passes through exercises with no marks or no weight', () => {
    const { defaults } = deloadHistoryDefaults(
      new Map([
        ['unknown', { weight: 100, reps: 5 }],
        ['bodyweight', { weight: null, reps: 12 }],
      ]),
      marksFor('bodyweight', [[50, null]]),
      NOW,
    )
    expect(defaults.get('unknown')).toEqual({ weight: 100, reps: 5 })
    expect(defaults.get('bodyweight')).toEqual({ weight: null, reps: 12 })
  })

  // The gate compares a target against the history-implied weight. De-loading
  // only the target would make the de-load itself look like an unjustified
  // deviation and get rejected — so the map is eased at source.
  it('returns a new map without mutating the input', () => {
    const input = new Map([['bench', { weight: 150, reps: 10 }]])
    const { defaults } = deloadHistoryDefaults(
      input,
      marksFor('bench', [[50, 150]]),
      NOW,
    )
    expect(input.get('bench')).toEqual({ weight: 150, reps: 10 })
    expect(defaults).not.toBe(input)
  })

  it('never lowers reps — this is a load ramp, not a volume cut', () => {
    const { defaults } = deloadHistoryDefaults(
      new Map([['bench', { weight: 150, reps: 10 }]]),
      marksFor('bench', [[50, 150]]),
      NOW,
    )
    expect(defaults.get('bench')!.reps).toBe(10)
  })
})

describe('applyReEntry — the start path (#1790)', () => {
  const set = (over: Partial<SetPrescriptionInput> = {}): SetPrescriptionInput => ({
    setNumber: 1,
    setType: 'normal',
    weight: null,
    weightUnit: 'lb',
    reps: 10,
    restSeconds: 120,
    side: null,
    source: 'template',
    ...over,
  })
  const signal = () => detrainingSignal({ exercise: marks([50, 150], [57, 150]) }, NOW)

  it('fills an unauthored working set with the re-entry load', () => {
    const out = applyReEntry([set()], signal(), 'lb')
    expect(out[0]!.weight).toBe(110)
    expect(out[0]!.source).toBe('detraining')
  })

  it('leaves warmups exactly as authored', () => {
    const out = applyReEntry([set({ setType: 'warmup', weight: 50 })], signal(), 'lb')
    expect(out[0]!.weight).toBe(50)
    expect(out[0]!.source).toBe('template')
  })

  // Ease by default; the template is untouched and the restore is one action.
  it('eases a heavier template weight for THIS SESSION', () => {
    const out = applyReEntry([set({ weight: 150 })], signal(), 'lb')
    expect(out[0]!.weight).toBe(110)
    expect(out[0]!.source).toBe('detraining')
  })

  // His Day 1 restart is 95 against a 110 target — a ramp must never make a
  // deliberately light session HEAVIER.
  it('never RAISES a template already lighter than the ramp', () => {
    expect(applyReEntry([set({ weight: 95 })], signal(), 'lb')[0]!.weight).toBe(95)
    expect(applyReEntry([set({ weight: 60 })], signal(), 'lb')[0]!.weight).toBe(60)
  })

  it('is a no-op when there is no baseline to ramp from', () => {
    const none = detrainingSignal({ exercise: marks([50, null]) }, NOW)
    const input = [set()]
    expect(applyReEntry(input, none, 'lb')).toBe(input)
  })
})

describe('region-driven layoff — bench is bench, barbell or dumbbell', () => {
  // The failure the user caught: per-exercise alone is wrong in BOTH directions.
  it('does NOT treat a swapped-away lift as a layoff while the group is trained', () => {
    const s = detrainingSignal(
      {
        // Not this exact lift in 50 days...
        exercise: marks([50, 150], [57, 150]),
        // ...but pressing something every few days throughout.
        region: marks([2, null], [5, null], [9, null], [13, null], [20, null], [27, null]),
      },
      NOW,
    )
    // Eased for the unfamiliar movement only — nowhere near a 72% layoff.
    expect(s.factor).toBe(0.9)
    expect(s.reason).toMatch(/not this exact lift/i)
    expect(deloadedTargetLb(s, 'lb')).toBe(135) // 150*0.9, not 110
  })

  it('DOES de-load when the whole region has been idle, even if this lift was done recently', () => {
    const s = detrainingSignal(
      {
        // One session of this lift 3 days ago...
        exercise: marks([3, 150], [60, 150]),
        // ...inside an otherwise empty 8 weeks of pushing.
        region: marks([3, null], [60, null], [67, null]),
      },
      NOW,
    )
    // The region gap (57d) governs; one session back, so the ramp has begun.
    expect(s.gapDays).toBe(57)
    expect(s.sessionsSinceReturn).toBe(1)
    expect(s.factor).toBeCloseTo(0.79, 5)
  })

  it('falls back to per-exercise history when the region cannot be resolved', () => {
    const withRegion = detrainingSignal({ exercise: marks([50, 150], [57, 150]), region: [] }, NOW)
    const without = detrainingSignal({ exercise: marks([50, 150], [57, 150]) }, NOW)
    expect(withRegion.factor).toBe(0.72)
    expect(without.factor).toBe(0.72)
  })

  // Both gaps are the SAME days on the fallback path; charging for each would
  // double-penalise one layoff (0.72 * 0.90 = 0.648).
  it('never double-charges one layoff as both region gap and specificity', () => {
    const s = detrainingSignal({ exercise: marks([50, 150], [57, 150]) }, NOW)
    expect(s.factor).toBe(0.72)
    expect(s.factor).toBeGreaterThan(DELOAD_FLOOR)
  })

  it('holds the 70% floor even on the longest region layoff', () => {
    const s = detrainingSignal(
      { exercise: marks([400, 150]), region: marks([400, null]) },
      NOW,
    )
    expect(s.factor).toBe(DELOAD_FLOOR)
    expect(deloadedTargetLb(s, 'lb')).toBe(105)
  })
})

describe('specificityFactor', () => {
  it('is gentle and floored at 90%', () => {
    expect(specificityFactor(0)).toBe(1)
    expect(specificityFactor(21)).toBe(1)
    expect(specificityFactor(30)).toBe(0.95)
    expect(specificityFactor(400)).toBe(SPECIFICITY_FLOOR)
    expect(specificityFactor(4000)).toBeGreaterThanOrEqual(0.9)
  })
})

describe('performance gating — the ramp climbs on results, not attendance', () => {
  const back = (met: Array<boolean | undefined>) => {
    const rows: SessionMark[] = met.map((m, i) => ({
      at: NOW - (2 + i) * DAY,
      topWeightLb: 110,
      ...(m === undefined ? {} : { metPrescription: m }),
    }))
    rows.push({ at: NOW - 60 * DAY, topWeightLb: 150 })
    return rows
  }

  it('advances when the prescription was met', () => {
    const s = detrainingSignal({ exercise: back([true, true]), region: back([true, true]) }, NOW)
    expect(s.sessionsSinceReturn).toBe(2)
    expect(s.factor).toBeCloseTo(0.86, 5)
  })

  // Bailing after one set should repeat the step, not climb it.
  it('does NOT advance for a session that missed its prescription', () => {
    const s = detrainingSignal({ exercise: back([false, true]), region: back([false, true]) }, NOW)
    expect(s.sessionsSinceReturn).toBe(1)
    expect(s.factor).toBeCloseTo(0.79, 5)
  })

  it('stalls entirely while every session back falls short', () => {
    const s = detrainingSignal({ exercise: back([false, false]), region: back([false, false]) }, NOW)
    expect(s.sessionsSinceReturn).toBe(0)
    expect(s.factor).toBe(0.72)
  })

  // Sessions logged before prescriptions were stored must not freeze the ramp.
  it('treats unknown as met so legacy history never stalls it', () => {
    const s = detrainingSignal(
      { exercise: back([undefined, undefined]), region: back([undefined, undefined]) },
      NOW,
    )
    expect(s.sessionsSinceReturn).toBe(2)
  })
})

describe('overrides win — the ramp raises floors, it never lowers', () => {
  // The user overrides session 1 back to 135 and finishes it. The plain ramp would
  // then prescribe 0.79*150 = 120 and drag him BACKWARDS.
  it('never prescribes less than a weight already completed this block', () => {
    const s = detrainingSignal(
      {
        exercise: [
          { at: NOW - 2 * DAY, topWeightLb: 135, metPrescription: true },
          { at: NOW - 52 * DAY, topWeightLb: 150 },
        ],
      },
      NOW,
    )
    expect(s.completedSinceReturnLb).toBe(135)
    expect(deloadedTargetLb(s, 'lb')).toBe(135) // not 120
  })

  it('still climbs once the ramp passes what he did', () => {
    const s = detrainingSignal(
      {
        exercise: [
          { at: NOW - 2 * DAY, topWeightLb: 110, metPrescription: true },
          { at: NOW - 3 * DAY, topWeightLb: 110, metPrescription: true },
          { at: NOW - 60 * DAY, topWeightLb: 150 },
        ],
      },
      NOW,
    )
    // Ramp step 2 = 0.86*150 = 129 → 130, above the 110 he completed.
    expect(deloadedTargetLb(s, 'lb')).toBe(130)
  })

  // A session he bailed on should not raise the floor.
  it('does not let a failed heavy attempt raise the floor', () => {
    const s = detrainingSignal(
      {
        exercise: [
          { at: NOW - 2 * DAY, topWeightLb: 145, metPrescription: false },
          { at: NOW - 52 * DAY, topWeightLb: 150 },
        ],
      },
      NOW,
    )
    expect(s.completedSinceReturnLb).toBeNull()
    expect(deloadedTargetLb(s, 'lb')).toBe(110)
  })
})

// Found on PROD 2026-08-27, not by these tests. A time-tracked stretch that
// resolves to the same region carries a phantom target_reps from its template;
// scoring `reps >= prescribed_reps` against a null-reps duration set marked a
// cleanly-completed session as missed, and bool_and spread that across the
// whole region — freezing the ramp at step 0 forever.
describe('performance gate treats unrepped work as unknown, not failed', () => {
  it('advances when the only "miss" is a duration set with no reps', () => {
    const rows = [
      { at: NOW - 1 * DAY, topWeightLb: 110, metPrescription: true },
      { at: NOW - 50 * DAY, topWeightLb: 200 },
    ]
    const s = detrainingSignal({ exercise: rows, region: rows }, NOW)
    expect(s.sessionsSinceReturn).toBe(1)
    expect(s.factor).toBeCloseTo(0.79, 5)
  })

  // The engine's contract: undefined means unknown and must not stall.
  it('never freezes the ramp on unknown sessions', () => {
    const rows = [
      { at: NOW - 1 * DAY, topWeightLb: 110 },
      { at: NOW - 2 * DAY, topWeightLb: 110 },
      { at: NOW - 50 * DAY, topWeightLb: 200 },
    ]
    const s = detrainingSignal({ exercise: rows, region: rows }, NOW)
    expect(s.sessionsSinceReturn).toBe(2)
  })
})
