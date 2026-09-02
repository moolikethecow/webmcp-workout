/**
 * Draft generation (lib/gym/plan.ts).
 *
 * The PURE pieces (focus/region mapping, region targets, injury steering,
 * context hash, the fallback dealer) are tested directly. `generatePlan` is
 * exercised with `assembleCoachContext` and `db.execute` mocked.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'

import { sqlText, collapseWs } from './sql-text'
import {
  buildPools,
  seedFromString,
  mulberry32,
  dealSlate,
  type CatalogExercise,
  type Pool,
  type RegionTarget,
} from '../novelty'
import type { MuscleRegion } from '@/lib/fitness/muscles'
import type { CoachContext } from '../coach-context'
import { fixtureInjuryProfile } from './injury-fixtures'

// ── mocks (hoisted) ──────────────────────────────────────────────────────────
const mockExecute = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/client', () => ({ db: { execute: mockExecute, transaction: mockTransaction } }))

const mockAssemble = vi.hoisted(() => vi.fn())
vi.mock('../coach-context', () => ({ assembleCoachContext: mockAssemble }))

const mockGetActiveWorkout = vi.hoisted(() => vi.fn(async () => ({ id: 'w-new' })))
const mockMaterialize = vi.hoisted(() => vi.fn(async (
  _execute: (query: unknown) => Promise<unknown>,
  _workoutExerciseId: string,
  _sets: unknown[],
) => undefined))
vi.mock('../active-workout', () => ({
  getActiveWorkoutById: mockGetActiveWorkout,
  materializeSetPrescriptions: mockMaterialize,
}))

import type { Candidate } from '../plan'

const {
  buildCandidates,
  focusToRegions,
  buildRegionTargets,
  fallbackPayload,
  injurySafeFallback,
  computeContextHash,
  generatePlan,
  getTodayProposal,
  updateProposalPayload,
  withProposalEditLock,
  injuryAdjustTargets,
  anchorSplitFor,
  describeInjurySteer,
  proposalToWorkoutStart,
  ProposalWriteConflictError,
  TemplateAnchorUnavailableError,
} = await import('../plan')
const { summarizeProgrammingHistory } = await import('../programming-history')

// ── shared fixtures ──────────────────────────────────────────────────────────
function ex(p: Partial<CatalogExercise> & { id: string; name: string }): CatalogExercise {
  const row = {
    primaryMuscle: null, secondaryMuscles: [], equipment: null, force: null, mechanic: null,
    disliked: false, preferred: false, daysSinceLast: null, recentSets: 0, archived: false, ...p,
  }
  const muscle = (row.primaryMuscle ?? '').toLowerCase()
  const category = ['quadriceps', 'hamstrings', 'glutes', 'adductors', 'abductors'].includes(muscle)
    ? 'upper legs'
    : muscle === 'calves'
      ? 'lower legs'
      : muscle === 'chest'
        ? 'chest'
        : ['middle back', 'lower back', 'lats', 'traps'].includes(muscle)
          ? 'back'
          : muscle === 'shoulders'
            ? 'shoulders'
            : null
  const n = row.name.toLowerCase()
  const instructions = n.includes('hip thrust')
    ? ['Lie on your back and drive through your heels.']
    : n.includes('bench press') || n.includes('chest fly') || (n.includes('press') && !n.includes('overhead') && !n.includes('shoulder'))
      ? ['Lie on your back.']
      : n.includes('seated') || n.includes('pulldown') || n.includes('pullover')
        ? ['Sit in the machine.']
        : ['Stand and perform the movement.']
  return {
    ...row,
    injuryProfile: p.injuryProfile ?? fixtureInjuryProfile({
      name: row.name,
      category,
      primaryMuscle: row.primaryMuscle,
      secondaryMuscles: row.secondaryMuscles,
      equipment: row.equipment,
      modality: 'strength',
      instructions,
    }),
  }
}

const CATALOG: CatalogExercise[] = [
  ex({ id: 'bench', name: 'Barbell Bench Press', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 10 }),
  ex({ id: 'incline', name: 'Incline Dumbbell Press', primaryMuscle: 'chest', equipment: 'dumbbell', daysSinceLast: 45 }),
  ex({ id: 'fly', name: 'Cable Fly', primaryMuscle: 'chest', equipment: 'cable', daysSinceLast: 30 }),
  ex({ id: 'row', name: 'Barbell Row', primaryMuscle: 'middle back', equipment: 'barbell', daysSinceLast: 8 }),
  ex({ id: 'pulldown', name: 'Lat Pulldown', primaryMuscle: 'lats', equipment: 'cable', daysSinceLast: 20 }),
  ex({ id: 'curl', name: 'Dumbbell Bicep Curl', primaryMuscle: 'biceps', equipment: 'dumbbell', daysSinceLast: 15 }),
]

const POOLS = buildPools(CATALOG, null)

function candidate(p: Partial<Candidate> & { id: string; name: string; region: MuscleRegion }): Candidate {
  return {
    pattern: 'other',
    staleness: 10,
    defaultWeight: null,
    defaultReps: null,
    injuryProfile: p.injuryProfile ?? {
      schemaVersion: 1,
      provenance: 'manual-reviewed',
      sites: { [p.region]: ['primary'] },
      traits: [],
    },
    ...p,
  }
}

// ── PURE: candidate list ─────────────────────────────────────────────────────
describe('buildCandidates', () => {
  const slate = dealSlate(
    POOLS,
    [{ region: 'chest', workingSets: 9 }, { region: 'lats', workingSets: 3 }],
    mulberry32(seedFromString('cand')),
  )

  it('includes every dealt exercise (guarantees the slate is in-vocab)', () => {
    const cands = buildCandidates(slate, POOLS, new Map())
    const ids = new Set(cands.map((c) => c.id))
    for (const d of slate.exercises) expect(ids.has(d.exerciseId)).toBe(true)
  })

  it('carries history defaults onto candidates', () => {
    const defs = new Map([['bench', { weight: 225, reps: 5 }]])
    const cands = buildCandidates(slate, POOLS, defs)
    const bench = cands.find((c) => c.id === 'bench')
    if (bench) {
      expect(bench.defaultWeight).toBe(225)
      expect(bench.defaultReps).toBe(5)
    }
  })
})

// ── PURE: focus + region targets ─────────────────────────────────────────────
describe('focusToRegions', () => {
  it('maps push/pull/legs and specific muscles', () => {
    expect(focusToRegions('pull day')).toEqual(expect.arrayContaining(['lats', 'mid_back', 'biceps']))
    expect(focusToRegions('leg day')).toEqual(expect.arrayContaining(['quads', 'hamstrings', 'glutes']))
    expect(focusToRegions('chest and triceps')).toEqual(expect.arrayContaining(['chest', 'triceps']))
    expect(focusToRegions('gibberish')).toEqual([])
  })
})

describe('buildRegionTargets', () => {
  it('draft w/ focus uses the recent split where known, else a default', () => {
    const split = new Map<MuscleRegion, number>([['chest', 12]])
    const targets = buildRegionTargets({ mode: 'draft', focus: 'push', recentSplit: split })
    const chest = targets.find((t) => t.region === 'chest')
    const delts = targets.find((t) => t.region === 'delts')
    expect(chest?.workingSets).toBe(12) // from split
    expect(delts?.workingSets).toBe(9) // default
  })

  it('draft w/o focus falls back to the recent split, then a balanced default', () => {
    const split = new Map<MuscleRegion, number>([['quads', 10], ['chest', 8]])
    const targets = buildRegionTargets({ mode: 'draft', recentSplit: split })
    expect(targets.map((t) => t.region)).toEqual(expect.arrayContaining(['quads', 'chest']))

    const empty = buildRegionTargets({ mode: 'draft', recentSplit: new Map() })
    expect(empty.length).toBeGreaterThan(0) // balanced default
  })

  it('tune preserves the anchor regions', () => {
    const targets = buildRegionTargets({
      mode: 'tune',
      recentSplit: new Map(),
      anchorRegions: ['chest', 'chest', 'lats'],
    })
    const chest = targets.find((t) => t.region === 'chest')
    expect(chest?.workingSets).toBe(6) // 2 chest slots × 3
  })

  it('uses body-map recovery state instead of repeating the busiest muscles', () => {
    const targets = buildRegionTargets({
      mode: 'draft',
      recentSplit: new Map<MuscleRegion, number>([
        ['chest', 15],
        ['lats', 9],
        ['quads', 6],
      ]),
      muscleState: [
        { region: 'chest', state: 'recovering', daysSince: 1, weeklySets: 15 },
        { region: 'lats', state: 'ready', daysSince: 4, weeklySets: 9 },
        { region: 'quads', state: 'undertrained', daysSince: 8, weeklySets: 1 },
      ],
      readinessZone: 'Primed',
    })
    expect(targets.map((target) => target.region)).toEqual(['quads', 'lats'])
    expect(targets.map((target) => target.region)).not.toContain('chest')
  })

  it('reduces explicit recovering work and low-readiness volume deterministically', () => {
    const [target] = buildRegionTargets({
      mode: 'draft',
      focus: 'chest',
      recentSplit: new Map<MuscleRegion, number>([['chest', 12]]),
      muscleState: [
        { region: 'chest', state: 'recovering', daysSince: 1, weeklySets: 12 },
      ],
      readinessZone: 'Low',
    })
    expect(target).toEqual({ region: 'chest', workingSets: 5 })
  })
})

// ── PURE: injury-aware split steering ────────────────────────────────────────
describe('injuryAdjustTargets', () => {
  // Lower body is all standing/dynamic ankle-load (gutted when ankles are out);
  // upper body stays viable. chest depth 3, lats depth 3, delts depth 2.
  const INJ_CATALOG: CatalogExercise[] = [
    ex({ id: 'sq', name: 'Barbell Squat', primaryMuscle: 'quadriceps', equipment: 'barbell', daysSinceLast: 5 }),
    ex({ id: 'lg', name: 'Walking Lunge', primaryMuscle: 'quadriceps', equipment: 'body only', daysSinceLast: 6 }),
    ex({ id: 'ht', name: 'Barbell Hip Thrust', primaryMuscle: 'glutes', equipment: 'barbell', daysSinceLast: 7 }),
    ex({ id: 'sumo', name: 'Sumo Deadlift', primaryMuscle: 'glutes', equipment: 'barbell', daysSinceLast: 8 }),
    ex({ id: 'bench', name: 'Barbell Bench Press', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 10 }),
    ex({ id: 'incline', name: 'Incline Dumbbell Press', primaryMuscle: 'chest', equipment: 'dumbbell', daysSinceLast: 12 }),
    ex({ id: 'dbfly', name: 'Dumbbell Chest Fly', primaryMuscle: 'chest', equipment: 'dumbbell', daysSinceLast: 14 }),
    ex({ id: 'pulldown', name: 'Lat Pulldown', primaryMuscle: 'lats', equipment: 'cable', daysSinceLast: 9 }),
    ex({ id: 'pullover', name: 'Cable Pullover', primaryMuscle: 'lats', equipment: 'cable', daysSinceLast: 11 }),
    ex({ id: 'srow', name: 'Seated Cable Row', primaryMuscle: 'lats', equipment: 'cable', daysSinceLast: 13 }),
    ex({ id: 'ohp', name: 'Seated Overhead Press', primaryMuscle: 'shoulders', equipment: 'dumbbell', daysSinceLast: 10 }),
    ex({ id: 'lat-raise', name: 'Dumbbell Lateral Raise', primaryMuscle: 'shoulders', equipment: 'dumbbell', daysSinceLast: 13 }),
  ]
  const RECENT = new Map<MuscleRegion, number>([
    ['quads', 12], ['glutes', 10], ['chest', 9], ['lats', 8],
  ])

  it('is a no-op when no out/limiting injury is active (uninjured path unchanged)', () => {
    const pools = buildPools(INJ_CATALOG, null)
    const targets: RegionTarget[] = [{ region: 'quads', workingSets: 9 }]
    const adj = injuryAdjustTargets({ targets, pools, injuries: [], recentSplit: RECENT })
    expect(adj.targets).toBe(targets) // same ref — untouched
    expect(adj.steered).toBe(false)
    expect(adj.allGutted).toBe(false)
  })

  it('drops ankle-gutted lower-body regions and substitutes viable upper-body ones', () => {
    const pools = buildPools(INJ_CATALOG, null, [{ region: 'ankles', severity: 'out' }])
    const targets: RegionTarget[] = [
      { region: 'quads', workingSets: 12 },
      { region: 'glutes', workingSets: 10 },
    ]
    const adj = injuryAdjustTargets({
      targets, pools, injuries: [{ region: 'ankles', severity: 'out' }], recentSplit: RECENT,
    })
    const regions = adj.targets.map((t) => t.region)
    expect(regions).not.toContain('quads')
    expect(regions).not.toContain('glutes')
    expect(adj.droppedRegions).toEqual(expect.arrayContaining(['quads', 'glutes']))
    expect(adj.addedRegions.length).toBeGreaterThan(0)
    // Substitutes are viable upper-body regions (chest/lats have depth ≥ 3).
    for (const r of adj.addedRegions) expect(['chest', 'lats']).toContain(r)
    expect(adj.steered).toBe(true)
    expect(adj.allGutted).toBe(false)
  })

  it('keeps viable target regions and only drops the gutted ones', () => {
    const pools = buildPools(INJ_CATALOG, null, [{ region: 'ankles', severity: 'out' }])
    const targets: RegionTarget[] = [
      { region: 'quads', workingSets: 12 }, // gutted
      { region: 'chest', workingSets: 9 }, // viable — kept
    ]
    const adj = injuryAdjustTargets({
      targets, pools, injuries: [{ region: 'ankles', severity: 'out' }], recentSplit: RECENT,
    })
    expect(adj.targets.map((t) => t.region)).toContain('chest')
    expect(adj.droppedRegions).toContain('quads')
  })

  it('drops a directly "out" muscle region even when its pool is full', () => {
    // No joint injury → quads pool keeps squat/lunge; but quads itself is "out".
    const pools = buildPools(INJ_CATALOG, null, [{ region: 'quads', severity: 'out' }])
    const targets: RegionTarget[] = [
      { region: 'quads', workingSets: 9 },
      { region: 'chest', workingSets: 9 },
    ]
    const adj = injuryAdjustTargets({
      targets, pools, injuries: [{ region: 'quads', severity: 'out' }], recentSplit: RECENT,
    })
    expect(adj.targets.map((t) => t.region)).not.toContain('quads')
    expect(adj.droppedRegions).toContain('quads')
    expect(adj.targets.map((t) => t.region)).toContain('chest')
  })

  it('flags allGutted (keeps the original split) when nothing viable remains', () => {
    // Only lower-body work exists; ankles out → every pool is empty, no substitute.
    const lowerOnly: CatalogExercise[] = [
      ex({ id: 'sq', name: 'Barbell Squat', primaryMuscle: 'quadriceps', equipment: 'barbell', daysSinceLast: 5 }),
      ex({ id: 'lg', name: 'Walking Lunge', primaryMuscle: 'quadriceps', equipment: 'body only', daysSinceLast: 6 }),
      ex({ id: 'ht', name: 'Barbell Hip Thrust', primaryMuscle: 'glutes', equipment: 'barbell', daysSinceLast: 7 }),
    ]
    const pools = buildPools(lowerOnly, null, [{ region: 'ankles', severity: 'out' }])
    const targets: RegionTarget[] = [
      { region: 'quads', workingSets: 9 },
      { region: 'glutes', workingSets: 9 },
    ]
    const adj = injuryAdjustTargets({
      targets, pools, injuries: [{ region: 'ankles', severity: 'out' }],
      recentSplit: new Map<MuscleRegion, number>([['quads', 9], ['glutes', 9]]),
    })
    expect(adj.allGutted).toBe(true)
    expect(adj.targets).toBe(targets) // original split kept
    expect(adj.steered).toBe(false)
  })
})

describe('describeInjurySteer', () => {
  it('describes a steered split (dropped + added) mentioning the injury', () => {
    const note = describeInjurySteer(
      { targets: [], droppedRegions: ['quads', 'glutes'], addedRegions: ['chest', 'lats'], steered: true, allGutted: false },
      [{ region: 'ankles', severity: 'out' }],
    )
    expect(note).toMatch(/recorded injury constraints shifted/i)
    expect(note).toContain('Chest/Lats')
    expect(note).toContain('Quads/Glutes')
    expect(note).toContain('Ankles')
  })

  it('describes a narrowed split (dropped, nothing added)', () => {
    const note = describeInjurySteer(
      { targets: [], droppedRegions: ['quads'], addedRegions: [], steered: true, allGutted: false },
      [{ region: 'ankles', severity: 'out' }],
    )
    expect(note).toMatch(/removed Quads/i)
  })

  it('surfaces allGutted honestly', () => {
    const note = describeInjurySteer(
      { targets: [], droppedRegions: [], addedRegions: [], steered: false, allGutted: true },
      [{ region: 'ankles', severity: 'out' }],
    )
    expect(note).toMatch(/too few classified options/i)
    expect(note).toContain('Ankles')
  })

  it('returns null when nothing was steered', () => {
    const note = describeInjurySteer(
      { targets: [], droppedRegions: [], addedRegions: [], steered: false, allGutted: false },
      [],
    )
    expect(note).toBeNull()
  })
})
// ── PURE: the gate's anchor (session targets, NOT the historical split) ──────
describe('anchorSplitFor', () => {
  it('anchors on the final (capped/steered) targets, not the historical split', () => {
    // The 2026-08-18 live rejection: "keep it light" + maxExercises caps the
    // targets to 3 sets/region, but the recent split says 12–15. The gate must
    // measure the draft against the 3s (what the session actually targets).
    const targets: RegionTarget[] = [
      { region: 'lats', workingSets: 3 },
      { region: 'mid_back', workingSets: 3 },
      { region: 'biceps', workingSets: 3 },
    ]
    const slate = dealSlate(POOLS, targets, mulberry32(seedFromString('anchor')))
    const recentSplit = new Map<MuscleRegion, number>([['lats', 15], ['mid_back', 12], ['biceps', 9]])
    const anchor = anchorSplitFor(slate, targets, recentSplit)
    expect(anchor.get('lats')).toBe(3)
    expect(anchor.get('mid_back')).toBe(3)
    expect(anchor.get('biceps')).toBe(3)
  })

  it('falls back to the recent split, then the slate volume, for a slate region outside the targets', () => {
    const dealtFrom: RegionTarget[] = [
      { region: 'chest', workingSets: 6 },
      { region: 'lats', workingSets: 3 },
    ]
    const slate = dealSlate(POOLS, dealtFrom, mulberry32(seedFromString('anchor-fb')))
    const targetsOnlyChest: RegionTarget[] = [{ region: 'chest', workingSets: 6 }]
    // lats not in targets → recent split wins…
    const withRecent = anchorSplitFor(slate, targetsOnlyChest, new Map([['lats', 9]]))
    expect(withRecent.get('chest')).toBe(6)
    expect(withRecent.get('lats')).toBe(9)
    // …and with no recent split either, the slate's own dealt volume anchors it.
    const bare = anchorSplitFor(slate, targetsOnlyChest, new Map())
    expect(bare.get('lats')).toBe(3)
  })

  it('never anchors a region the slate could not deal (empty pool ⇒ no auto-fail)', () => {
    const targets: RegionTarget[] = [
      { region: 'chest', workingSets: 6 },
      { region: 'quads', workingSets: 9 }, // no quads in POOLS — dealt 0 slots
    ]
    const slate = dealSlate(POOLS, targets, mulberry32(seedFromString('anchor-gap')))
    const anchor = anchorSplitFor(slate, targets, new Map())
    expect(anchor.has('quads')).toBe(false)
  })
})
describe('fallbackPayload', () => {
  it('maps the slate to a payload with policy-engine defaults and an honest rationale', () => {
    const slate = dealSlate(POOLS, [{ region: 'chest', workingSets: 6 }], mulberry32(1))
    const defs = new Map(slate.exercises.map((d) => [d.exerciseId, { weight: 185, reps: 8 }]))
    const fb = fallbackPayload(slate, defs)
    expect(fb.rationale).toMatch(/deterministic fallback/i)
    expect(fb.payload.exercises.length).toBe(slate.exercises.length)
    expect(fb.payload.exercises[0]?.targetWeight).toBe(185)
    expect(fb.payload.exercises[0]?.reps).toBe(8)
  })

  it('per-exercise "why" reads human — not the raw "staleness N" debug string', () => {
    const slate = dealSlate(POOLS, [{ region: 'chest', workingSets: 6 }], mulberry32(1))
    const fb = fallbackPayload(slate, new Map())
    for (const e of fb.payload.exercises) {
      expect(e.why).toMatch(/rotation pick/i)
      expect(e.why).not.toMatch(/staleness\s*\d/i)
      expect(e.why).not.toMatch(/dealt from the rotation pool/i)
    }
  })

  it('fails closed for direct out injuries and caps limiting-region volume', () => {
    const fallback = {
      payload: {
        name: 'Test',
        exercises: [
          { exerciseId: 'bench', name: 'Bench', sets: 4, reps: 8, targetWeight: 100, supersetGroup: null, restSeconds: 90, why: 'x', region: 'chest' as MuscleRegion },
          { exerciseId: 'fly', name: 'Fly', sets: 4, reps: 10, targetWeight: 30, supersetGroup: null, restSeconds: 60, why: 'x', region: 'chest' as MuscleRegion },
          { exerciseId: 'row', name: 'Row', sets: 3, reps: 8, targetWeight: 100, supersetGroup: null, restSeconds: 90, why: 'x', region: 'mid_back' as MuscleRegion },
        ],
      },
      rationale: 'Deterministic fallback.',
    }
    const safe = injurySafeFallback(
      fallback,
      [
        { region: 'mid_back', severity: 'out' },
        { region: 'chest', severity: 'limiting' },
      ],
      new Map<MuscleRegion, number>([['chest', 6], ['mid_back', 6]]),
    )
    expect(safe.payload.exercises.map((exercise) => exercise.exerciseId)).not.toContain('row')
    expect(safe.payload.exercises.reduce((sum, exercise) => sum + exercise.sets, 0)).toBe(3)
    expect(safe.rationale).toMatch(/recorded injury constraints/i)
  })
})

// ── PURE: context hash ───────────────────────────────────────────────────────
describe('computeContextHash', () => {
  const base = {
    lastWorkoutId: 'w1',
    muscleDigest: 'chest:ready,lats:fresh',
    injuryRegions: ['knee'],
    dislikeNames: ['Pec Deck'],
    goalTitles: ['Bench 315'],
    gymId: 'g1',
  }

  it('is stable for identical inputs and order-insensitive on the sets', () => {
    const a = computeContextHash(base)
    const b = computeContextHash({ ...base, injuryRegions: ['knee'], dislikeNames: ['Pec Deck'] })
    expect(a).toBe(b)
    // Reordered arrays hash the same (sorted internally).
    const c = computeContextHash({ ...base, goalTitles: ['Bench 315'] })
    expect(c).toBe(a)
  })

  it('changes when a signal changes', () => {
    const a = computeContextHash(base)
    expect(computeContextHash({ ...base, lastWorkoutId: 'w2' })).not.toBe(a)
    expect(computeContextHash({ ...base, injuryRegions: ['knee', 'shoulder'] })).not.toBe(a)
    expect(computeContextHash({ ...base, gymId: null })).not.toBe(a)
  })
})

describe('summarizeProgrammingHistory', () => {
  it('uses one position per exercise/session and derives bounded cadence signals', () => {
    const summary = summarizeProgrammingHistory([
      { workout_id: 'w1', exercise_id: 'bench', position: 0, superset_group: 1, rest_seconds: 90 },
      { workout_id: 'w1', exercise_id: 'bench', position: 0, superset_group: 1, rest_seconds: 120 },
      { workout_id: 'w2', exercise_id: 'bench', position: 2, superset_group: null, rest_seconds: 180 },
      { workout_id: 'w2', exercise_id: 'row', position: 0, superset_group: null, rest_seconds: null },
    ])
    expect(summary.positionByExercise.get('bench')).toBe(1)
    expect(summary.positionByExercise.get('row')).toBe(0)
    expect(summary.supersetSessionRate).toBe(0.5)
    expect(summary.medianRestSeconds).toBe(120)
  })
})

// ── generatePlan: end-to-end deterministic paths ─────────────────────────────
describe('generatePlan', () => {
  const ctx = {
    today: '2026-07-10',
    goals: [], recentWorkouts: [], injuries: [], dislikes: [],
    gymEquipment: null, gymName: null, gymId: 'g1',
    readinessZone: 'Primed' as const,
    muscleState: [
      { region: 'chest' as MuscleRegion, state: 'ready', daysSince: 3, weeklySets: 9 },
      { region: 'lats' as MuscleRegion, state: 'ready', daysSince: 3, weeklySets: 6 },
    ],
    staleness: { poolSize: 6, stalest: [], freshest: [] },
    catalog: CATALOG,
    pools: POOLS,
    recentSplit: new Map<MuscleRegion, number>([['chest', 9], ['lats', 6]]),
  }

  /** Install a db.execute dispatcher for the reads generatePlan makes + the persist. */
  function installDb(opts: {
    priorPayload?: unknown
    priorPayloadHash?: string
    currentProposal?: { id: string; payload_hash: string } | null
    templateRows?: unknown[]
    defaultRest?: number
  } = {}) {
    mockExecute.mockReset()
    mockTransaction.mockReset()
    mockTransaction.mockImplementation(async (
      callback: (tx: { execute: typeof mockExecute }) => unknown,
    ) => callback({ execute: mockExecute }))
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/FROM template_exercises te/.test(q)) {
        return Promise.resolve({ rows: opts.templateRows ?? [] })
      }
      if (/gym_default_rest_seconds FROM app_settings/.test(q)) {
        return Promise.resolve({
          rows: opts.defaultRest != null ? [{ gym_default_rest_seconds: opts.defaultRest }] : [],
        })
      }
      if (/SELECT payload, md5\(payload::text\) AS payload_hash/.test(q)) {
        return Promise.resolve({
          rows: opts.priorPayload
            ? [{ payload: opts.priorPayload, payload_hash: opts.priorPayloadHash ?? 'prior-hash' }]
            : [],
        })
      }
      if (/SELECT id, md5\(payload::text\) AS payload_hash/.test(q) && /FOR UPDATE/.test(q)) {
        const current = opts.currentProposal === undefined
          ? (opts.priorPayload ? { id: 'prop-prior', payload_hash: opts.priorPayloadHash ?? 'prior-hash' } : null)
          : opts.currentProposal
        return Promise.resolve({ rows: current ? [current] : [] })
      }
      // history defaults
      if (/FROM representative_pairs/.test(q)) {
        return Promise.resolve({
          rows: [
            { id: 'bench', representative_weight: 200, representative_reps: 5 },
            { id: 'incline', representative_weight: 150, representative_reps: 8 },
            { id: 'fly', representative_weight: 40, representative_reps: 12 },
            { id: 'row', representative_weight: 185, representative_reps: 8 },
            { id: 'pulldown', representative_weight: 160, representative_reps: 10 },
            { id: 'curl', representative_weight: 40, representative_reps: 12 },
          ],
        })
      }
      // last completed workout
      if (/SELECT id FROM workouts WHERE status = 'completed'/.test(q)) {
        return Promise.resolve({ rows: [{ id: 'w-last' }] })
      }
      // supersede prior proposed
      if (/UPDATE workout_proposals SET status = 'superseded'/.test(q)) {
        return Promise.resolve({ rows: [] })
      }
      // insert proposal
      if (/INSERT INTO workout_proposals/.test(q)) {
        return Promise.resolve({
          rows: [{
            id: 'prop-1', for_date: '2026-07-10', status: 'proposed',
            rationale: 'r', context_hash: 'abc', created_at: '2026-07-10T00:00:00Z',
          }],
        })
      }
      return Promise.resolve({ rows: [] })
    })
  }

  beforeEach(() => {
    mockAssemble.mockReset()
    mockAssemble.mockResolvedValue(ctx)
  })

  it('deals a draft deterministically and says so in the rationale', async () => {
    installDb()
    const proposal = await generatePlan({ mode: 'draft' })
    expect(proposal.generator).toBe('fallback')
    expect(proposal.rationale).toMatch(/deterministic fallback/i)
    expect(proposal.payload.exercises.length).toBeGreaterThan(0)
  })

  it('supersedes prior proposed rows for the date before inserting', async () => {
    installDb()
    await generatePlan({ mode: 'draft' })
    const supersede = mockExecute.mock.calls
      .map((c) => collapseWs(sqlText(c[0])))
      .find((q) => /UPDATE workout_proposals SET status = 'superseded'/.test(q))
    expect(supersede).toBeTruthy()
    expect(supersede).toMatch(/status = 'proposed'/)
  })

  it.each([
    ['a newer proposal', { id: 'prop-newer', payload_hash: 'new-hash' }],
    ['an in-place edit', { id: 'prop-prior', payload_hash: 'edited-hash' }],
  ])('fails a shuffle closed when %s wins during generation', async (_label, currentProposal) => {
    installDb({
      priorPayload: {
        name: 'Old draft',
        exercises: [{ exerciseId: 'bench', name: 'Bench', region: 'chest' }],
      },
      priorPayloadHash: 'sampled-hash',
      currentProposal,
    })

    await expect(
      generatePlan({ mode: 'shuffle', proposalId: 'prop-prior' }),
    ).rejects.toBeInstanceOf(ProposalWriteConflictError)

    const writes = mockExecute.mock.calls.map((call) => collapseWs(sqlText(call[0])))
    expect(writes.some((query) => /UPDATE workout_proposals SET status = 'superseded'/.test(query))).toBe(false)
    expect(writes.some((query) => /INSERT INTO workout_proposals/.test(query))).toBe(false)
  })

  it('persists a shuffle when the exact sampled id and payload are still current', async () => {
    installDb({
      priorPayload: {
        name: 'Old draft',
        exercises: [{ exerciseId: 'bench', name: 'Bench', region: 'chest' }],
      },
      priorPayloadHash: 'sampled-hash',
      currentProposal: { id: 'prop-prior', payload_hash: 'sampled-hash' },
    })

    await expect(
      generatePlan({ mode: 'shuffle', proposalId: 'prop-prior' }),
    ).resolves.toMatchObject({ id: 'prop-1' })
  })

  it('preserves exact template warm-up rows through tune without letting the planner author them', async () => {
    installDb({
      templateRows: [
        {
          template_exercise_id: 'te-bench', exercise_id: 'bench',
          name: 'Barbell Bench Press', primary_muscle: 'chest', secondary_muscles: [],
          set_number: 1, target_weight: '20', target_weight_unit: 'kg',
          target_reps: 10, target_duration_s: null, target_rpe: '4',
          rest_seconds: 30, side: null,
        },
        {
          template_exercise_id: 'te-bench', exercise_id: 'bench',
          name: 'Barbell Bench Press', primary_muscle: 'chest', secondary_muscles: [],
          set_number: 2, target_weight: '95', target_weight_unit: 'lb',
          target_reps: 5, target_duration_s: null, target_rpe: '5',
          rest_seconds: 45, side: 'left',
        },
      ],
    })

    const proposal = await generatePlan({ mode: 'tune', templateId: 'template-1' })
    const bench = proposal.payload.exercises.find((exercise) => exercise.exerciseId === 'bench')

    expect(bench?.sets).toBe(9)
    expect(bench?.setPrescriptions).toHaveLength(11)
    expect(bench?.setPrescriptions?.slice(0, 2)).toEqual([
      {
        setType: 'warmup', targetWeight: 44.092, reps: 10,
        targetDurationS: null, targetRpe: 4, restSeconds: 30, side: null,
      },
      {
        setType: 'warmup', targetWeight: 95, reps: 5,
        targetDurationS: null, targetRpe: 5, restSeconds: 45, side: 'left',
      },
    ])
    expect(bench?.setPrescriptions?.slice(2).every((set) => set.setType !== 'warmup')).toBe(true)
  })

  it('fails tune closed when the named template has no readable exercise anchor', async () => {
    installDb({ templateRows: [] })

    await expect(
      generatePlan({ mode: 'tune', templateId: 'template-missing' }),
    ).rejects.toBeInstanceOf(TemplateAnchorUnavailableError)

    const writes = mockExecute.mock.calls.map((call) => collapseWs(sqlText(call[0])))
    expect(writes.some((query) => /INSERT INTO workout_proposals/.test(query))).toBe(false)
  })

})

