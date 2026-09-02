/**
 * The deterministic variety engine (lib/gym/novelty.ts). PURE — no DB, no LLM.
 * Covers: movement-pattern derivation, equipment-class + gym compatibility (dislike/
 * equipment/injury filters at pool-build time), staleness math, seeded determinism
 * (same seed ⇒ same slate), region-volume conservation (the gate's shared check),
 * and alternatives.
 */
import { describe, it, expect } from 'vitest'

import {
  alternativesFor,
  alternativesForProfile,
  buildPools,
  checkVolumeConservation,
  dealSlate,
  equipmentClass,
  gymCompatible,
  gymEquipmentTokens,
  gymExcludedNames,
  isSnoozed,
  movementPattern,
  mulberry32,
  poolDepthForRegion,
  poolExclusionReason,
  regionVolume,
  seedFromString,
  stalenessScore,
  weightedPick,
  NEVER_PERFORMED_DAYS,
  STALENESS_DAY_CAP,
  type CatalogExercise,
  type Pool,
  type PoolExercise,
  type RegionTarget,
} from '../novelty'
import { musclesForExerciseEnriched, type MuscleRegion } from '@/lib/fitness/muscles'
import { fixtureInjuryProfile } from './injury-fixtures'

function inferredCategory(primary: string | null | undefined): string | null {
  const p = (primary ?? '').toLowerCase()
  if (['quadriceps', 'hamstrings', 'glutes', 'adductors', 'abductors'].includes(p)) return 'upper legs'
  if (p === 'calves') return 'lower legs'
  if (p === 'chest') return 'chest'
  if (['middle back', 'lower back', 'lats', 'traps'].includes(p)) return 'back'
  if (p === 'shoulders') return 'shoulders'
  if (['biceps', 'triceps'].includes(p)) return 'upper arms'
  if (p === 'forearms') return 'lower arms'
  return null
}

function testInstructions(name: string): string[] {
  const n = name.toLowerCase()
  if (n.includes('seated') || n.includes('leg extension') || n.includes('adductor')) return [`Sit and perform ${name}.`]
  if (n.includes('bench press') || n.includes('lying')) return [`Lie on your back and perform ${name}.`]
  if (n.includes('push-up') || n.includes('push up') || n.includes('plank')) return [`Place your hands on the floor and perform ${name}.`]
  return [`Stand and perform ${name}.`]
}

/** Terse catalog-row builder. */
function ex(partial: Partial<CatalogExercise> & { id: string; name: string }): CatalogExercise {
  const row = {
    primaryMuscle: null,
    secondaryMuscles: [],
    equipment: null,
    force: null,
    mechanic: null,
    disliked: false,
    preferred: false,
    daysSinceLast: null,
    recentSets: 0,
    archived: false,
    ...partial,
  }
  return {
    ...row,
    injuryProfile: partial.injuryProfile ?? fixtureInjuryProfile({
      name: row.name,
      category: inferredCategory(row.primaryMuscle),
      primaryMuscle: row.primaryMuscle,
      secondaryMuscles: row.secondaryMuscles,
      equipment: row.equipment,
      modality: 'strength',
      instructions: testInstructions(row.name),
    }),
  }
}

