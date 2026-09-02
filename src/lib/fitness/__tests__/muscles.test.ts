/**
 * Exercise → muscle mapping. The mapper drives the muscle map, so these lock the
 * behaviours that matter: name keywords beat the catalog, the big compound lifts
 * credit secondaries, the user's "(Equipment)"-suffixed real names resolve WITHOUT a
 * catalog muscle, specificity ordering (RDL ≠ deadlift), and cardio → nothing.
 */
import { describe, it, expect } from 'vitest'

import {
  MUSCLE_REGIONS,
  MOBILITY_ONLY_REGIONS,
  catalogMuscleToRegion,
  isMobilityOnlyRegion,
  mobilityRegionsForExercise,
  musclesForExercise,
  musclesForExerciseEnriched,
  isMuscleRegion,
  REGION_MEASUREMENTS,
} from '../muscles'

const regionsOf = (name: string, cat?: string | null) => musclesForExercise(name, cat).map((h) => h.region)
const primary = (name: string, cat?: string | null) =>
  musclesForExercise(name, cat).filter((h) => h.weight === 1).map((h) => h.region)

describe('catalogMuscleToRegion', () => {
  it('normalizes free-exercise-db vocabulary to figure regions', () => {
    expect(catalogMuscleToRegion('quadriceps')).toBe('quads')
    expect(catalogMuscleToRegion('abdominals')).toBe('abs')
    expect(catalogMuscleToRegion('middle back')).toBe('mid_back')
    expect(catalogMuscleToRegion('shoulders')).toBe('delts')
    expect(catalogMuscleToRegion('pectorals')).toBe('chest')
    expect(catalogMuscleToRegion('delts')).toBe('delts')
    expect(catalogMuscleToRegion('upper back')).toBe('mid_back')
    expect(catalogMuscleToRegion(null)).toBeNull()
    expect(catalogMuscleToRegion('nonsense')).toBeNull()
  })
})

describe('musclesForExercise', () => {
  it('credits chest primary + triceps/delts secondary for a bench press (his real name)', () => {
    const hits = musclesForExercise('Bench Press (Barbell)', null)
    expect(hits.find((h) => h.region === 'chest')?.weight).toBe(1)
    expect(hits.find((h) => h.region === 'triceps')?.weight).toBe(0.5)
    expect(hits.find((h) => h.region === 'delts')?.weight).toBe(0.5)
  })

  it('resolves a real Strong name with NO catalog muscle (the on-demand-row case)', () => {
    // These come out of his history with primary_muscle = null.
    expect(primary('Squat (Barbell)', null)).toContain('quads')
    expect(primary('Squat (Barbell)', null)).toContain('glutes')
    expect(regionsOf('Lat Pulldown (Cable)', null)).toContain('lats')
    expect(primary('Incline Bench Press (Dumbbell)', null)).toContain('chest')
  })

  it('name keywords WIN over a misleading catalog muscle', () => {
    // Even if the catalog said "biceps", a curl is biceps anyway; but a squat
    // labeled "chest" in the catalog must still map to legs via the name.
    expect(primary('Back Squat', 'chest')).toContain('quads')
    expect(primary('Back Squat', 'chest')).not.toContain('chest')
  })

  it('respects specificity ordering — RDL is hamstrings, not a generic deadlift', () => {
    const rdl = primary('Romanian Deadlift (Barbell)', null)
    expect(rdl).toContain('hamstrings')
    expect(rdl).not.toContain('quads') // conventional deadlift credits quads; RDL should not (as primary)
    const dead = primary('Deadlift (Barbell)', null)
    expect(dead).toContain('hamstrings')
    expect(dead).toContain('glutes')
    expect(dead).toContain('lower_back')
  })

  it('does not confuse "leg curl" with a bicep curl', () => {
    expect(primary('Leg Curl (Machine)', null)).toEqual(['hamstrings'])
    expect(primary('Bicep Curl (Dumbbell)', null)).toContain('biceps')
  })

  it('falls back to the catalog primary muscle when no name rule matches', () => {
    // A made-up name no rule catches, but the catalog knows it's abs.
    expect(regionsOf('Dragon Flag Thing', 'abdominals')).toEqual(['abs'])
  })

  it('returns nothing for pure cardio / unmappable names', () => {
    expect(musclesForExercise('Running', null)).toEqual([])
    expect(musclesForExercise('Cycling', 'cardio')).toEqual([])
  })

  it('every region a rule can emit is a real MUSCLE_REGION', () => {
    const names = ['Bench', 'Squat', 'Deadlift', 'Row', 'Curl', 'Pulldown', 'Shoulder Press', 'Crunch', 'Calf Raise', 'Shrug']
    for (const n of names) {
      for (const h of musclesForExercise(n, null)) {
        expect(isMuscleRegion(h.region)).toBe(true)
      }
    }
  })
})