// ── generatePlan: injury-aware split steering end-to-end ─────────────────────
describe('generatePlan — ankles out steers off a lower-body split', () => {
  // Reproduces the live evidence: `ankles: out`, a quads/glutes-heavy recent split.
  // The lower-body pools are gutted, so the split chooser must NOT keep a quads/
  // glutes day and degrade to fallback dealing — it swaps in a viable upper split.
  const INJ_CATALOG: CatalogExercise[] = [
    ex({ id: 'sq', name: 'Barbell Squat', primaryMuscle: 'quadriceps', equipment: 'barbell', daysSinceLast: 5 }),
    ex({ id: 'lg', name: 'Walking Lunge', primaryMuscle: 'quadriceps', equipment: 'body only', daysSinceLast: 6 }),
    ex({ id: 'ht', name: 'Barbell Hip Thrust', primaryMuscle: 'glutes', equipment: 'barbell', daysSinceLast: 7 }),
    ex({ id: 'sumo', name: 'Sumo Deadlift', primaryMuscle: 'glutes', equipment: 'barbell', daysSinceLast: 8 }),
    ex({ id: 'balance', name: 'Balance Board', primaryMuscle: 'calves', equipment: 'body only', daysSinceLast: 4 }),
    ex({ id: 'bench', name: 'Barbell Bench Press', primaryMuscle: 'chest', equipment: 'barbell', daysSinceLast: 10 }),
    ex({ id: 'incline', name: 'Incline Dumbbell Press', primaryMuscle: 'chest', equipment: 'dumbbell', daysSinceLast: 12 }),
    ex({ id: 'dbfly', name: 'Dumbbell Chest Fly', primaryMuscle: 'chest', equipment: 'dumbbell', daysSinceLast: 14 }),
    ex({ id: 'pulldown', name: 'Lat Pulldown', primaryMuscle: 'lats', equipment: 'cable', daysSinceLast: 9 }),
    ex({ id: 'pullover', name: 'Cable Pullover', primaryMuscle: 'lats', equipment: 'cable', daysSinceLast: 11 }),
    ex({ id: 'srow', name: 'Seated Cable Row', primaryMuscle: 'lats', equipment: 'cable', daysSinceLast: 13 }),
  ]
  const injuryPools = buildPools(INJ_CATALOG, null, [{ region: 'ankles', severity: 'out' }])
  const ctx = {
    today: '2026-07-14',
    goals: [], recentWorkouts: [], dislikes: [],
    injuries: [{ region: 'ankles' as MuscleRegion, severity: 'out', label: 'rolled both ankles' }],
    gymEquipment: null, gymName: null, gymId: 'g1',
    readinessZone: 'Moderate' as const,
    muscleState: [],
    staleness: { poolSize: 11, stalest: [], freshest: [] },
    catalog: INJ_CATALOG,
    pools: injuryPools,
    recentSplit: new Map<MuscleRegion, number>([
      ['quads', 12], ['glutes', 10], ['chest', 9], ['lats', 8],
    ]),
  }

  function installDb() {
    mockExecute.mockReset()
    mockTransaction.mockReset()
    mockTransaction.mockImplementation(async (
      callback: (tx: { execute: typeof mockExecute }) => unknown,
    ) => callback({ execute: mockExecute }))
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/mode\(\) WITHIN GROUP/.test(q)) return Promise.resolve({ rows: [] })
      if (/SELECT id FROM workouts WHERE status = 'completed'/.test(q)) {
        return Promise.resolve({ rows: [{ id: 'w-last' }] })
      }
      if (/gym_default_rest_seconds FROM app_settings/.test(q)) return Promise.resolve({ rows: [] })
      if (/UPDATE workout_proposals SET status = 'superseded'/.test(q)) return Promise.resolve({ rows: [] })
      if (/INSERT INTO workout_proposals/.test(q)) {
        return Promise.resolve({
          rows: [{ id: 'prop-inj', for_date: '2026-07-14', status: 'proposed', rationale: 'r', context_hash: 'h', created_at: '2026-07-14T00:00:00Z' }],
        })
      }
      return Promise.resolve({ rows: [] })
    })
  }

  beforeEach(() => {
    mockAssemble.mockReset()
    mockAssemble.mockResolvedValue(ctx)
  })

  it('produces no quads/glutes slots and surfaces the injury steer in the rationale', async () => {
    installDb()
    // The deterministic dealer fires over the STEERED (upper) slate.
    const proposal = await generatePlan({ mode: 'draft' })

    const regions = proposal.payload.exercises.map((e) => e.region)
    expect(regions.length).toBeGreaterThan(0)
    expect(regions).not.toContain('quads')
    expect(regions).not.toContain('glutes')
    expect(regions.some((r) => r === 'chest' || r === 'lats')).toBe(true)
    // The dealt balance-board drill is gone (stability pattern excluded for ankles).
    expect(proposal.payload.exercises.map((e) => e.exerciseId)).not.toContain('balance')
    // "Why this workout" surfaces the injury steer.
    expect(proposal.rationale).toMatch(/recorded injury constraints (?:shifted|removed)/i)
    expect(proposal.rationale).toMatch(/ankles/i)
  })
})