describe('movementPattern', () => {
  it('derives hinge / squat / push / pull from the name', () => {
    expect(movementPattern({ name: 'Romanian Deadlift', primaryMuscle: null, force: null, mechanic: null })).toBe('hinge')
    expect(movementPattern({ name: 'Back Squat', primaryMuscle: null, force: null, mechanic: null })).toBe('squat')
    expect(movementPattern({ name: 'Barbell Bench Press', primaryMuscle: null, force: null, mechanic: null })).toBe('horizontal-push')
    expect(movementPattern({ name: 'Overhead Press', primaryMuscle: null, force: null, mechanic: null })).toBe('vertical-push')
    expect(movementPattern({ name: 'Lat Pulldown', primaryMuscle: null, force: null, mechanic: null })).toBe('vertical-pull')
    expect(movementPattern({ name: 'Barbell Row', primaryMuscle: null, force: null, mechanic: null })).toBe('horizontal-pull')
    expect(movementPattern({ name: 'Walking Lunge', primaryMuscle: null, force: null, mechanic: null })).toBe('lunge')
  })

  it('keys isolation exercises by their primary region so pools do not blend', () => {
    const curl = movementPattern({
      name: 'Dumbbell Bicep Curl',
      primaryMuscle: 'biceps',
      force: 'pull',
      mechanic: 'isolation',
    })
    const pushdown = movementPattern({
      name: 'Tricep Pushdown',
      primaryMuscle: 'triceps',
      force: 'push',
      mechanic: 'isolation',
    })
    // No name rule matches either, so mechanic:'isolation' keys by primary region —
    // biceps and triceps land in DIFFERENT isolation pools (they don't blend).
    expect(curl).toBe('isolation-biceps')
    expect(pushdown).toBe('isolation-triceps')
  })

  it('classifies obvious accessories when legacy catalog mechanic metadata is null', () => {
    expect(movementPattern({
      name: 'Bicep Curl (Machine)',
      primaryMuscle: 'biceps',
      force: null,
      mechanic: null,
    })).toBe('isolation-biceps')
    expect(movementPattern({
      name: 'Triceps Extension (Dumbbell)',
      primaryMuscle: 'triceps',
      force: null,
      mechanic: null,
    })).toBe('isolation-triceps')
    // Named compound rules still win before the accessory fallback.
    expect(movementPattern({
      name: 'Back Extension',
      primaryMuscle: 'lower back',
      force: null,
      mechanic: null,
    })).toBe('hinge')
    expect(movementPattern({
      name: 'Incline Dumbbell Press',
      primaryMuscle: 'chest',
      force: null,
      mechanic: null,
    })).toBe('horizontal-push')
  })

  it('falls back to force for un-named compounds', () => {
    expect(movementPattern({ name: 'Machine Thing', primaryMuscle: null, force: 'push', mechanic: 'compound' })).toBe('horizontal-push')
    expect(movementPattern({ name: 'Mystery Move', primaryMuscle: null, force: null, mechanic: null })).toBe('other')
  })

  it('derives calf-raise / jump patterns (joint-load families the map gates)', () => {
    const p = (name: string) => movementPattern({ name, primaryMuscle: null, force: null, mechanic: null })
    expect(p('Standing Calf Raise')).toBe('calf-raise')
    expect(p('Seated Calf Press')).toBe('calf-raise')
    // FEDB entries named after the muscle alone (no "raise"/"press" verb) — the
    // exact two exercises that leaked into an ankles-out draft in issue #1203.
    expect(p('Standing Calves')).toBe('calf-raise')
    expect(p('Lever Rotary Calf')).toBe('calf-raise')
    // Production leak #1216: no calf token, but the enriched primary region is
    // calves. Safety classification must not depend on the display name.
    expect(movementPattern({ name: 'Smith Toe Raise', primaryMuscle: 'calves', force: null, mechanic: null })).toBe('calf-raise')
    // Calf STRETCHES carry no ankle-joint strength load — they stay out of the
    // strength-only calf-raise pattern.
    expect(p('Standing Calves Calf Stretch')).not.toBe('calf-raise')
    expect(p('Calf Stretch With Rope')).not.toBe('calf-raise')
    expect(movementPattern({ name: 'Posterior Tibialis Stretch', primaryMuscle: 'calves', force: null, mechanic: null })).not.toBe('calf-raise')
    expect(movementPattern({ name: 'Ankle Circles', primaryMuscle: 'calves', force: null, mechanic: null })).not.toBe('calf-raise')
    expect(p('Box Jump')).toBe('jump')
    expect(p('Broad Jump')).toBe('jump')
    expect(p('Depth Jump')).toBe('jump')
    expect(p('Lateral Hops')).toBe('jump')
    expect(p('Plyo Box Jump')).toBe('jump')
    // Jump rules sit AFTER push/pull/squat so a hybrid keeps its base movement:
    expect(p('Jump Squat')).toBe('squat')
    expect(p('Plyo Push Up')).toBe('horizontal-push')
  })

  it('word-bounds "hop" so "Woodchop" is not mistaken for a jump', () => {
    // \bhop matches "hops"/"hopping" but NOT "chop"/"woodchop" — the substring-over-
    // match lesson. Woodchop must still resolve to core.
    expect(movementPattern({ name: 'Cable Woodchop', primaryMuscle: null, force: null, mechanic: null })).toBe('core')
  })

  it('derives the stability pattern for balance/agility drills (the ankle-leak family)', () => {
    const p = (name: string) => movementPattern({ name, primaryMuscle: null, force: null, mechanic: null })
    expect(p('Balance Board')).toBe('stability')
    expect(p('Single-Leg Balance')).toBe('stability')
    expect(p('Wobble Board Drill')).toBe('stability')
    expect(p('BOSU Balance')).toBe('stability')
    expect(p('Quick Feet')).toBe('stability')
    expect(p('Quick Feet v. 2')).toBe('stability')
    expect(p('Agility Ladder')).toBe('stability')
    expect(p('Ladder Drills')).toBe('stability')
    // Stability sits AFTER the strength families, so a loaded hybrid keeps its base
    // movement (and stays gated as that pattern instead).
    expect(p('Balancing Front Squat')).toBe('squat')
  })
})

describe('equipmentClass + gymCompatible', () => {
  it('maps FEDB tokens to coarse classes', () => {
    expect(equipmentClass('barbell')).toBe('barbell')
    expect(equipmentClass('Smith Machine')).toBe('machine')
    expect(equipmentClass('body only')).toBe('bodyweight')
    expect(equipmentClass('cable')).toBe('cable')
    expect(equipmentClass(null)).toBe('other')
  })

  it('null gym equipment → everything allowed', () => {
    expect(gymCompatible({ name: 'Barbell Squat', equipment: 'barbell' }, null)).toBe(true)
  })

  it('bodyweight is always allowed even when the gym lists nothing matching', () => {
    expect(gymCompatible({ name: 'Push Up', equipment: 'body only' }, ['dumbbell'])).toBe(true)
  })

  it('requires the exercise equipment to be a listed token/class', () => {
    expect(gymCompatible({ name: 'Barbell Bench', equipment: 'barbell' }, ['dumbbell', 'cable'])).toBe(false)
    expect(gymCompatible({ name: 'Barbell Bench', equipment: 'barbell' }, ['barbell'])).toBe(true)
  })

  it('matches a free-text machine name in the exercise name', () => {
    expect(
      gymCompatible({ name: 'Hammer Strength Row', equipment: 'machine' }, ['hammer strength']),
    ).toBe(true)
  })
})

describe('stalenessScore', () => {
  it('caps days-since at STALENESS_DAY_CAP', () => {
    const s = stalenessScore({ daysSinceLast: 500, recentSets: 0 })
    expect(s).toBe(STALENESS_DAY_CAP)
  })

  it('never-performed exercises get NEVER_PERFORMED_DAYS × freshWeight', () => {
    const s = stalenessScore({ daysSinceLast: null, recentSets: 0 })
    expect(s).toBe(NEVER_PERFORMED_DAYS)
  })

  it('recent frequency pulls the score down', () => {
    const cold = stalenessScore({ daysSinceLast: 30, recentSets: 0 })
    const hammered = stalenessScore({ daysSinceLast: 30, recentSets: 8 })
    expect(hammered).toBeLessThan(cold)
    // 8 recent sets → freqWeight 1/(1+2) = 0.333 → 30*0.333 = 10
    expect(hammered).toBeCloseTo(10, 5)
  })
})

