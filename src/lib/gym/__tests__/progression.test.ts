/**
 * Progression policy engine (GYM_PLAN §2.5) — the hardest-tested pure unit. Covers
 * every policy type, the plain-English ruleText, unit handling (dominant unit +
 * rounding), and the total-function guarantees (no history, malformed JSON never
 * throws). Deterministic in, deterministic out.
 */
import { describe, expect, it } from 'vitest'

import {
  dominantUnit,
  evaluateProgression,
  parsePolicy,
  roundNearest,
  type Session,
  type SessionHistory,
} from '../progression'

/** A weight_reps session at one weight across N sets of `reps`. */
const wr = (weight: number, reps: number, sets = 3, unit: 'lb' | 'kg' = 'lb'): Session =>
  Array.from({ length: sets }, () => ({ weight, reps, unit }))

describe('roundNearest', () => {
  it('rounds to the given step and trims float noise', () => {
    expect(roundNearest(101.3, 5)).toBe(100)
    expect(roundNearest(103, 5)).toBe(105)
    expect(roundNearest(91.2, 2.5)).toBe(90)
    expect(roundNearest(0.1 + 0.2, 0.1)).toBe(0.3) // no 0.30000000004
  })
})

describe('dominantUnit', () => {
  it('picks the majority unit; falls back on tie/empty', () => {
    expect(dominantUnit([[{ weight: 100, unit: 'lb', reps: 5 }]], 'kg')).toBe('lb')
    expect(dominantUnit([[{ weight: 40, unit: 'kg', reps: 5 }]], 'lb')).toBe('kg')
    expect(dominantUnit([], 'lb')).toBe('lb')
    // Tie → fallback.
    expect(
      dominantUnit([[{ weight: 100, unit: 'lb', reps: 5 }, { weight: 40, unit: 'kg', reps: 5 }]], 'lb'),
    ).toBe('lb')
  })
})

describe('last_time (default)', () => {
  it('null policy repeats the previous session verbatim', () => {
    const r = evaluateProgression(null, [wr(185, 5)])
    expect(r.sets).toEqual([
      { weight: 185, reps: 5 },
      { weight: 185, reps: 5 },
      { weight: 185, reps: 5 },
    ])
    expect(r.ruleText).toBe('Match last session.')
  })

  it('explicit {type:last_time} behaves the same', () => {
    const r = evaluateProgression({ type: 'last_time' }, [wr(100, 8, 2)])
    expect(r.sets).toEqual([{ weight: 100, reps: 8 }, { weight: 100, reps: 8 }])
  })

  it('no history → empty targets, sensible ruleText', () => {
    const r = evaluateProgression(null, [])
    expect(r.sets).toEqual([])
    expect(r.ruleText).toBe('Match last session.')
  })

  it('reads the LAST (newest) session when several are present', () => {
    const r = evaluateProgression(null, [wr(135, 5), wr(155, 5), wr(185, 3)])
    expect(r.sets).toEqual([
      { weight: 185, reps: 3 },
      { weight: 185, reps: 3 },
      { weight: 185, reps: 3 },
    ])
  })
})

describe('linear', () => {
  it('adds the increment to every set, keeps reps', () => {
    const r = evaluateProgression({ type: 'linear', increment: 5 }, [wr(185, 5)])
    expect(r.sets).toEqual([
      { weight: 190, reps: 5 },
      { weight: 190, reps: 5 },
      { weight: 190, reps: 5 },
    ])
    expect(r.ruleText).toBe('Add 5 lb every session.')
  })

  it('rounds to the increment', () => {
    const r = evaluateProgression({ type: 'linear', increment: 2.5 }, [wr(91, 5, 1, 'kg')], 'kg')
    // dominant unit is kg; 91 + 2.5 = 93.5 → nearest 2.5 = 92.5 (round of 93.5/2.5=37.4→37)
    expect(r.sets[0]!.weight).toBe(92.5)
  })

  it('no history → empty', () => {
    expect(evaluateProgression({ type: 'linear', increment: 5 }, []).sets).toEqual([])
  })
})