// ── updateProposalPayload: in-place edit path ────────────────────────────────
describe('updateProposalPayload', () => {
  const ctx = {
    today: '2026-07-10',
    goals: [], recentWorkouts: [], injuries: [], dislikes: [],
    gymEquipment: null, gymName: null, gymId: 'g1', readinessZone: null,
    muscleState: [{ region: 'chest' as MuscleRegion, state: 'ready', daysSince: 3, weeklySets: 9 }],
    staleness: { poolSize: 0, stalest: [], freshest: [] },
    catalog: [], pools: new Map<string, Pool>(), recentSplit: new Map<MuscleRegion, number>(),
  }

  beforeEach(() => {
    mockAssemble.mockReset()
    mockAssemble.mockResolvedValue(ctx)
  })

  const payload = {
    name: 'Edited',
    exercises: [{
      exerciseId: 'bench', name: 'Bench', sets: 3, reps: 5, targetWeight: null,
      supersetGroup: null, restSeconds: null, why: 'x', region: 'chest' as MuscleRegion,
    }],
  }

  it('overwrites the payload in place, fills default rest, recomputes hash (never stale)', async () => {
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/gym_default_rest_seconds FROM app_settings/.test(q)) {
        return Promise.resolve({ rows: [{ gym_default_rest_seconds: 75 }] })
      }
      if (/SELECT id FROM workouts WHERE status = 'completed'/.test(q)) {
        return Promise.resolve({ rows: [{ id: 'w-last' }] })
      }
      if (/UPDATE workout_proposals SET payload/.test(q)) {
        return Promise.resolve({
          rows: [{ id: 'p1', for_date: '2026-07-10', status: 'proposed', rationale: 'r', created_at: '2026-07-10T00:00:00Z' }],
        })
      }
      return Promise.resolve({ rows: [] })
    })

    const res = await updateProposalPayload('p1', payload)
    expect(res).not.toBeNull()
    expect(res!.stale).toBe(false)
    expect(res!.payload.exercises[0]!.restSeconds).toBe(75)

    const upd = mockExecute.mock.calls
      .map((c) => collapseWs(sqlText(c[0])))
      .find((q) => /UPDATE workout_proposals SET payload/.test(q))
    expect(upd).toMatch(/context_hash =/)
    expect(upd).toMatch(/status = 'proposed'/)
  })

  it('returns null when the row is not a live proposed row (already started/dismissed/missing)', async () => {
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/UPDATE workout_proposals SET payload/.test(q)) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await updateProposalPayload('gone', { name: 'X', exercises: [] })
    expect(res).toBeNull()
  })
})