describe('buildPools filters', () => {
  const gymEquip = ['barbell', 'dumbbell', 'cable', 'body only']
  const catalog: CatalogExercise[] = [
    ex({ id: 'bench', name: 'Barbell Bench Press', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 10 }),
    ex({ id: 'db-press', name: 'Dumbbell Bench Press', primaryMuscle: 'chest', equipment: 'dumbbell', daysSinceLast: 40 }),
    ex({ id: 'disliked', name: 'Pec Deck', primaryMuscle: 'chest', equipment: 'machine', disliked: true }),
    ex({ id: 'machine-only', name: 'Machine Fly', primaryMuscle: 'chest', equipment: 'machine' }),
    ex({ id: 'archived', name: 'Old Chest Move', primaryMuscle: 'chest', equipment: 'barbell', archived: true }),
    ex({ id: 'squat', name: 'Barbell Squat', primaryMuscle: 'quadriceps', equipment: 'barbell', daysSinceLast: 5 }),
  ]

  it('excludes disliked, archived, and gym-incompatible exercises', () => {
    const pools = buildPools(catalog, gymEquip)
    const ids = new Set<string>()
    for (const pool of pools.values()) for (const e of pool.exercises) ids.add(e.id)
    expect(ids.has('bench')).toBe(true)
    expect(ids.has('db-press')).toBe(true)
    expect(ids.has('squat')).toBe(true)
    // filtered:
    expect(ids.has('disliked')).toBe(false)
    expect(ids.has('archived')).toBe(false)
    expect(ids.has('machine-only')).toBe(false) // machine not in gym equipment
  })

  it('places an exercise in a pool per PRIMARY region only', () => {
    const pools = buildPools(catalog, gymEquip)
    // squat is quads primary → appears in a quads pool.
    const quadsPools = [...pools.values()].filter((p) => p.region === 'quads')
    expect(quadsPools.some((p) => p.exercises.some((e) => e.id === 'squat'))).toBe(true)
  })

  it('sorts each pool staleness-desc, name tiebreak', () => {
    const pools = buildPools(catalog, gymEquip)
    for (const pool of pools.values()) {
      for (let i = 1; i < pool.exercises.length; i += 1) {
        const prev = pool.exercises[i - 1]!
        const cur = pool.exercises[i]!
        expect(prev.staleness >= cur.staleness).toBe(true)
      }
    }
  })

  it('null gym equipment lets machine exercises into pools', () => {
    const pools = buildPools(catalog, null)
    const ids = new Set<string>()
    for (const pool of pools.values()) for (const e of pool.exercises) ids.add(e.id)
    expect(ids.has('machine-only')).toBe(true)
  })

  // #1096: the vendored animation catalog ships some rows all-lowercase (e.g.
  // "sphinx"), unlike Strong-imported rows which are usually already title-cased.
  // Pool exercises feed both drafted proposals and edit_workout_proposal's
  // add/swap — normalize presentation casing here so every exercise reads
  // consistently regardless of its source.
  it('normalizes a lowercase catalog name to Title Case', () => {
    const lowerCatalog: CatalogExercise[] = [
      ex({ id: 'sphinx', name: 'sphinx', primaryMuscle: 'spine', equipment: 'body only' }),
    ]
    const pools = buildPools(lowerCatalog, null)
    const names = [...pools.values()].flatMap((p) => p.exercises.map((e) => e.name))
    expect(names).toContain('Sphinx')
  })
})

describe('buildPools — joint-injury filter (#1044)', () => {
  const catalog: CatalogExercise[] = [
    ex({ id: 'squat', name: 'Barbell Squat', primaryMuscle: 'quadriceps', equipment: 'barbell', daysSinceLast: 5 }),
    ex({ id: 'lunge', name: 'Walking Lunge', primaryMuscle: 'quadriceps', equipment: 'body only', daysSinceLast: 5 }),
    ex({ id: 'bench', name: 'Barbell Bench Press', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 10 }),
    ex({ id: 'row', name: 'Barbell Row', primaryMuscle: 'middle back', equipment: 'barbell', daysSinceLast: 8 }),
  ]

  function ids(pools: Map<string, Pool>): Set<string> {
    const out = new Set<string>()
    for (const pool of pools.values()) for (const e of pool.exercises) out.add(e.id)
    return out
  }

  it('an out ankle injury excludes squat/lunge patterns even though their primary region is quads', () => {
    const pools = buildPools(catalog, null, [{ region: 'ankles', severity: 'out' }])
    const present = ids(pools)
    expect(present.has('squat')).toBe(false)
    expect(present.has('lunge')).toBe(false)
    // Supine bench stays available; standing rows correctly carry ankle support.
    expect(present.has('bench')).toBe(true)
    expect(present.has('row')).toBe(false)
  })

  it('a limiting knee injury also excludes squat/lunge (no partial dose for a joint-load pattern)', () => {
    const pools = buildPools(catalog, null, [{ region: 'knees', severity: 'limiting' }])
    const present = ids(pools)
    expect(present.has('squat')).toBe(false)
    expect(present.has('lunge')).toBe(false)
  })

  it('a nagging joint injury does not restrict — "train around it"', () => {
    const pools = buildPools(catalog, null, [{ region: 'ankles', severity: 'nagging' }])
    const present = ids(pools)
    expect(present.has('squat')).toBe(true)
    expect(present.has('lunge')).toBe(true)
  })

  it('a wrist injury excludes horizontal/vertical push but leaves squats alone', () => {
    const pools = buildPools(catalog, null, [{ region: 'wrists', severity: 'out' }])
    const present = ids(pools)
    expect(present.has('bench')).toBe(false)
    expect(present.has('squat')).toBe(true)
  })

  it('a plain muscle injury is enforced at pool membership too', () => {
    const pools = buildPools(catalog, null, [{ region: 'quads', severity: 'out' }])
    const present = ids(pools)
    expect(present.has('squat')).toBe(false)
  })
})