describe('double_progression', () => {
  const policy = { type: 'double_progression', repRange: [8, 12], increment: 5 }

  it('all sets at hi → +increment and reset reps to lo', () => {
    const r = evaluateProgression(policy, [wr(100, 12)])
    expect(r.sets).toEqual([
      { weight: 105, reps: 8 },
      { weight: 105, reps: 8 },
      { weight: 105, reps: 8 },
    ])
  })

  it('does not advance until the required three same-load sets are complete', () => {
    const onlyTwo = evaluateProgression(policy, [wr(100, 12, 2)])
    expect(onlyTwo.sets).toHaveLength(3)
    expect(onlyTwo.sets.every((s) => s.weight === 100)).toBe(true)

    const mixedLoads = evaluateProgression(policy, [[
      { weight: 100, reps: 12, unit: 'lb' },
      { weight: 100, reps: 12, unit: 'lb' },
      { weight: 95, reps: 12, unit: 'lb' },
    ]])
    expect(mixedLoads.sets.every((s) => s.weight === 100)).toBe(true)
    expect(mixedLoads.sets.some((s) => s.weight === 105)).toBe(false)
  })

  it('supports an explicit required set count', () => {
    const fourSetPolicy = { ...policy, requiredSets: 4 }
    const short = evaluateProgression(fourSetPolicy, [wr(100, 12, 3)])
    expect(short.sets).toHaveLength(4)
    expect(short.sets.every((s) => s.weight === 100)).toBe(true)

    const complete = evaluateProgression(fourSetPolicy, [wr(100, 12, 4)])
    expect(complete.sets).toHaveLength(4)
    expect(complete.sets.every((s) => s.weight === 105 && s.reps === 8)).toBe(true)
  })

  it('treats unilateral L/R pairs as rounds and lets the weaker side gate progress', () => {
    const paired = (rightFinalReps: number): Session => [
      { weight: 100, reps: 12, unit: 'lb', side: 'left' },
      { weight: 100, reps: 12, unit: 'lb', side: 'right' },
      { weight: 100, reps: 12, unit: 'lb', side: 'left' },
      { weight: 100, reps: 12, unit: 'lb', side: 'right' },
      { weight: 100, reps: 12, unit: 'lb', side: 'left' },
      { weight: 100, reps: rightFinalReps, unit: 'lb', side: 'right' },
    ]
    const held = evaluateProgression(policy, [paired(11)])
    expect(held.sets).toHaveLength(6)
    expect(held.sets.some((set) => set.weight === 105)).toBe(false)
    expect(held.sets.map((set) => set.side)).toEqual([
      'left', 'right', 'left', 'right', 'left', 'right',
    ])

    const cleared = evaluateProgression(policy, [paired(12)])
    expect(cleared.sets).toHaveLength(6)
    expect(cleared.sets.every((set) => set.weight === 105 && set.reps === 8)).toBe(true)
  })

  it('treats an incomplete unilateral pair as a miss instead of a completed set', () => {
    const incomplete: Session = [
      { weight: 100, reps: 12, unit: 'lb', side: 'left' },
      { weight: 100, reps: 12, unit: 'lb', side: 'right' },
      { weight: 100, reps: 12, unit: 'lb', side: 'left' },
      { weight: 100, reps: 12, unit: 'lb', side: 'right' },
      { weight: 100, reps: 12, unit: 'lb', side: 'left' },
    ]
    const result = evaluateProgression(policy, [incomplete])

    expect(result.sets).toHaveLength(6)
    expect(result.sets.some((set) => set.weight === 105)).toBe(false)
    expect(result.sets.map((set) => set.side)).toEqual([
      'left', 'right', 'left', 'right', 'left', 'right',
    ])
  })

  it('mid-range → repeat weight, nudge the FIRST sub-hi set +1 rep', () => {
    // sets: 12, 10, 9 → first below-hi is the 10 → becomes 11.
    const r = evaluateProgression(policy, [
      [
        { weight: 100, reps: 12, unit: 'lb' },
        { weight: 100, reps: 10, unit: 'lb' },
        { weight: 100, reps: 9, unit: 'lb' },
      ],
    ])
    expect(r.sets).toEqual([
      { weight: 100, reps: 12 },
      { weight: 100, reps: 11 },
      { weight: 100, reps: 9 },
    ])
  })

  it('deloads after N consecutive miss-sessions (a set below lo)', () => {
    // Two sessions each with a set below lo (8): 7 reps < 8 → deload 10% off 100 = 90.
    const miss = () => [
      { weight: 100, reps: 8, unit: 'lb' as const },
      { weight: 100, reps: 7, unit: 'lb' as const },
    ]
    const r = evaluateProgression(policy, [miss(), miss()])
    expect(r.sets.every((s) => s.weight === 90)).toBe(true)
    expect(r.sets.every((s) => s.reps === 8)).toBe(true) // reset to lo
  })

  it('does NOT deload with only one miss-session (deloadAfterMisses default 2)', () => {
    const clean = () => wr(100, 12) // all at hi
    const miss = () => [
      { weight: 100, reps: 8, unit: 'lb' as const },
      { weight: 100, reps: 7, unit: 'lb' as const },
    ]
    // newest is a miss but the one before was clean → not enough consecutive misses.
    const r = evaluateProgression(policy, [clean(), miss()])
    // No deload: repeats weight and nudges (7<8 handled as sub-hi → +1).
    expect(r.sets.some((s) => s.weight === 90)).toBe(false)
  })

  it('renders a plain-English rule', () => {
    const r = evaluateProgression(policy, [wr(100, 10)])
    expect(r.ruleText).toContain('8–12 reps')
    expect(r.ruleText).toContain('add 5 lb')
    expect(r.ruleText).toContain('deload 10%')
    expect(r.ruleText).toContain('3 sets at the same weight')
  })

  it('no history → empty', () => {
    expect(evaluateProgression(policy, []).sets).toEqual([])
  })
})