// ── withProposalEditLock: serializes concurrent edit_workout_proposal calls (#1096) ──
describe('withProposalEditLock', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockExecute.mockResolvedValue({ rows: [] })
    mockTransaction.mockReset()
  })

  it('reads and writes the proposal through the same advisory-locked transaction', async () => {
    const lockedPayload = {
      name: 'Edited',
      exercises: [{
        exerciseId: 'bench', name: 'Bench', sets: 3, reps: 5, targetWeight: null,
        supersetGroup: null, restSeconds: null, why: 'x', region: 'chest' as MuscleRegion,
      }],
    }
    const txExecute = vi.fn().mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/FROM workout_proposals/.test(q)) {
        return Promise.resolve({
          rows: [{
            id: 'p1', for_date: '2026-07-10', status: 'proposed', rationale: 'r',
            payload: lockedPayload, context_hash: null, created_at: '2026-07-10T00:00:00Z',
          }],
        })
      }
      if (/UPDATE workout_proposals/.test(q)) {
        return Promise.resolve({
          rows: [{ id: 'p1', for_date: '2026-07-10', status: 'proposed', rationale: 'r', created_at: '2026-07-10T00:00:00Z' }],
        })
      }
      return Promise.resolve({ rows: [] })
    })
    mockTransaction.mockImplementation(async (callback: (tx: { execute: typeof txExecute }) => unknown) =>
      callback({ execute: txExecute }),
    )

    const ctx: CoachContext = {
      today: '2026-07-10',
      goals: [], recentWorkouts: [], injuries: [], dislikes: [], preferences: [],
      gymEquipment: null, gymName: null, gymId: 'g1', readinessZone: null,
      muscleState: [{ region: 'chest' as MuscleRegion, state: 'ready' as const, daysSince: 3, weeklySets: 9 }],
      staleness: { poolSize: 0, stalest: [], freshest: [] },
      catalog: [], pools: new Map<string, Pool>(), recentSplit: new Map<MuscleRegion, number>(),
      mobility: null,
    }
    const result = await withProposalEditLock(ctx, ({ current, update }) => {
      expect(current?.id).toBe('p1')
      return update({ ...lockedPayload, name: 'Updated' })
    })

    expect(result?.payload.name).toBe('Updated')
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    const statements = txExecute.mock.calls.map((call) => collapseWs(sqlText(call[0])))
    expect(statements[0]).toMatch(/pg_advisory_xact_lock\(hashtext\(/)
    expect(statements).toContainEqual(expect.stringMatching(/SELECT .* FROM workout_proposals .* FOR UPDATE/))
    expect(statements).toContainEqual(expect.stringMatching(/UPDATE workout_proposals SET payload/))
    expect(mockExecute.mock.calls.map((call) => collapseWs(sqlText(call[0])))).not.toContainEqual(
      expect.stringMatching(/FROM workout_proposals|UPDATE workout_proposals/),
    )
  })

  it('keeps two concurrent edit critical sections from overlapping', async () => {
    let lockTail = Promise.resolve()
    mockTransaction.mockImplementation(async (
      callback: (tx: { execute: (query: unknown) => Promise<{ rows: never[] }> }) => unknown,
    ) => {
      let releaseLock: () => void = () => undefined
      const execute = vi.fn(async (query: unknown) => {
        if (/pg_advisory_xact_lock/.test(collapseWs(sqlText(query)))) {
          const predecessor = lockTail
          lockTail = new Promise<void>((resolve) => {
            releaseLock = resolve
          })
          await predecessor
        }
        return { rows: [] as never[] }
      })
      try {
        return await callback({ execute })
      } finally {
        releaseLock()
      }
    })

    const events: string[] = []
    let enterFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve })
    let releaseFirst!: () => void
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve })

    const lockCtx: CoachContext = {
      today: '2026-07-10',
      goals: [], recentWorkouts: [], injuries: [], dislikes: [], preferences: [],
      gymEquipment: null, gymName: null, gymId: 'g1', readinessZone: null,
      muscleState: [],
      staleness: { poolSize: 0, stalest: [], freshest: [] },
      catalog: [], pools: new Map<string, Pool>(), recentSplit: new Map<MuscleRegion, number>(),
      mobility: null,
    }

    const first = withProposalEditLock(lockCtx, async () => {
      events.push('first:start')
      enterFirst()
      await holdFirst
      events.push('first:end')
    })
    await firstEntered

    const second = withProposalEditLock(lockCtx, async () => {
      events.push('second:start')
      events.push('second:end')
    })
    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })
})