describe('musclesForExerciseEnriched', () => {
  it('a matching name rule WINS over catalog data (same as the base fn)', () => {
    // Rule says squat = quads/glutes; even a misleading catalog primary + secondary
    // must not change the result — it delegates to musclesForExercise on a hit.
    const hits = musclesForExerciseEnriched('Back Squat', 'chest', ['triceps'])
    const regions = hits.map((h) => h.region)
    expect(regions).toContain('quads')
    expect(regions).toContain('glutes')
    expect(regions).not.toContain('chest')
    expect(regions).not.toContain('triceps')
    // Identical to the base fn for the same primary.
    expect(hits).toEqual(musclesForExercise('Back Squat', 'chest'))
  })

  it('falls back to catalog primary (1) + secondaries (0.5), mapped + deduped', () => {
    // No rule catches this made-up name → catalog data drives it.
    const hits = musclesForExerciseEnriched('Dragon Flag Thing', 'abdominals', [
      'obliques',
      'quadriceps',
      'glutes',
    ])
    expect(hits.find((h) => h.region === 'abs')?.weight).toBe(1)
    expect(hits.find((h) => h.region === 'quads')?.weight).toBe(0.5)
    expect(hits.find((h) => h.region === 'glutes')?.weight).toBe(0.5)
    expect(hits.find((h) => h.region === 'obliques')?.weight).toBe(0.5)
  })

  it('dedupes when a secondary maps to the same region as the primary', () => {
    // 'quadriceps' + 'adductors' both map to quads → one hit, primary weight wins.
    const hits = musclesForExerciseEnriched('Some Machine Move', 'quadriceps', ['adductors'])
    const quads = hits.filter((h) => h.region === 'quads')
    expect(quads).toHaveLength(1)
    expect(quads[0]!.weight).toBe(1)
  })

  it('returns [] for an unknown name with no catalog muscles', () => {
    expect(musclesForExerciseEnriched('Running', null, null)).toEqual([])
    expect(musclesForExerciseEnriched('Mystery Move', null, [])).toEqual([])
  })
})

describe('mobilityRegionsForExercise (§10b.9 — joint-aware)', () => {
  it('routes joint-named stretches to their joint region, not a muscle', () => {
    // Neck stretch: primary "levator scapulae" (unmapped) + trapezius secondary
    // would fold to Traps under the muscle mapper — the joint rule sends it to Neck.
    const neck = mobilityRegionsForExercise('Neck Side Stretch', 'levator scapulae', ['trapezius'])
    expect(neck.map((h) => h.region)).toEqual(['neck'])
    expect(neck[0]!.weight).toBe(1)

    expect(mobilityRegionsForExercise('Wrist Flexor Stretch', 'forearms', []).map((h) => h.region)).toEqual(['wrists'])
    expect(mobilityRegionsForExercise('Ankle Dorsiflexion Drill', null, []).map((h) => h.region)).toEqual(['ankles'])
    expect(mobilityRegionsForExercise('Posterior Tibialis Stretch', 'calves', []).map((h) => h.region)).toEqual(['ankles'])
    expect(mobilityRegionsForExercise('Kneeling Patellar Mobilization', null, []).map((h) => h.region)).toEqual(['knees'])
  })

  it('word-bounds the joint keywords so ab/posture names do not collide', () => {
    // "knee raise" (ab move) and "kneeling" (posture) must NOT credit knees.
    expect(mobilityRegionsForExercise('Hanging Knee Raise', 'abdominals', []).map((h) => h.region)).not.toContain('knees')
    expect(mobilityRegionsForExercise('Kneeling Hip Flexor Stretch', 'glutes', []).map((h) => h.region)).not.toContain('knees')
    // But a genuine knee mobilization does.
    expect(mobilityRegionsForExercise('Standing Knee Circles', null, []).map((h) => h.region)).toEqual(['knees'])
  })

  it('falls back to the muscle mapper for non-joint stretches', () => {
    // A hamstring stretch with no joint keyword → muscle regions, unchanged.
    const ham = mobilityRegionsForExercise('Reclining Big Toe Pose With Rope', 'hamstrings', ['calves'])
    expect(ham.find((h) => h.region === 'hamstrings')?.weight).toBe(1)
    expect(ham.find((h) => h.region === 'calves')?.weight).toBe(0.5)
  })
})

describe('joint / mobility-only regions', () => {
  it('exposes the four joints and flags them', () => {
    expect([...MOBILITY_ONLY_REGIONS]).toEqual(['neck', 'knees', 'wrists', 'ankles'])
    for (const j of MOBILITY_ONLY_REGIONS) {
      expect(MUSCLE_REGIONS).toContain(j)
      expect(isMobilityOnlyRegion(j)).toBe(true)
    }
    expect(isMobilityOnlyRegion('chest')).toBe(false)
    // Strength moves never earn joint credit — the strength mapper can't produce them.
    expect(musclesForExercise('Barbell Bench Press', 'chest').every((h) => !isMobilityOnlyRegion(h.region))).toBe(true)
  })
})

describe('REGION_MEASUREMENTS', () => {
  it('only references regions the figure actually draws', () => {
    for (const region of Object.keys(REGION_MEASUREMENTS)) {
      expect(MUSCLE_REGIONS).toContain(region as (typeof MUSCLE_REGIONS)[number])
    }
  })
})