describe('rep_only (worked example)', () => {
  const policy = { type: 'rep_only', addRepWhen: { repsAtLeast: 12 }, addReps: 1 }

  it('adds a rep when every set hit the threshold', () => {
    const r = evaluateProgression(policy, [wr(50, 12)])
    expect(r.sets.every((s) => s.reps === 13)).toBe(true)
    expect(r.sets.every((s) => s.weight === 50)).toBe(true)
    expect(r.ruleText).toBe('Add 1 rep when every set hits 12.')
  })

  it('does not add when a set fell short of the threshold', () => {
    const r = evaluateProgression(policy, [
      [
        { weight: 50, reps: 12, unit: 'lb' },
        { weight: 50, reps: 11, unit: 'lb' },
      ],
    ])
    expect(r.sets).toEqual([
      { weight: 50, reps: 12 },
      { weight: 50, reps: 11 },
    ])
  })

  it('stays at capReps once reached', () => {
    const capped = { ...policy, capReps: 15 }
    const r = evaluateProgression(capped, [wr(50, 15)])
    expect(r.sets.every((s) => s.reps === 15)).toBe(true) // at cap → stay
  })
})

describe('rpe_target', () => {
  it('keeps last weights, explains autoregulation (no arithmetic change)', () => {
    const r = evaluateProgression({ type: 'rpe_target', rpe: 8 }, [wr(225, 5)])
    expect(r.sets).toEqual([
      { weight: 225, reps: 5 },
      { weight: 225, reps: 5 },
      { weight: 225, reps: 5 },
    ])
    expect(r.ruleText).toContain('RPE 8')
  })
})