// ── getTodayProposal: GET path never generates ───────────────────────────────
describe('getTodayProposal', () => {
  const ctx = {
    today: '2026-07-10',
    goals: [], recentWorkouts: [], injuries: [], dislikes: [],
    gymEquipment: null, gymName: null, gymId: 'g1', readinessZone: null,
    muscleState: [{ region: 'chest' as MuscleRegion, state: 'ready', daysSince: 3, weeklySets: 9 }],
    staleness: { poolSize: 0, stalest: [], freshest: [] },
    catalog: [], pools: new Map<string, Pool>(), recentSplit: new Map<MuscleRegion, number>(),
  }

  beforeEach(() => {
    mockAssemble.mockReset()
    mockAssemble.mockResolvedValue(ctx)
  })

  it('returns null when no proposed row exists', async () => {
    mockExecute.mockReset()
    mockExecute.mockResolvedValue({ rows: [] })
    const p = await getTodayProposal()
    expect(p).toBeNull()
  })

  it('marks stale when the stored hash no longer matches the recomputed one', async () => {
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/FROM workout_proposals WHERE for_date/.test(q)) {
        return Promise.resolve({
          rows: [{
            id: 'p1', for_date: '2026-07-10', status: 'proposed', rationale: 'r',
            payload: { name: 'X', exercises: [{ exerciseId: 'bench', name: 'Bench', sets: 3, reps: 5, targetWeight: null, supersetGroup: null, restSeconds: null, why: 'x', region: 'chest' }] },
            context_hash: 'STALE_HASH_THAT_WONT_MATCH', created_at: '2026-07-10T00:00:00Z',
          }],
        })
      }
      if (/SELECT id FROM workouts WHERE status = 'completed'/.test(q)) {
        return Promise.resolve({ rows: [{ id: 'w-last' }] })
      }
      return Promise.resolve({ rows: [] })
    })
    const p = await getTodayProposal()
    expect(p).not.toBeNull()
    expect(p!.stale).toBe(true)
  })

  it('normalizes a stored lowercase exercise name at the proposal read boundary', async () => {
    const storedPayload = {
      name: 'Upper',
      exercises: [{
        exerciseId: 'bench', name: 'dumbbell bench press', sets: 3, reps: 8,
        targetWeight: 55, supersetGroup: null, restSeconds: 90, why: 'Press', region: 'chest',
      }],
    }
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/FROM workout_proposals WHERE for_date/.test(q)) {
        return Promise.resolve({
          rows: [{
            id: 'p-lower', for_date: '2026-07-10', status: 'proposed', rationale: 'r',
            payload: storedPayload, context_hash: null, created_at: '2026-07-10T00:00:00Z',
          }],
        })
      }
      return Promise.resolve({ rows: [] })
    })

    const proposal = await getTodayProposal()

    expect(proposal?.payload.exercises[0]?.name).toBe('Dumbbell Bench Press')
    expect(storedPayload.exercises[0]!.name).toBe('dumbbell bench press')
  })
})