describe('buildPools — broadened ankle/knee joint-load gate (hinges/calves/jumps/carries)', () => {
  // Live evidence: with `ankles: out`, the draft proposed Sumo Deadlift 4×8 — a
  // HINGE, which the original squat/lunge-only map (#1044) missed. This locks in the
  // widened net while keeping seated/lying/machine-supported work eligible.
  const catalog: CatalogExercise[] = [
    // Excluded families under a standing/dynamic ankle load:
    ex({ id: 'sumo', name: 'Sumo Deadlift (Barbell)', primaryMuscle: 'glutes', equipment: 'barbell', daysSinceLast: 5 }),
    ex({ id: 'rdl', name: 'Romanian Deadlift', primaryMuscle: 'hamstrings', equipment: 'barbell', daysSinceLast: 6 }),
    ex({ id: 'calf', name: 'Standing Calf Raise', primaryMuscle: 'calves', equipment: 'machine', daysSinceLast: 7 }),
    // Live evidence #1203: these two FEDB entries name the muscle, not the raise/
    // press verb — they leaked past the phrase-only match into an ankles-out draft.
    ex({ id: 'calf2', name: 'Standing Calves', primaryMuscle: 'calves', equipment: 'body only', daysSinceLast: 7 }),
    ex({ id: 'calf3', name: 'Lever Rotary Calf', primaryMuscle: 'calves', equipment: 'machine', daysSinceLast: 7 }),
    ex({ id: 'calf4', name: 'Smith Toe Raise', primaryMuscle: 'calves', equipment: 'smith machine', daysSinceLast: 7 }),
    ex({ id: 'jump', name: 'Box Jump', primaryMuscle: 'quadriceps', equipment: 'body only', daysSinceLast: 8 }),
    ex({ id: 'carry', name: "Farmer's Carry", primaryMuscle: 'forearms', equipment: 'dumbbell', daysSinceLast: 9 }),
    // Seated / lying / machine-supported work that MUST stay eligible (not standing,
    // not ankle-bearing under dynamic load):
    ex({ id: 'legext', name: 'Leg Extension (Machine)', primaryMuscle: 'quadriceps', equipment: 'machine', mechanic: 'isolation', daysSinceLast: 5 }),
    ex({ id: 'legcurl', name: 'Seated Leg Curl', primaryMuscle: 'hamstrings', equipment: 'machine', mechanic: 'isolation', daysSinceLast: 5 }),
    ex({ id: 'adductor', name: 'Hip Adductor (Machine)', primaryMuscle: 'adductors', equipment: 'machine', mechanic: 'isolation', daysSinceLast: 5 }),
    ex({ id: 'bench', name: 'Barbell Bench Press', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 10 }),
    ex({ id: 'ohp', name: 'Seated Overhead Press', primaryMuscle: 'shoulders', equipment: 'dumbbell', daysSinceLast: 10 }),
  ]

  function ids(pools: Map<string, Pool>): Set<string> {
    const out = new Set<string>()
    for (const pool of pools.values()) for (const e of pool.exercises) out.add(e.id)
    return out
  }

  const KEPT = ['legext', 'legcurl', 'adductor', 'bench', 'ohp'] as const

  it('an out ankle injury excludes hinges, calf raises, jumps, and carries', () => {
    const present = ids(buildPools(catalog, null, [{ region: 'ankles', severity: 'out' }]))
    for (const id of ['sumo', 'rdl', 'calf', 'calf2', 'calf3', 'calf4', 'jump', 'carry']) {
      expect(present.has(id)).toBe(false)
    }
    // Seated/lying/machine-supported work stays eligible — not over-excluded.
    for (const id of KEPT) expect(present.has(id)).toBe(true)
  })

  it('an out knee injury excludes hinges/jumps/carries and standing calf work', () => {
    const present = ids(buildPools(catalog, null, [{ region: 'knees', severity: 'out' }]))
    for (const id of ['sumo', 'rdl', 'jump', 'carry']) {
      expect(present.has(id)).toBe(false)
    }
    // Calf work articulates the ankle but standing variants still stabilize the knee.
    expect(present.has('calf')).toBe(false)
    expect(present.has('calf2')).toBe(false)
    expect(present.has('calf3')).toBe(false)
    expect(present.has('calf4')).toBe(false)
    for (const id of ['legext', 'legcurl']) expect(present.has(id)).toBe(false)
    for (const id of ['adductor', 'bench', 'ohp']) expect(present.has(id)).toBe(true)
  })

  it('a nagging ankle injury does not restrict any of the widened patterns', () => {
    const present = ids(buildPools(catalog, null, [{ region: 'ankles', severity: 'nagging' }]))
    for (const id of ['sumo', 'rdl', 'calf', 'calf2', 'calf3', 'calf4', 'jump', 'carry']) {
      expect(present.has(id)).toBe(true)
    }
  })

  // Live leak #2: an ankles-out draft led with "barbell clean and press" — the
  // "press" token classified it as a push, no pattern owned "clean". Olympic /
  // explosive triple-extension lifts now classify 'olympic' (rule listed FIRST)
  // and are excluded for out/limiting ankles AND knees.
  it('an out ankle or knee injury excludes olympic/explosive lifts (clean-and-press leak)', () => {
    const oly: CatalogExercise[] = [
      ex({ id: 'cnp', name: 'barbell clean and press', primaryMuscle: 'quadriceps', equipment: 'barbell', daysSinceLast: 5 }),
      ex({ id: 'snatch', name: 'Dumbbell Snatch', primaryMuscle: 'shoulders', equipment: 'dumbbell', daysSinceLast: 6 }),
      ex({ id: 'pushpress', name: 'Push Press', primaryMuscle: 'shoulders', equipment: 'barbell', daysSinceLast: 7 }),
      ex({ id: 'ohp2', name: 'Seated Overhead Press', primaryMuscle: 'shoulders', equipment: 'dumbbell', daysSinceLast: 8 }),
    ]
    for (const region of ['ankles', 'knees'] as const) {
      const present = ids(buildPools(oly, null, [{ region, severity: 'out' }]))
      for (const id of ['cnp', 'snatch', 'pushpress']) expect(present.has(id)).toBe(false)
      // A seated press has no triple-extension component — stays eligible.
      expect(present.has('ohp2')).toBe(true)
    }
  })

  it('classifies olympic lifts ahead of their press/pull tokens', () => {
    const p = (name: string) => movementPattern({ name, primaryMuscle: null, force: null, mechanic: null })
    expect(p('barbell clean and press')).toBe('olympic')
    expect(p('Power Snatch')).toBe('olympic')
    expect(p('Split Jerk')).toBe('olympic')
    expect(p('Barbell High Pull')).toBe('olympic')
    expect(p('Push Press')).toBe('olympic')
    // No false positives on ordinary presses/pulls:
    expect(p('Seated Overhead Press')).not.toBe('olympic')
    expect(p('Lat Pulldown')).not.toBe('olympic')
  })
})

