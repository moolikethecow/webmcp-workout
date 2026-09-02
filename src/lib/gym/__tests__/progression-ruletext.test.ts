/**
 * ruleTextFor (GYM_PLAN §2.5) — the additive export the template builder uses for
 * its live plain-English progression preview. It must be TOTAL (null → default,
 * garbage → the honest fallback) and BYTE-IDENTICAL to the string the engine's
 * ghosts carry for the same policy (both route through describePolicy). A snapshot
 * per policy type locks the copy so a future edit is a deliberate change.
 */
import { describe, expect, it } from 'vitest'

import { evaluateProgression, ruleTextFor } from '../progression'

describe('ruleTextFor — snapshot per policy type', () => {
  it('last_time (null policy = default)', () => {
    expect(ruleTextFor(null, 'lb')).toBe('Match last session.')
    expect(ruleTextFor({ type: 'last_time' }, 'lb')).toBe('Match last session.')
  })

  it('linear', () => {
    expect(ruleTextFor({ type: 'linear', increment: 5 }, 'lb')).toBe('Add 5 lb every session.')
    expect(ruleTextFor({ type: 'linear', increment: 2.5 }, 'kg')).toBe('Add 2.5 kg every session.')
  })

  it('double_progression', () => {
    expect(ruleTextFor({ type: 'double_progression', repRange: [8, 12], increment: 5 }, 'lb')).toBe(
      'Work 8–12 reps for 3 sets at the same weight: at 12 on all 3, add 5 lb and reset to 8; after 2 sessions with a set under 8, deload 10%.',
    )
  })

  it('rep_only (with and without a cap)', () => {
    expect(ruleTextFor({ type: 'rep_only', addRepWhen: { repsAtLeast: 12 } }, 'lb')).toBe(
      'Add 1 rep when every set hits 12.',
    )
    expect(
      ruleTextFor({ type: 'rep_only', addRepWhen: { repsAtLeast: 10 }, addReps: 2, capReps: 15 }, 'lb'),
    ).toBe('Add 2 reps when every set hits 10 (cap 15).')
  })

  it('rpe_target', () => {
    expect(ruleTextFor({ type: 'rpe_target', rpe: 8 }, 'lb')).toBe(
      "Autoregulate to RPE 8: keep last session's weights, adjust load to hit the target effort.",
    )
  })

  it('rule (composable, from chat) renders its condition→action', () => {
    const rule = {
      type: 'rule',
      when: { metric: 'all_sets_reps_at_least', op: '>=', value: 12 },
      then: { change: 'reps', by: 1 },
    }
    expect(ruleTextFor(rule, 'lb')).toBe('When every set hits >= 12 reps, add 1 rep.')
  })

  it('unreadable policy → the honest fallback text', () => {
    expect(ruleTextFor({ type: 'nonsense' }, 'lb')).toBe(
      'Custom rule (unreadable) — repeating last session.',
    )
    expect(ruleTextFor({ type: 'linear', increment: -5 }, 'lb')).toBe(
      'Custom rule (unreadable) — repeating last session.',
    )
  })

  it('matches the engine ghost ruleText exactly (same describePolicy path)', () => {
    const history = [[{ weight: 100, reps: 10, unit: 'lb' as const }]]
    const policies: unknown[] = [
      { type: 'last_time' },
      { type: 'linear', increment: 5 },
      { type: 'double_progression', repRange: [8, 12], increment: 5 },
      { type: 'rep_only', addRepWhen: { repsAtLeast: 12 } },
      { type: 'rpe_target', rpe: 8 },
    ]
    for (const p of policies) {
      const fromEngine = evaluateProgression(p, history, 'lb').ruleText
      expect(ruleTextFor(p, 'lb')).toBe(fromEngine)
    }
  })
})
