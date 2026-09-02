import { describe, it, expect } from 'vitest'

import {
  freshnessHint,
  lastPerformedIso,
  shapeAlternatives,
  toRow,
} from '../shape'
import type { Pool, PoolExercise } from '@/lib/gym/novelty'
import type { MuscleHit, MuscleRegion } from '@/lib/fitness/muscles'
import type { ExerciseInjuryProfile } from '@/lib/gym/injury-profile'

const EMPTY_PROFILE: ExerciseInjuryProfile = {
  schemaVersion: 1,
  provenance: 'manual-reviewed',
  sites: {},
  traits: [],
}

function pe(over: Partial<PoolExercise> & { id: string; name: string }): PoolExercise {
  return {
    pattern: 'horizontal-push',
    equipmentClass: 'barbell',
    region: 'chest' as MuscleRegion,
    staleness: 12,
    daysSinceLast: 21,
    injuryProfile: EMPTY_PROFILE,
    preferred: false,
    ...over,
  }
}

/** A single chest pool holding the source + two alternatives (staleness-desc). */
function chestPool(): Map<string, Pool> {
  const pool: Pool = {
    region: 'chest' as MuscleRegion,
    pattern: 'horizontal-push',
    equipmentClass: 'barbell',
    exercises: [
      pe({ id: 'src', name: 'Bench Press', staleness: 30, daysSinceLast: 5 }),
      pe({ id: 'alt1', name: 'Incline DB Press', staleness: 42, daysSinceLast: 45 }),
      pe({ id: 'alt2', name: 'Dip', staleness: 18, daysSinceLast: null, equipmentClass: 'bodyweight' }),
    ],
  }
  // regionCandidates sorts by staleness-desc, so pool insertion order doesn't matter.
  return new Map([['chest|horizontal-push|barbell', pool]])
}

describe('freshnessHint', () => {
  it('never-performed → "new — never done"', () => {
    expect(freshnessHint(null)).toBe('new — never done')
  })
  it('very recent → "did it recently"', () => {
    expect(freshnessHint(0)).toBe('did it recently')
    expect(freshnessHint(3)).toBe('did it recently')
  })
  it('weeks since → "fresh · Nw since last"', () => {
    expect(freshnessHint(42)).toBe('fresh · 6w since last')
    expect(freshnessHint(21)).toBe('fresh · 3w since last')
  })
  it('4–6 days rounds to a week', () => {
    expect(freshnessHint(6)).toBe('fresh · 1w since last')
  })
})

describe('lastPerformedIso', () => {
  it('derives an ISO date N days before now (UTC)', () => {
    const now = Date.parse('2026-07-10T12:00:00Z')
    expect(lastPerformedIso(21, now)).toBe('2026-06-19')
    expect(lastPerformedIso(0, now)).toBe('2026-07-10')
  })
  it('null → null (never performed)', () => {
    expect(lastPerformedIso(null)).toBeNull()
  })
})

describe('toRow', () => {
  it('maps a PoolExercise to the wire row with a region label + freshness', () => {
    const row = toRow(pe({ id: 'alt1', name: 'Incline DB Press', staleness: 42.37, daysSinceLast: 45 }))
    expect(row).toMatchObject({
      exerciseId: 'alt1',
      name: 'Incline DB Press',
      region: 'chest',
      pattern: 'horizontal-push',
      staleness: 42.4, // rounded 1dp
      daysSinceLast: 45,
    })
    expect(row.regionLabel).toBeTruthy()
    expect(row.freshness).toContain('since last')
  })
})

const CHEST_PRIMARY: MuscleHit[] = [{ region: 'chest' as MuscleRegion, weight: 1 }]

describe('shapeAlternatives', () => {
  it('returns alternatives ranked across the profile (staleness-tiebroken), source excluded', () => {
    const res = shapeAlternatives(chestPool(), CHEST_PRIMARY, 'src', 8)
    expect(res.region).toBe('chest')
    // src is excluded; alt1 (staleness 42) ranks above alt2 (18).
    expect(res.alternatives.map((a) => a.exerciseId)).toEqual(['alt1', 'alt2'])
    expect(res.alternatives.find((a) => a.exerciseId === 'src')).toBeUndefined()
  })

  it('respects the n cap', () => {
    const res = shapeAlternatives(chestPool(), CHEST_PRIMARY, 'src', 1)
    expect(res.alternatives).toHaveLength(1)
    expect(res.alternatives[0]!.exerciseId).toBe('alt1')
  })

  it('empty profile ⇒ empty (SwapSheet falls back to manual search)', () => {
    const res = shapeAlternatives(chestPool(), [], 'src', 8)
    expect(res.region).toBeNull()
    expect(res.regionLabel).toBeNull()
    expect(res.alternatives).toEqual([])
  })

  it('#1876: a secondary-region hit surfaces candidates the primary-only pool never would', () => {
    // A biceps-primary source (weight 1) with forearms as a SECONDARY hit
    // (weight 0.5) — the forearms pool holds a candidate the chest/biceps pool
    // never would. Regression for "reverse curl offered only biceps movements".
    const forearmPool: Pool = {
      region: 'forearms' as MuscleRegion,
      pattern: 'horizontal-push',
      equipmentClass: 'barbell',
      exercises: [pe({ id: 'wrist-curl', name: 'Wrist Curl', region: 'forearms' as MuscleRegion, staleness: 5 })],
    }
    const bicepsPool: Pool = {
      region: 'biceps' as MuscleRegion,
      pattern: 'horizontal-push',
      equipmentClass: 'barbell',
      exercises: [pe({ id: 'src', name: 'Reverse Curl', region: 'biceps' as MuscleRegion, staleness: 30 })],
    }
    const pools = new Map<string, Pool>([
      ['biceps|horizontal-push|barbell', bicepsPool],
      ['forearms|horizontal-push|barbell', forearmPool],
    ])
    const profile: MuscleHit[] = [
      { region: 'biceps' as MuscleRegion, weight: 1 },
      { region: 'forearms' as MuscleRegion, weight: 0.5 },
    ]
    const res = shapeAlternatives(pools, profile, 'src', 8)
    expect(res.alternatives.map((a) => a.exerciseId)).toContain('wrist-curl')
  })
})