describe('proposalToWorkoutStart — reviewed set fidelity', () => {
  it('materializes every proposal set atomically before opening the logger', async () => {
    mockMaterialize.mockClear()
    mockGetActiveWorkout.mockClear()
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT id, payload, status FROM workout_proposals/.test(q)) {
        return Promise.resolve({
          rows: [{
            id: 'p1',
            status: 'proposed',
            payload: {
              name: 'upper body',
              exercises: [{
                exerciseId: 'bench', name: 'Bench Press', sets: 3, reps: 8,
                targetWeight: 135, targetDurationS: null, supersetGroup: 7,
                restSeconds: 90, section: 'main', why: 'Press', region: 'chest',
              }],
            },
          }],
        })
      }
      if (/SELECT id FROM workouts WHERE status = 'active'/.test(q)) {
        return Promise.resolve({ rows: [] })
      }
      return Promise.resolve({ rows: [] })
    })
    const txExecute = vi.fn((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT status, payload FROM workout_proposals/.test(q)) {
        return Promise.resolve({ rows: [{
          status: 'proposed',
          payload: {
            name: 'upper body',
            exercises: [{
              exerciseId: 'bench', name: 'Bench Press', sets: 3, reps: 8,
              targetWeight: 135, targetDurationS: null, supersetGroup: 7,
              restSeconds: 90, section: 'main', why: 'Press', region: 'chest',
            }],
          },
        }] })
      }
      if (/INSERT INTO workouts/.test(q)) return Promise.resolve({ rows: [{ id: 'w-new' }] })
      if (/INSERT INTO workout_exercises/.test(q)) return Promise.resolve({ rows: [{ id: 'we-new' }] })
      return Promise.resolve({ rows: [] })
    })
    mockTransaction.mockImplementation(async (callback: (tx: { execute: typeof txExecute }) => unknown) =>
      callback({ execute: txExecute }),
    )

    const result = await proposalToWorkoutStart('p1')

    expect(result.workout).toEqual({ id: 'w-new' })
    expect(mockMaterialize).toHaveBeenCalledTimes(1)
    expect(mockMaterialize.mock.calls[0]?.[1]).toBe('we-new')
    expect(mockMaterialize.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ setNumber: 1, setType: 'normal', weight: 135, reps: 8, restSeconds: 90, source: 'proposal' }),
      expect.objectContaining({ setNumber: 2, setType: 'normal', weight: 135, reps: 8, restSeconds: 90, source: 'proposal' }),
      expect.objectContaining({ setNumber: 3, setType: 'normal', weight: 135, reps: 8, restSeconds: 90, source: 'proposal' }),
    ])
    expect(mockGetActiveWorkout).toHaveBeenCalledWith('w-new')
  })

  it('preserves two warm-ups plus three working rows verbatim when Start materializes the proposal', async () => {
    mockMaterialize.mockClear()
    mockGetActiveWorkout.mockClear()
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT id, payload, status FROM workout_proposals/.test(q)) {
        return Promise.resolve({
          rows: [{
            id: 'p-exact',
            status: 'proposed',
            payload: {
              name: 'bench day',
              exercises: [{
                exerciseId: 'bench', name: 'Bench Press', sets: 3, reps: 8,
                targetWeight: 135, targetDurationS: null, supersetGroup: null,
                restSeconds: 120, section: 'main', why: 'Press', region: 'chest',
                setPrescriptions: [
                  { setType: 'warmup', targetWeight: 45, reps: 10, targetDurationS: null, targetRpe: 4, restSeconds: 45, side: null },
                  { setType: 'warmup', targetWeight: 95, reps: 5, targetDurationS: null, targetRpe: 5, restSeconds: 60, side: null },
                  { setType: 'normal', targetWeight: 135, reps: 8, targetDurationS: null, targetRpe: 8, restSeconds: 120, side: null },
                  { setType: 'normal', targetWeight: 135, reps: 8, targetDurationS: null, targetRpe: 8, restSeconds: 120, side: null },
                  { setType: 'failure', targetWeight: 135, reps: 6, targetDurationS: null, targetRpe: 10, restSeconds: 150, side: null },
                ],
              }],
            },
          }],
        })
      }
      if (/SELECT id FROM workouts WHERE status = 'active'/.test(q)) {
        return Promise.resolve({ rows: [] })
      }
      return Promise.resolve({ rows: [] })
    })
    const txExecute = vi.fn((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT status, payload FROM workout_proposals/.test(q)) {
        return Promise.resolve({ rows: [{
          status: 'proposed',
          payload: {
            name: 'bench day',
            exercises: [{
              exerciseId: 'bench', name: 'Bench Press', sets: 3, reps: 8,
              targetWeight: 135, targetDurationS: null, supersetGroup: null,
              restSeconds: 120, section: 'main', why: 'Press', region: 'chest',
              setPrescriptions: [
                { setType: 'warmup', targetWeight: 45, reps: 10, targetDurationS: null, targetRpe: 4, restSeconds: 45, side: null },
                { setType: 'warmup', targetWeight: 95, reps: 5, targetDurationS: null, targetRpe: 5, restSeconds: 60, side: null },
                { setType: 'normal', targetWeight: 135, reps: 8, targetDurationS: null, targetRpe: 8, restSeconds: 120, side: null },
                { setType: 'normal', targetWeight: 135, reps: 8, targetDurationS: null, targetRpe: 8, restSeconds: 120, side: null },
                { setType: 'failure', targetWeight: 135, reps: 6, targetDurationS: null, targetRpe: 10, restSeconds: 150, side: null },
              ],
            }],
          },
        }] })
      }
      if (/INSERT INTO workouts/.test(q)) return Promise.resolve({ rows: [{ id: 'w-exact' }] })
      if (/INSERT INTO workout_exercises/.test(q)) return Promise.resolve({ rows: [{ id: 'we-exact' }] })
      return Promise.resolve({ rows: [] })
    })
    mockTransaction.mockImplementation(async (callback: (tx: { execute: typeof txExecute }) => unknown) =>
      callback({ execute: txExecute }),
    )

    await proposalToWorkoutStart('p-exact')

    expect(mockMaterialize.mock.calls[0]?.[2]).toEqual([
      { setNumber: 1, setType: 'warmup', weight: 45, weightUnit: 'lb', reps: 10, durationS: null, rpe: 4, restSeconds: 45, side: null, source: 'proposal' },
      { setNumber: 2, setType: 'warmup', weight: 95, weightUnit: 'lb', reps: 5, durationS: null, rpe: 5, restSeconds: 60, side: null, source: 'proposal' },
      { setNumber: 3, setType: 'normal', weight: 135, weightUnit: 'lb', reps: 8, durationS: null, rpe: 8, restSeconds: 120, side: null, source: 'proposal' },
      { setNumber: 4, setType: 'normal', weight: 135, weightUnit: 'lb', reps: 8, durationS: null, rpe: 8, restSeconds: 120, side: null, source: 'proposal' },
      { setNumber: 5, setType: 'failure', weight: 135, weightUnit: 'lb', reps: 6, durationS: null, rpe: 10, restSeconds: 150, side: null, source: 'proposal' },
    ])
  })

  it('returns the winning active workout when concurrent starts hit the singleton index', async () => {
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT id, payload, status FROM workout_proposals/.test(q)) {
        return Promise.resolve({ rows: [{
          id: 'p1', status: 'proposed',
          payload: { name: 'Upper', exercises: [{
            exerciseId: 'bench', name: 'Bench', sets: 3, reps: 8, targetWeight: 100,
            supersetGroup: null, restSeconds: 90, why: 'Press', region: 'chest',
          }] },
        }] })
      }
      if (/SELECT id FROM workouts WHERE status = 'active'/.test(q)) {
        const calls = mockExecute.mock.calls.filter(([query]) =>
          /SELECT id FROM workouts WHERE status = 'active'/.test(collapseWs(sqlText(query))),
        )
        return Promise.resolve({ rows: calls.length > 1 ? [{ id: 'w-winner' }] : [] })
      }
      return Promise.resolve({ rows: [] })
    })
    mockTransaction.mockRejectedValueOnce(Object.assign(new Error('unique'), {
      code: '23505', constraint: 'uq_workouts_one_active',
    }))

    await expect(proposalToWorkoutStart('p1')).resolves.toEqual({
      conflictActiveWorkoutId: 'w-winner',
    })
  })

  it('materializes the payload re-read under the proposal row lock', async () => {
    mockMaterialize.mockClear()
    mockGetActiveWorkout.mockClear()
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT id, payload, status FROM workout_proposals/.test(q)) {
        return Promise.resolve({ rows: [{
          id: 'p-raced', status: 'proposed',
          payload: { name: 'Stale draft', exercises: [{
            exerciseId: 'bench', name: 'Bench Press', sets: 1, reps: 8,
            targetWeight: 95, supersetGroup: null, restSeconds: 90,
            why: 'Old target', region: 'chest',
          }] },
        }] })
      }
      if (/SELECT id FROM workouts WHERE status = 'active'/.test(q)) {
        return Promise.resolve({ rows: [] })
      }
      return Promise.resolve({ rows: [] })
    })

    const txExecute = vi.fn((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT status, payload FROM workout_proposals/.test(q)) {
        return Promise.resolve({ rows: [{
          status: 'proposed',
          payload: { name: 'Edited draft', exercises: [{
            exerciseId: 'bench', name: 'Bench Press', sets: 1, reps: 6,
            targetWeight: 125, supersetGroup: null, restSeconds: 120,
            why: 'Edited target', region: 'chest',
          }] },
        }] })
      }
      if (/INSERT INTO workouts/.test(q)) return Promise.resolve({ rows: [{ id: 'w-raced' }] })
      if (/INSERT INTO workout_exercises/.test(q)) return Promise.resolve({ rows: [{ id: 'we-raced' }] })
      return Promise.resolve({ rows: [] })
    })
    mockTransaction.mockImplementation(async (callback: (tx: { execute: typeof txExecute }) => unknown) =>
      callback({ execute: txExecute }),
    )

    await expect(proposalToWorkoutStart('p-raced')).resolves.toEqual({ workout: { id: 'w-new' } })
    expect(mockMaterialize).toHaveBeenCalledWith(
      expect.any(Function),
      'we-raced',
      [expect.objectContaining({ weight: 125, reps: 6, restSeconds: 120 })],
    )
    expect(mockMaterialize.mock.calls[0]?.[2]).not.toEqual([
      expect.objectContaining({ weight: 95, reps: 8, restSeconds: 90 }),
    ])
  })

})