describe('buildPools — stability/agility drill joint-load gate (balance-board leak)', () => {
  // Live evidence: with `ankles: out`, a Shuffle dealt "balance board" and "quick
  // feet v. 2" — ankle-stability drills no movement class caught. They credit a leg
  // muscle as primary (so they sit in a region pool) but the contraindication is the
  // joint, so the widened joint-load map must exclude the `stability` pattern too.
  const catalog: CatalogExercise[] = [
    ex({ id: 'balance', name: 'Balance Board', primaryMuscle: 'calves', equipment: 'body only', daysSinceLast: 5 }),
    ex({ id: 'quickfeet', name: 'Quick Feet v. 2', primaryMuscle: 'quadriceps', equipment: 'body only', daysSinceLast: 6 }),
    ex({ id: 'agility', name: 'Agility Ladder', primaryMuscle: 'quadriceps', equipment: 'body only', daysSinceLast: 7 }),
    ex({ id: 'bench', name: 'Barbell Bench Press', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 10 }),
  ]
  function ids(pools: Map<string, Pool>): Set<string> {
    const out = new Set<string>()
    for (const pool of pools.values()) for (const e of pool.exercises) out.add(e.id)
    return out
  }

  it('an out ankle injury excludes balance/agility/stability drills', () => {
    const present = ids(buildPools(catalog, null, [{ region: 'ankles', severity: 'out' }]))
    expect(present.has('balance')).toBe(false)
    expect(present.has('quickfeet')).toBe(false)
    expect(present.has('agility')).toBe(false)
    expect(present.has('bench')).toBe(true)
  })

  it('a limiting knee injury also excludes them (single-leg balance loads the knee)', () => {
    const present = ids(buildPools(catalog, null, [{ region: 'knees', severity: 'limiting' }]))
    expect(present.has('balance')).toBe(false)
    expect(present.has('quickfeet')).toBe(false)
    expect(present.has('agility')).toBe(false)
  })

  it('no injury leaves stability drills in their region pools', () => {
    const present = ids(buildPools(catalog, null))
    expect(present.has('balance')).toBe(true)
    expect(present.has('quickfeet')).toBe(true)
    expect(present.has('agility')).toBe(true)
  })
})

describe('buildPools — degenerate bare-muscle-name rows', () => {
  // Live evidence: a Shuffle dealt an exercise literally named "quads" — a degenerate
  // imported catalog row. Bare muscle-word names are never real movements, so they're
  // kept out of the rotation pools (pool-eligibility only; the row is never deleted).
  it('excludes rows whose name is exactly a muscle/region word', () => {
    const catalog: CatalogExercise[] = [
      ex({ id: 'good', name: 'Barbell Squat', primaryMuscle: 'quadriceps', equipment: 'barbell', daysSinceLast: 5 }),
      ex({ id: 'degen-quads', name: 'quads', primaryMuscle: 'quadriceps', equipment: 'barbell', daysSinceLast: 5 }),
      ex({ id: 'degen-chest', name: 'Chest', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 5 }),
      ex({ id: 'degen-hams', name: 'Hamstrings', primaryMuscle: 'hamstrings', equipment: 'barbell', daysSinceLast: 5 }),
    ]
    const pools = buildPools(catalog, null)
    const present = new Set([...pools.values()].flatMap((p) => p.exercises.map((e) => e.id)))
    expect(present.has('good')).toBe(true)
    expect(present.has('degen-quads')).toBe(false)
    expect(present.has('degen-chest')).toBe(false)
    expect(present.has('degen-hams')).toBe(false)
  })
})

describe('poolDepthForRegion', () => {
  const catalog: CatalogExercise[] = [
    ex({ id: 'bench', name: 'Barbell Bench Press', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 10 }),
    ex({ id: 'incline', name: 'Incline Dumbbell Press', primaryMuscle: 'chest', equipment: 'dumbbell', daysSinceLast: 20 }),
    ex({ id: 'pulldown', name: 'Lat Pulldown', primaryMuscle: 'lats', equipment: 'cable', daysSinceLast: 15 }),
  ]
  const pools = buildPools(catalog, null)

  it('counts distinct eligible exercises per region', () => {
    expect(poolDepthForRegion(pools, 'chest')).toBe(2)
    expect(poolDepthForRegion(pools, 'lats')).toBe(1)
    expect(poolDepthForRegion(pools, 'quads')).toBe(0)
  })

  it('drops with an injury that guts the region pool', () => {
    const catalog2: CatalogExercise[] = [
      ex({ id: 'sq', name: 'Barbell Squat', primaryMuscle: 'quadriceps', equipment: 'barbell', daysSinceLast: 5 }),
      ex({ id: 'lg', name: 'Walking Lunge', primaryMuscle: 'quadriceps', equipment: 'body only', daysSinceLast: 6 }),
    ]
    const full = buildPools(catalog2, null)
    const gutted = buildPools(catalog2, null, [{ region: 'ankles', severity: 'out' }])
    expect(poolDepthForRegion(full, 'quads')).toBe(2)
    expect(poolDepthForRegion(gutted, 'quads')).toBe(0)
  })
})