describe('rule (composable conditional)', () => {
  it('metric reps (min set) >= value → then applies', () => {
    const policy = {
      type: 'rule',
      when: { metric: 'reps', op: '>=', value: 12 },
      then: { change: 'reps', by: 1 },
    }
    // min reps across sets = 12 → condition met → +1 rep on all.
    const r = evaluateProgression(policy, [wr(60, 12)])
    expect(r.sets.every((s) => s.reps === 13)).toBe(true)
  })

  it('condition not met → else applies (or no change when no else)', () => {
    const policy = {
      type: 'rule',
      when: { metric: 'reps', op: '>=', value: 12 },
      then: { change: 'weight', by: 5 },
      else: { change: 'reps', by: -1 },
    }
    // min reps = 8 (< 12) → else: drop a rep.
    const r = evaluateProgression(policy, [wr(60, 8)])
    expect(r.sets.every((s) => s.reps === 7)).toBe(true)
    expect(r.sets.every((s) => s.weight === 60)).toBe(true)
  })

  it('metric weight (top set) drives a weight bump', () => {
    const policy = {
      type: 'rule',
      when: { metric: 'weight', op: '>=', value: 200 },
      then: { change: 'weight', by: 10 },
    }
    const r = evaluateProgression(policy, [wr(205, 5)])
    expect(r.sets.every((s) => s.weight === 215)).toBe(true)
  })

  it('all_sets_reps_at_least evaluates the predicate per set', () => {
    const policy = {
      type: 'rule',
      when: { metric: 'all_sets_reps_at_least', op: '>=', value: 10 },
      then: { change: 'weight', by: 5 },
    }
    // every set ≥ 10 → weight +5.
    const met = evaluateProgression(policy, [wr(100, 10)])
    expect(met.sets.every((s) => s.weight === 105)).toBe(true)
    // one set at 9 → not met → no change.
    const notMet = evaluateProgression(policy, [
      [
        { weight: 100, reps: 10, unit: 'lb' },
        { weight: 100, reps: 9, unit: 'lb' },
      ],
    ])
    expect(notMet.sets.every((s) => s.weight === 100)).toBe(true)
  })

  it('renders a readable rule', () => {
    const policy = {
      type: 'rule',
      when: { metric: 'reps', op: '>=', value: 12 },
      then: { change: 'reps', by: 1 },
    }
    const r = evaluateProgression(policy, [wr(60, 12)])
    expect(r.ruleText.toLowerCase()).toContain('add 1 rep')
  })
})

describe('mixed units', () => {
  it('computes in the dominant unit and emits in it', () => {
    // Mostly kg history (2 kg rows vs 1 lb) → dominant kg; the lb row converts.
    const history: SessionHistory = [
      [
        { weight: 60, reps: 5, unit: 'kg' },
        { weight: 60, reps: 5, unit: 'kg' },
        { weight: 132.28, reps: 5, unit: 'lb' }, // ≈ 60 kg
      ],
    ]
    const r = evaluateProgression({ type: 'linear', increment: 2.5 }, history, 'kg')
    // All three land near 60 kg → +2.5 → 62.5 kg.
    expect(r.sets.every((s) => s.weight === 62.5)).toBe(true)
  })
})

describe('malformed policies are total (never throw, fall back)', () => {
  it('unknown type → last_time behavior + honest ruleText', () => {
    const r = evaluateProgression({ type: 'nonsense' }, [wr(100, 5)])
    expect(r.sets).toEqual([
      { weight: 100, reps: 5 },
      { weight: 100, reps: 5 },
      { weight: 100, reps: 5 },
    ])
    expect(r.ruleText).toBe('Custom rule (unreadable) — repeating last session.')
  })

  it('double_progression with a bad repRange falls back', () => {
    const r = evaluateProgression({ type: 'double_progression', repRange: [12, 8], increment: 5 }, [
      wr(100, 10),
    ])
    expect(r.ruleText).toBe('Custom rule (unreadable) — repeating last session.')
  })

  it('linear with non-numeric increment falls back', () => {
    const r = evaluateProgression({ type: 'linear', increment: 'lots' }, [wr(100, 5)])
    expect(r.ruleText).toBe('Custom rule (unreadable) — repeating last session.')
  })

  it('non-object / garbage inputs never throw', () => {
    expect(() => evaluateProgression('a string', [wr(100, 5)])).not.toThrow()
    expect(() => evaluateProgression(42, [])).not.toThrow()
    expect(() => evaluateProgression([], [wr(100, 5)])).not.toThrow()
    expect(evaluateProgression('a string', [wr(100, 5)]).ruleText).toBe(
      'Custom rule (unreadable) — repeating last session.',
    )
  })
})

describe('parsePolicy', () => {
  it('null → last_time (the DB default for a null column)', () => {
    expect(parsePolicy(null)).toEqual({ type: 'last_time' })
  })
  it('fills double_progression defaults (deloadAfterMisses=2, deloadPct=10)', () => {
    expect(parsePolicy({ type: 'double_progression', repRange: [8, 12], increment: 5 })).toEqual({
      type: 'double_progression',
      repRange: [8, 12],
      increment: 5,
      requiredSets: 3,
      deloadAfterMisses: 2,
      deloadPct: 10,
    })
  })
  it('rejects a rule with a bad op', () => {
    expect(
      parsePolicy({ type: 'rule', when: { metric: 'reps', op: '~', value: 1 }, then: { change: 'reps', by: 1 } }),
    ).toBeNull()
  })
})