describe('capRegionTargets (max_exercises constraint)', () => {
  const t = (region: MuscleRegion, workingSets: number) => ({ region, workingSets })

  it('returns targets unchanged when already under the cap', async () => {
    const { capRegionTargets } = await import('../plan')
    const targets = [t('chest', 6), t('triceps', 3)]
    expect(capRegionTargets(targets, 4)).toEqual(targets)
  })

  it('scales the default 4×9 body-map deal down to the cap', async () => {
    const { capRegionTargets } = await import('../plan')
    // 4 regions × 9 sets ⇒ 12 slots — the "first workout back" monster.
    const targets = [t('chest', 9), t('lats', 9), t('quads', 9), t('delts', 9)]
    const capped = capRegionTargets(targets, 4)
    const slots = capped.reduce((n, x) => n + Math.max(1, Math.round(x.workingSets / 3)), 0)
    expect(slots).toBeLessThanOrEqual(4)
    // Volume floor holds — no region collapses below 3 working sets.
    for (const target of capped) expect(target.workingSets).toBeGreaterThanOrEqual(3)
  })

  it('drops the lowest-volume regions when scaling alone cannot fit', async () => {
    const { capRegionTargets } = await import('../plan')
    const targets = [t('chest', 9), t('lats', 6), t('quads', 4), t('delts', 3)]
    const capped = capRegionTargets(targets, 3)
    const slots = capped.reduce((n, x) => n + Math.max(1, Math.round(x.workingSets / 3)), 0)
    expect(slots).toBeLessThanOrEqual(3)
    // The dominant region survives the trim.
    expect(capped.map((x) => x.region)).toContain('chest')
  })

  it('handles a single oversized region', async () => {
    const { capRegionTargets } = await import('../plan')
    const capped = capRegionTargets([t('quads', 30)], 2)
    expect(capped).toHaveLength(1)
    expect(Math.max(1, Math.round(capped[0]!.workingSets / 3))).toBeLessThanOrEqual(2)
  })
})