describe('dealSlate determinism', () => {
  const catalog: CatalogExercise[] = [
    ex({ id: 'a', name: 'Barbell Bench Press', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 10 }),
    ex({ id: 'b', name: 'Dumbbell Bench Press', primaryMuscle: 'chest', equipment: 'dumbbell', daysSinceLast: 40 }),
    ex({ id: 'c', name: 'Incline Dumbbell Press', primaryMuscle: 'chest', equipment: 'dumbbell', daysSinceLast: 20 }),
    ex({ id: 'd', name: 'Cable Fly', primaryMuscle: 'chest', equipment: 'cable', daysSinceLast: 60 }),
    ex({ id: 'row', name: 'Barbell Row', primaryMuscle: 'middle back', equipment: 'barbell', daysSinceLast: 8 }),
    ex({ id: 'pull', name: 'Lat Pulldown', primaryMuscle: 'lats', equipment: 'cable', daysSinceLast: 15 }),
  ]
  const pools = buildPools(catalog, null)
  const targets: RegionTarget[] = [
    { region: 'chest', workingSets: 9 },
    { region: 'lats', workingSets: 6 },
  ]

  it('same seed ⇒ identical slate', () => {
    const seed = seedFromString('2026-07-10|draft||')
    const s1 = dealSlate(pools, targets, mulberry32(seed))
    const s2 = dealSlate(pools, targets, mulberry32(seed))
    expect(s1.exercises.map((e) => e.exerciseId)).toEqual(s2.exercises.map((e) => e.exerciseId))
  })

  it('different seed can produce a different slate', () => {
    const a = dealSlate(pools, targets, mulberry32(seedFromString('seed-A'))).exercises.map((e) => e.exerciseId)
    const b = dealSlate(pools, targets, mulberry32(seedFromString('seed-B'))).exercises.map((e) => e.exerciseId)
    // Not a hard guarantee they differ (small pools), but the seeds are independent;
    // at minimum the call is deterministic per seed (already covered). Assert both
    // are valid ids and non-empty.
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
    for (const id of [...a, ...b]) expect(['a', 'b', 'c', 'd', 'row', 'pull']).toContain(id)
  })

  it('never repeats an exercise within a slate', () => {
    const s = dealSlate(pools, targets, mulberry32(seedFromString('x')))
    const ids = s.exercises.map((e) => e.exerciseId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('honors the exclude set (shuffle away from prior ids)', () => {
    const s = dealSlate(pools, targets, mulberry32(seedFromString('x')), { exclude: ['a', 'b'] })
    const ids = s.exercises.map((e) => e.exerciseId)
    expect(ids).not.toContain('a')
    expect(ids).not.toContain('b')
  })

  it('conserves per-region volume within ±20% of the target split', () => {
    const s = dealSlate(pools, targets, mulberry32(seedFromString('x')))
    const vol = regionVolume(s.exercises.map((e) => ({ region: e.region, sets: e.sets })))
    const anchor = new Map<MuscleRegion, number>([
      ['chest', 9],
      ['lats', 6],
    ])
    const check = checkVolumeConservation(anchor, vol, 0.2)
    expect(check.ok).toBe(true)
  })
})

describe('dealSlate tune mode (anchor template)', () => {
  const catalog: CatalogExercise[] = [
    ex({ id: 'bench', name: 'Barbell Bench Press', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 3 }),
    ex({ id: 'incline', name: 'Incline Dumbbell Press', primaryMuscle: 'chest', equipment: 'dumbbell', daysSinceLast: 50 }),
    ex({ id: 'fly', name: 'Cable Fly', primaryMuscle: 'chest', equipment: 'cable', daysSinceLast: 40 }),
  ]
  const pools = buildPools(catalog, null)

  it('keeps un-flagged anchor exercises verbatim', () => {
    const s = dealSlate(
      pools,
      [{ region: 'chest', workingSets: 6 }],
      mulberry32(seedFromString('t')),
      { anchorTemplate: [{ exerciseId: 'bench', region: 'chest' }] },
    )
    expect(s.exercises).toHaveLength(1)
    expect(s.exercises[0]!.exerciseId).toBe('bench')
    expect(s.exercises[0]!.fromAnchor).toBe(true)
  })

  it('swaps a flagged anchor exercise for a pool pick', () => {
    const s = dealSlate(
      pools,
      [{ region: 'chest', workingSets: 6 }],
      mulberry32(seedFromString('t')),
      { anchorTemplate: [{ exerciseId: 'bench', region: 'chest', swap: true }] },
    )
    expect(s.exercises).toHaveLength(1)
    expect(s.exercises[0]!.exerciseId).not.toBe('bench')
    expect(s.exercises[0]!.fromAnchor).toBe(false)
    expect(['incline', 'fly']).toContain(s.exercises[0]!.exerciseId)
  })
})

describe('weightedPick', () => {
  const mk = (id: string, staleness: number): PoolExercise => ({
    id,
    name: id,
    pattern: 'other',
    equipmentClass: 'other',
    region: 'chest',
    staleness,
    daysSinceLast: null,
    injuryProfile: fixtureInjuryProfile({
      name: id,
      category: 'chest',
      primaryMuscle: 'chest',
      secondaryMuscles: [],
      equipment: null,
      modality: 'strength',
      instructions: ['Lie on your back.'],
    }),
    preferred: false,
  })

  it('returns null on empty and the sole element on singleton', () => {
    expect(weightedPick([], mulberry32(1))).toBeNull()
    const one = mk('x', 5)
    expect(weightedPick([one], mulberry32(1))).toBe(one)
  })

  it('is deterministic for a given rng and can pick a fresh (0-staleness) candidate', () => {
    const cands = [mk('stale', 90), mk('fresh', 0)]
    // With a fixed rng the same pick repeats.
    const a = weightedPick(cands, mulberry32(42))
    const b = weightedPick(cands, mulberry32(42))
    expect(a!.id).toBe(b!.id)
    // Over many seeds the fresh one is still reachable (epsilon floor).
    const picked = new Set<string>()
    for (let i = 0; i < 200; i += 1) picked.add(weightedPick(cands, mulberry32(i))!.id)
    expect(picked.has('fresh')).toBe(true)
    expect(picked.has('stale')).toBe(true)
  })
})

describe('alternativesFor', () => {
  const catalog: CatalogExercise[] = [
    ex({ id: 'a', name: 'Barbell Bench Press', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 5 }),
    ex({ id: 'b', name: 'Dumbbell Bench Press', primaryMuscle: 'chest', equipment: 'dumbbell', daysSinceLast: 50 }),
    ex({ id: 'c', name: 'Cable Fly', primaryMuscle: 'chest', equipment: 'cable', daysSinceLast: 20 }),
  ]
  const pools = buildPools(catalog, null)

  it('returns same-region alternatives ranked by staleness, excluding the source', () => {
    const alts = alternativesFor(pools, 'chest', 'a', 5)
    const ids = alts.map((e) => e.id)
    expect(ids).not.toContain('a')
    expect(ids[0]).toBe('b') // staleness 50 > 20
    expect(ids).toContain('c')
  })

  it('respects the count cap', () => {
    expect(alternativesFor(pools, 'chest', 'a', 1)).toHaveLength(1)
    expect(alternativesFor(pools, 'chest', 'a', 0)).toHaveLength(0)
  })

  // #1876 — the "Preferred it" replace-reason chip ranks ahead of staleness.
  it('ranks a preferred exercise first even though it is staler-ranked lower', () => {
    const preferredCatalog: CatalogExercise[] = [
      ex({ id: 'a', name: 'Barbell Bench Press', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 5 }),
      ex({ id: 'b', name: 'Dumbbell Bench Press', primaryMuscle: 'chest', equipment: 'dumbbell', daysSinceLast: 50 }),
      ex({ id: 'c', name: 'Cable Fly', primaryMuscle: 'chest', equipment: 'cable', daysSinceLast: 20, preferred: true }),
    ]
    const preferredPools = buildPools(preferredCatalog, null)
    const ids = alternativesFor(preferredPools, 'chest', 'a', 5).map((e) => e.id)
    expect(ids[0]).toBe('c') // preferred, despite staleness 20 < 50
  })
})

// #1876 — ranking on the FULL muscle profile (primary + secondary), not primary alone.
describe('alternativesForProfile', () => {
  const catalog: CatalogExercise[] = [
    ex({ id: 'reverse-curl', name: 'Reverse Curl', primaryMuscle: 'biceps', secondaryMuscles: ['forearms'], equipment: 'barbell', daysSinceLast: 5 }),
    ex({ id: 'preacher-curl', name: 'Preacher Curl', primaryMuscle: 'biceps', equipment: 'barbell', daysSinceLast: 40 }),
    // Named without "curl" so it doesn't ALSO trip the generic curl→biceps name
    // rule — its only muscle credit is the "wrist"→forearms name rule + the
    // forearms catalog column, giving a clean forearms-only primary hit.
    ex({ id: 'wrist-roller', name: 'Wrist Roller', primaryMuscle: 'forearms', equipment: 'dumbbell', daysSinceLast: 60 }),
  ]
  const pools = buildPools(catalog, null)
  const profile = musclesForExerciseEnriched('Reverse Curl', 'biceps', ['forearms'])

  it('surfaces a candidate from a SECONDARY region the primary-only alternativesFor never would', () => {
    // The reverse curl's whole point is forearms, but its primary_muscle column
    // says biceps — the exact catalog shape behind #1876. Primary-region-only
    // ranking never sees the forearm exercise at all.
    expect(alternativesFor(pools, 'biceps', 'reverse-curl', 8).map((e) => e.id)).not.toContain('wrist-roller')
    expect(alternativesForProfile(pools, profile, 'reverse-curl', 8).map((e) => e.id)).toContain('wrist-roller')
  })

  it('ranks a primary-region match (weight 1) above a secondary-region match (weight 0.5)', () => {
    const ids = alternativesForProfile(pools, profile, 'reverse-curl', 8).map((e) => e.id)
    expect(ids.indexOf('preacher-curl')).toBeLessThan(ids.indexOf('wrist-roller'))
  })

  it('excludes the source and respects the count cap', () => {
    const ids = alternativesForProfile(pools, profile, 'reverse-curl', 8).map((e) => e.id)
    expect(ids).not.toContain('reverse-curl')
    expect(alternativesForProfile(pools, profile, 'reverse-curl', 1)).toHaveLength(1)
  })

  it('empty profile ⇒ empty list', () => {
    expect(alternativesForProfile(pools, [], 'reverse-curl', 8)).toEqual([])
  })
})

describe('checkVolumeConservation', () => {
  const anchor = new Map<MuscleRegion, number>([
    ['chest', 10],
    ['lats', 8],
  ])

  it('passes when every region is within ±20%', () => {
    const actual = new Map<MuscleRegion, number>([
      ['chest', 11],
      ['lats', 7],
    ])
    expect(checkVolumeConservation(anchor, actual).ok).toBe(true)
  })

  it('flags a region that drifts below the band', () => {
    const actual = new Map<MuscleRegion, number>([
      ['chest', 5], // < 8
      ['lats', 8],
    ])
    const r = checkVolumeConservation(anchor, actual)
    expect(r.ok).toBe(false)
    expect(r.violations.map((v) => v.region)).toContain('chest')
  })

  it('flags a region entirely missing from actual', () => {
    const actual = new Map<MuscleRegion, number>([['chest', 10]])
    const r = checkVolumeConservation(anchor, actual)
    expect(r.violations.map((v) => v.region)).toContain('lats')
  })

  it('is asymmetric — a net-new region in actual is not a violation', () => {
    const actual = new Map<MuscleRegion, number>([
      ['chest', 10],
      ['lats', 8],
      ['biceps', 6], // not in anchor — allowed
    ])
    expect(checkVolumeConservation(anchor, actual).ok).toBe(true)
  })

  it('ignores anchor regions with zero sets', () => {
    const a = new Map<MuscleRegion, number>([['chest', 0]])
    expect(checkVolumeConservation(a, new Map()).ok).toBe(true)
  })
})

// ── P3-A3: snooze cooldown + per-gym exclusion ──────────────────────────────
describe('isSnoozed (temporary "Bored of it" cooldown)', () => {
  const now = new Date('2026-07-10T00:00:00Z')
  it('null / past → not snoozed; future → snoozed', () => {
    expect(isSnoozed(null, now)).toBe(false)
    expect(isSnoozed(undefined, now)).toBe(false)
    expect(isSnoozed('2026-07-01T00:00:00Z', now)).toBe(false)
    expect(isSnoozed('2026-07-20T00:00:00Z', now)).toBe(true)
    expect(isSnoozed(new Date('2026-07-20T00:00:00Z'), now)).toBe(true)
  })
})

describe('buildPools — snooze filter', () => {
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString()
  it('excludes a snoozed exercise from every pool', () => {
    const catalog: CatalogExercise[] = [
      ex({ id: 'a', name: 'Barbell Bench Press', primaryMuscle: 'chest' }),
      ex({ id: 'b', name: 'Dumbbell Bench Press', primaryMuscle: 'chest', snoozedUntil: soon }),
    ]
    const pools = buildPools(catalog, null)
    const allIds = [...pools.values()].flatMap((p) => p.exercises.map((e) => e.id))
    expect(allIds).toContain('a')
    expect(allIds).not.toContain('b')
  })
  it('re-includes an exercise whose snooze has lapsed', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    const pools = buildPools([ex({ id: 'a', name: 'Barbell Bench Press', primaryMuscle: 'chest', snoozedUntil: past })], null)
    const allIds = [...pools.values()].flatMap((p) => p.exercises.map((e) => e.id))
    expect(allIds).toContain('a')
  })
})

describe('gymCompatible — machines_excluded (per-gym "Not available here")', () => {
  it('an excluded name fails regardless of equipment match', () => {
    expect(gymCompatible({ name: 'Leg Press', equipment: 'machine' }, ['machine'], ['leg press'])).toBe(false)
  })
  it('other exercises stay compatible when a different name is excluded', () => {
    expect(gymCompatible({ name: 'Barbell Squat', equipment: 'barbell' }, ['barbell'], ['leg press'])).toBe(true)
  })
  it('exclusion is case-insensitive', () => {
    expect(gymCompatible({ name: 'Leg Press', equipment: 'machine' }, null, ['LEG PRESS'])).toBe(false)
  })
})

describe('buildPools — structured equipment shape flows exclusions', () => {
  it('excludes a machines_excluded name via the structured jsonb', () => {
    const catalog: CatalogExercise[] = [
      ex({ id: 'lp', name: 'Leg Press', primaryMuscle: 'quads', equipment: 'machine' }),
      ex({ id: 'sq', name: 'Barbell Squat', primaryMuscle: 'quads', equipment: 'barbell' }),
    ]
    const pools = buildPools(catalog, { categories: ['machine', 'barbell'], machines: [], machines_excluded: ['Leg Press'] })
    const ids = [...pools.values()].flatMap((p) => p.exercises.map((e) => e.id))
    expect(ids).toContain('sq')
    expect(ids).not.toContain('lp')
  })
})

describe('equipment shape flatteners', () => {
  it('gymEquipmentTokens flattens categories + machines; array passthrough', () => {
    expect(gymEquipmentTokens(['barbell'])).toEqual(['barbell'])
    expect(gymEquipmentTokens({ categories: ['cable'], machines: ['Row'], machines_excluded: ['x'] })).toEqual(['cable', 'Row'])
    expect(gymEquipmentTokens(null)).toBeNull()
    expect(gymEquipmentTokens({ categories: [], machines: [] })).toBeNull()
  })
  it('gymExcludedNames only comes from the structured shape (lowercased)', () => {
    expect(gymExcludedNames(['barbell'])).toEqual([])
    expect(gymExcludedNames({ machines_excluded: ['Leg Press', 'Dip'] })).toEqual(['leg press', 'dip'])
  })
})

describe('poolExclusionReason — the silent no-muscle case', () => {
  // Regression 2026-08-26: buildPools' LAST filter drops any exercise resolving
  // to no primary region, but poolExclusionReason never mirrored it, so such a
  // row returned null — "would be eligible" — while being absent from search and
  // every drafted workout. Live case: "Kegels", primary_muscle NULL, active and
  // liked, returned zero matches with no explanation.
  it('names the missing muscle instead of claiming the exercise is eligible', () => {
    const kegels = ex({ id: 'k1', name: 'Kegels', primaryMuscle: null })
    expect(buildPools([kegels], null, []).size).toBe(0)
    expect(poolExclusionReason(kegels, null, [])).toMatch(/no primary muscle/i)
  })

  it('setting the muscle makes it both pooled and un-flagged', () => {
    const fixed = ex({ id: 'k2', name: 'Kegels', primaryMuscle: 'abdominals' })
    expect(buildPools([fixed], null, []).size).toBeGreaterThan(0)
    expect(poolExclusionReason(fixed, null, [])).toBeNull()
  })

  it('still returns null for a genuinely eligible exercise', () => {
    const ok = ex({ id: 'b1', name: 'Bench Press (Dumbbell)', primaryMuscle: 'chest', equipment: 'dumbbell' })
    expect(poolExclusionReason(ok, null, [])).toBeNull()
  })

  it('keeps reporting the louder reasons first', () => {
    const disliked = ex({ id: 'd1', name: 'Burpee', primaryMuscle: null, disliked: true })
    expect(poolExclusionReason(disliked, null, [])).toBe('marked disliked')
  })
})

describe('injuryOverride — clearing ONE movement past the injury gate', () => {
  const ankleOut = [{ region: 'ankles' as const, severity: 'out' as const }]

  it('an injury-blocked exercise stays blocked without an override', () => {
    const squat = ex({ id: 's1', name: 'Back Squat', primaryMuscle: 'quadriceps', equipment: 'barbell' })
    expect(buildPools([squat], null, ankleOut).size).toBe(0)
    expect(poolExclusionReason(squat, null, ankleOut)).toMatch(/injury/i)
  })

  it('the override puts that ONE exercise back in a pool and clears its reason', () => {
    const cleared = ex({
      id: 's2',
      name: 'Back Squat',
      primaryMuscle: 'quadriceps',
      equipment: 'barbell',
      injuryOverride: true,
    })
    expect(buildPools([cleared], null, ankleOut).size).toBeGreaterThan(0)
    expect(poolExclusionReason(cleared, null, ankleOut)).toBeNull()
  })

  it('does NOT clear anything else — the override is per-exercise', () => {
    const cleared = ex({ id: 'a', name: 'Back Squat', primaryMuscle: 'quadriceps', equipment: 'barbell', injuryOverride: true })
    const other = ex({ id: 'b', name: 'Front Squat', primaryMuscle: 'quadriceps', equipment: 'barbell' })
    const pools = buildPools([cleared, other], null, ankleOut)
    const names = [...pools.values()].flatMap((pl) => pl.exercises.map((e) => e.name))
    expect(names).toContain('Back Squat')
    expect(names).not.toContain('Front Squat')
  })

  it('an override does not rescue an exercise excluded for a NON-injury reason', () => {
    const disliked = ex({ id: 'c', name: 'Burpee', primaryMuscle: 'quadriceps', disliked: true, injuryOverride: true })
    expect(buildPools([disliked], null, ankleOut).size).toBe(0)
    expect(poolExclusionReason(disliked, null, ankleOut)).toBe('marked disliked')
  })
})
