/**
 * Draft generation (GYM_PLAN §6).
 *
 * Everything in this file is deterministic:
 *   1. A pre-filter (novelty.ts) DEALS a slate from staleness-weighted rotation
 *      pools, so a draft never free-picks from ~1300 exercise names.
 *   2. Region volume targets come from the mode, the focus, the recent split and
 *      the muscle state; the policy engine supplies every target load.
 *   3. Active training constraints are enforced on the slate with the same gate
 *      search and live edits use (`injurySafeFallback`).
 *   4. Persist to `workout_proposals` (supersede prior proposed rows for the date);
 *      `context_hash` recomputed on open flags staleness.
 *
 * The system this was extracted from runs a model-driven lane over the same
 * slate behind a validation gate. That lane is not part of this repository:
 * `generator` on a proposal is always 'fallback' here, and the payload's
 * rationale says so.
 *
 * User-initiated only (GYM_PLAN §2.7) — nothing generates ambiently, and GET
 * never generates.
 */
import { createHash } from 'crypto'

import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { musclesForExerciseEnriched, REGION_LABELS, type MuscleRegion } from '@/lib/fitness/muscles'
import { convertWeight, normalizeWeightUnit, type WeightUnit } from '@/lib/units/weight'
import {
  getActiveWorkoutById,
  materializeSetPrescriptions,
  type ActiveWorkout,
  type SetPrescriptionInput,
} from './active-workout'
import { normalizeGeneratedWorkoutName } from './display-name'
import { isActiveWorkoutSingletonViolation } from './active-conflict'
import { deloadHistoryDefaults, type SessionMark } from './detraining'
import {
  exerciseAllowedWithInjuries,
  injurySiteIsMuscleRegion,
  INJURY_SITE_LABELS,
  type ExerciseInjuryProfile,
  type InjuryConstraint,
} from './injury-profile'
import {
  normalizeProposalExerciseNames,
  resolveProposalSetPrescriptions,
  type ProposalSetPrescription,
} from './proposal-payload'
import {
  EMPTY_PROGRAMMING_HISTORY,
  normalizeWorkoutProgrammingPolicy,
  programWorkout,
  resolveProgrammingGoal,
  type ProgrammingMetadata,
  type WorkoutProgrammingPolicy,
} from './programming-policy'
import {
  loadRegionIndex,
  readDetrainingMarksBatch,
  readProgrammingHistory,
  readRegionMarksBatch,
} from './programming-history'
import {
  assembleCoachContext,
  type CoachContext,
  type CoachMuscleState,
} from './coach-context'
import {
  alternativesFor,
  checkVolumeConservation,
  dealSlate,
  mulberry32,
  poolDepthForRegion,
  regionVolume,
  seedFromString,
  type AnchorExercise,
  type DealtExercise,
  type Pool,
  type PoolExercise,
  type RegionTarget,
  type Slate,
} from './novelty'

// ---------------------------------------------------------------------------
// The proposal payload shape (consumed VERBATIM by the UI agent)
// ---------------------------------------------------------------------------

/** One exercise in a proposal payload. */
export interface ProposalExercise {
  /** exercises.id — always ∈ the candidate list (gate-enforced). */
  exerciseId: string
  /** Denormalized name for display. */
  name: string
  sets: number
  reps: number | null
  /** Ghost target weight (policy-engine derived). */
  targetWeight: number | null
  /** Superset grouping (opaque id; same value ⇔ same group). Null = ungrouped. */
  supersetGroup: number | null
  restSeconds: number | null
  /** One-line "why this exercise" from the deterministic dealer. */
  why: string
  /** Primary muscle region this slot targets (for the UI's muscle chips). */
  region: MuscleRegion | null
  /** Hold seconds per set for timed work (§10b.8 mobility drafts); absent for
   *  strength slots. */
  targetDurationS?: number | null
  /** Block role (GYM_PLAN §10b.3): 'warmup' | 'main' (default) | 'cooldown'.
   *  Optional + additive — absent ⇒ 'main', so payloads stored before this field
   *  existed stay valid (the payload is consumed VERBATIM by the UI). Only
   *  'warmup' slots (added conversationally via edit_workout_proposal) are exempt
   *  from region-volume conservation in the gate; never from injury exclusion. */
  section?: 'warmup' | 'main' | 'cooldown'
  /** Optional exact set rows in workout order. When absent, legacy scalar
   * sets/reps/target fields are synthesized at Start exactly as before. */
  setPrescriptions?: ProposalSetPrescription[]
}

export type { ProposalSetPrescription }

export interface ProposalPayload {
  name: string
  programmingPolicy?: WorkoutProgrammingPolicy
  exercises: ProposalExercise[]
}

/** The full proposal row the route returns. */
export interface Proposal {
  id: string
  forDate: string
  status: string
  rationale: string | null
  payload: ProposalPayload
  contextHash: string | null
  createdAt: string
  /** Whether the proposal's context has drifted since it was generated (GET only). */
  stale?: boolean
  /** Read-boundary display hint. Persisted targetWeight values remain canonical lb. */
  weightUnit?: WeightUnit
  /** Which lane produced this draft (generatePlan only, transient — not
   *  persisted). Always 'fallback' in this repository: the draft was dealt
   *  mechanically, and callers surface that honestly. */
  generator?: 'llm' | 'fallback'
}

export type PlanMode = 'draft' | 'tune' | 'shuffle'

export interface GeneratePlanInput {
  mode: PlanMode
  /** tune: the template to anchor to. */
  templateId?: string
  /** shuffle: the prior proposal to resample away from. */
  proposalId?: string
  /** draft: free-text focus ("pull day", "legs + core") mapped to regions. */
  focus?: string
  /** Hard cap on the exercise count (short sessions, return-from-layoff). The
   *  cap scales region targets BEFORE the slate is dealt, so the dealer and
   *  the deterministic fallback both honor it. Ignored for tune (an explicit
   *  template's structure wins, same as injury steering). */
  maxExercises?: number
}

/** A shuffle was computed from a proposal that stopped being the exact current
 * draft before persistence. Callers should re-read instead of overwriting it. */
export class ProposalWriteConflictError extends Error {
  constructor(readonly proposalId: string) {
    super(`Workout proposal ${proposalId} changed while its shuffle was being generated.`)
    this.name = 'ProposalWriteConflictError'
  }
}

/** An explicit tune could not read a usable template anchor. Tuning must fail
 * closed: silently falling back to an unrelated generated workout would make a
 * saved template look editable while discarding the very prescription the user chose. */
export class TemplateAnchorUnavailableError extends Error {
  constructor(readonly templateId: string) {
    super(`Workout template ${templateId} could not be loaded with any exercises.`)
    this.name = 'TemplateAnchorUnavailableError'
  }
}

// ---------------------------------------------------------------------------
// Candidate list (the draft's ONLY vocabulary)
// ---------------------------------------------------------------------------

/** One enumerated candidate row. */
export interface Candidate {
  id: string
  name: string
  pattern: string
  region: MuscleRegion
  staleness: number
  /** Policy-engine / history-implied default target weight (lb), when known. */
  defaultWeight: number | null
  /** Reps from the representative recent performance pair, when known. */
  defaultReps: number | null
  injuryProfile: ExerciseInjuryProfile | null
}

const MIN_CANDIDATES = 40
const MAX_CANDIDATES = 120

/**
 * Build the enumerated candidate list: the dealt slate's exercises PLUS staleness-
 * ranked alternates from each dealt region's pool, deduped, capped [40,120]. This
 * is the closed vocabulary a draft may draw ids from. Pure.
 */
export function buildCandidates(
  slate: Slate,
  pools: Map<string, Pool>,
  historyDefaults: Map<string, { weight: number | null; reps: number | null }>,
): Candidate[] {
  const byId = new Map<string, Candidate>()

  const add = (e: { id: string; name: string; pattern: string; region: MuscleRegion; staleness: number; injuryProfile: ExerciseInjuryProfile | null }) => {
    if (byId.has(e.id)) return
    const def = historyDefaults.get(e.id)
    byId.set(e.id, {
      id: e.id,
      name: e.name,
      pattern: e.pattern,
      region: e.region,
      staleness: Math.round(e.staleness * 10) / 10,
      defaultWeight: def?.weight ?? null,
      defaultReps: def?.reps ?? null,
      injuryProfile: e.injuryProfile,
    })
  }

  // Slate first (guarantees the dealt exercises are in-vocab).
  for (const d of slate.exercises) {
    add({ id: d.exerciseId, name: d.name, pattern: d.pattern, region: d.region, staleness: d.staleness, injuryProfile: d.injuryProfile })
  }

  // Then alternates per dealt region, in region order, until the cap.
  const regions = [...new Set(slate.exercises.map((d) => d.region))]
  let round = 0
  while (byId.size < MAX_CANDIDATES) {
    let added = false
    for (const region of regions) {
      if (byId.size >= MAX_CANDIDATES) break
      const alts = alternativesFor(pools, region, '', round + 8)
      const alt = alts[round]
      if (alt) {
        add(alt)
        added = true
      }
    }
    round += 1
    if (!added || round > 30) break
  }

  return [...byId.values()]
}

// ---------------------------------------------------------------------------
// Region targets
// ---------------------------------------------------------------------------

/** Map a free-text focus to regions. Coarse keyword mapping; unknown → []. */
export function focusToRegions(focus: string): MuscleRegion[] {
  const f = focus.toLowerCase()
  const out = new Set<MuscleRegion>()
  const add = (...rs: MuscleRegion[]) => rs.forEach((r) => out.add(r))
  if (/\bpush\b/.test(f)) add('chest', 'delts', 'triceps')
  if (/\bpull\b/.test(f)) add('lats', 'mid_back', 'biceps')
  if (/\b(legs?|lower)\b/.test(f)) add('quads', 'hamstrings', 'glutes', 'calves')
  if (/\bchest\b/.test(f)) add('chest')
  if (/\bback\b/.test(f)) add('lats', 'mid_back')
  if (/\b(shoulders?|delts?)\b/.test(f)) add('delts')
  if (/\b(arms?|biceps?|triceps?)\b/.test(f)) add('biceps', 'triceps')
  if (/\b(core|abs?)\b/.test(f)) add('abs', 'obliques')
  if (/\bupper\b/.test(f)) add('chest', 'lats', 'delts', 'biceps', 'triceps')
  if (/\bfull\b/.test(f)) add('chest', 'lats', 'quads', 'delts', 'hamstrings')
  return [...out]
}

/**
 * Build region targets for the slate. tune: derived from the template's exercises
 * (regions × ~3 sets each). draft with focus: the focus regions at a default
 * volume. draft w/o focus: the recent split (the anchor), else a sensible full-body
 * default. Pure given its inputs.
 */
export function buildRegionTargets(opts: {
  mode: PlanMode
  focus?: string
  recentSplit: Map<MuscleRegion, number>
  anchorRegions?: MuscleRegion[]
  muscleState?: CoachMuscleState[]
  readinessZone?: CoachContext['readinessZone']
}): RegionTarget[] {
  const { mode, focus, recentSplit, anchorRegions, muscleState = [], readinessZone } = opts
  const DEFAULT_SETS_PER_REGION = 9
  const stateByRegion = new Map(muscleState.map((state) => [state.region, state]))

  const volumeFor = (region: MuscleRegion, fallback = DEFAULT_SETS_PER_REGION): number => {
    const state = stateByRegion.get(region)
    let sets = recentSplit.get(region) ?? (state?.state === 'undertrained' ? 6 : fallback)
    // Recovery is deterministic, not merely prompt advice. An explicit focus or
    // anchored template may still include the region, but at half volume.
    if (state?.state === 'recovering') sets *= 0.5
    // Whole-body readiness is a conservative volume modifier. It never changes
    // exercise eligibility and never raises volume above the user's baseline.
    if (readinessZone === 'Low') sets *= 0.75
    else if (readinessZone === 'Moderate') sets *= 0.9
    return Math.max(3, Math.round(sets))
  }

  if ((mode === 'tune' || mode === 'shuffle') && anchorRegions && anchorRegions.length > 0) {
    // Preserve the anchor's per-region volume where we know it, else a default.
    const counts = new Map<MuscleRegion, number>()
    for (const r of anchorRegions) counts.set(r, (counts.get(r) ?? 0) + 1)
    return [...counts.entries()].map(([region, slots]) => ({
      region,
      workingSets: volumeFor(region, slots * 3),
    }))
  }

  if (focus) {
    const regions = focusToRegions(focus)
    if (regions.length > 0) {
      return regions.map((region) => ({
        region,
        workingSets: volumeFor(region),
      }))
    }
  }

  // No focus: choose recovered/due regions from the same body-map state the user
  // sees. This replaces the old "largest recent volume wins" behavior that could
  // repeatedly hammer the busiest muscles. Never select a recovering region when
  // at least one recovered region has usable history.
  const known = muscleState.filter((state) => state.state !== 'untrained')
  const rested = known.filter((state) => state.state !== 'recovering')
  const selectable = rested.length > 0 ? rested : known
  if (selectable.length > 0) {
    const priority: Record<string, number> = {
      undertrained: 0,
      ready: 1,
      fresh: 2,
      recovering: 3,
      untrained: 4,
    }
    return [...selectable]
      .sort((a, b) => {
        const stateDelta = (priority[a.state] ?? 9) - (priority[b.state] ?? 9)
        if (stateDelta !== 0) return stateDelta
        const dayDelta = (b.daysSince ?? -1) - (a.daysSince ?? -1)
        if (dayDelta !== 0) return dayDelta
        return a.weeklySets - b.weeklySets
      })
      .slice(0, 4)
      .map((state) => ({ region: state.region, workingSets: volumeFor(state.region) }))
  }

  // Signal read failed → retain the historical split fallback, then a balanced
  // baseline. The degraded path is deterministic and does not pretend recovery
  // data was available.
  if (recentSplit.size > 0) {
    return [...recentSplit.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([region, sets]) => ({ region, workingSets: Math.max(3, Math.round(sets)) }))
  }
  return (['chest', 'lats', 'quads', 'delts'] as MuscleRegion[]).map((region) => ({
    region,
    workingSets: DEFAULT_SETS_PER_REGION,
  }))
}

/**
 * Scale region targets down so the dealt slate can't exceed `maxExercises`
 * slots (dealSlate slots ≈ round(workingSets/3) per region). Proportional
 * scale first; drops the LOWEST-volume regions when scaling alone can't get
 * under the cap; clamps a lone oversized region last. Pure; exported for tests.
 */
export function capRegionTargets(targets: RegionTarget[], maxExercises: number): RegionTarget[] {
  const cap = Math.max(1, Math.floor(maxExercises))
  const slotsFor = (ws: number) => Math.max(1, Math.round(ws / 3))
  const totalSlots = (list: RegionTarget[]) => list.reduce((n, t) => n + slotsFor(t.workingSets), 0)
  if (targets.length === 0 || totalSlots(targets) <= cap) return targets

  const totalSets = targets.reduce((n, t) => n + t.workingSets, 0)
  const scale = (cap * 3) / Math.max(1, totalSets)
  let out = targets
    .map((t) => ({ ...t, workingSets: Math.max(3, Math.round(t.workingSets * scale)) }))
    .sort((a, b) => b.workingSets - a.workingSets)
  while (out.length > 1 && totalSlots(out) > cap) out.pop()
  if (totalSlots(out) > cap) {
    out = out.map((t) => ({ ...t, workingSets: Math.min(t.workingSets, cap * 3) }))
  }
  return out
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// ---------------------------------------------------------------------------
// Injury-aware split steering (GYM_PLAN §6 — recorded constraints at the split level)
// ---------------------------------------------------------------------------

/** Upper-body substitute regions, in preference order, for when a lower-body split
 *  is gutted by a joint injury (ankles/knees out). Big → small so an ankles-out day
 *  defaults to a coherent push/pull shape. */
const SUBSTITUTE_PRIORITY: MuscleRegion[] = [
  'chest', 'lats', 'delts', 'mid_back', 'biceps', 'triceps', 'abs',
]

/** Default per-region working sets when we synthesize a substitute target. */
const SUBSTITUTE_SETS = 9

export interface InjuryAdjustedTargets {
  /** The split to actually deal from (viable originals + substitutes). */
  targets: RegionTarget[]
  /** Original target regions dropped because an injury gutted their pool (or the
   *  region itself is 'out'). */
  droppedRegions: MuscleRegion[]
  /** Substitute regions pulled in to carry the dropped volume. */
  addedRegions: MuscleRegion[]
  /** Injuries materially steered the split (at least one region was dropped). */
  steered: boolean
  /** Every viable region was gutted with no substitute — the original split is kept
   *  unchanged and the caller surfaces the limitation honestly. */
  allGutted: boolean
}

/** ±band for per-region volume vs the anchor split. */
export const VOLUME_BAND = 0.2

/** Sets → distinct exercise slots the dealer wants for a region (mirrors dealSlate's
 *  draft-mode `max(1, round(sets/3))`). */
function slotsForSets(sets: number): number {
  return Math.max(1, Math.round(sets / 3))
}

/** Minimum pool depth a region needs to fill its target without tripping the
 *  ±VOLUME_BAND conservation gate downstream: ceil((1 − band) × slots). */
function requiredDepthFor(sets: number): number {
  return Math.max(1, Math.ceil((1 - VOLUME_BAND) * slotsForSets(sets)))
}

/**
 * Steer the split away from regions an active injury has made unviable. PURE, given
 * the already-built (injury-aware) pools.
 *
 * A target region is unviable when an out/limiting injury is active AND either the
 * region itself is 'out' (a direct muscle injury), or its post-exclusion pool is too
 * thin to fill its volume target — the case where a joint injury (ankles/knees out)
 * has gutted the region's squat/lunge/hinge/calf/stability pools. Unviable regions
 * are dropped and their volume is re-homed onto viable substitute regions (recent-
 * split regions first, then an upper-body default order). If NOTHING viable survives
 * (extreme multi-injury), the original split is kept and `allGutted` is set so the
 * caller can be honest in the rationale instead of silently degrading to fallback
 * dealing.
 *
 * When no out/limiting injury is active this is a no-op (targets returned verbatim),
 * so the uninjured planning path is byte-for-byte unchanged.
 */
export function injuryAdjustTargets(opts: {
  targets: RegionTarget[]
  pools: Map<string, Pool>
  injuries: InjuryConstraint[]
  recentSplit: Map<MuscleRegion, number>
}): InjuryAdjustedTargets {
  const { targets, pools, injuries, recentSplit } = opts
  const noop: InjuryAdjustedTargets = {
    targets, droppedRegions: [], addedRegions: [], steered: false, allGutted: false,
  }
  const active = injuries.some((i) => i.severity === 'out' || i.severity === 'limiting')
  if (!active || targets.length === 0) return noop

  const outRegions = new Set(
    injuries
      .filter((i) => i.severity === 'out' && injurySiteIsMuscleRegion(i.region))
      .map((i) => i.region as MuscleRegion),
  )
  const isViable = (region: MuscleRegion, sets: number): boolean =>
    poolDepthForRegion(pools, region) >= requiredDepthFor(sets)

  const kept: RegionTarget[] = []
  const dropped: RegionTarget[] = []
  for (const t of targets) {
    if (outRegions.has(t.region) || !isViable(t.region, t.workingSets)) dropped.push(t)
    else kept.push(t)
  }
  if (dropped.length === 0) return noop

  const droppedVolume = dropped.reduce((s, t) => s + t.workingSets, 0)
  const targeted = new Set(targets.map((t) => t.region))

  // Substitute candidates: recent-split regions (busiest first) then the upper-body
  // default order, excluding anything already targeted, injured 'out', or itself too
  // thin to carry a default block.
  const ranked: MuscleRegion[] = []
  const bySplit = [...recentSplit.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r)
  for (const r of [...bySplit, ...SUBSTITUTE_PRIORITY]) {
    if (targeted.has(r) || outRegions.has(r) || ranked.includes(r)) continue
    if (!isViable(r, SUBSTITUTE_SETS)) continue
    ranked.push(r)
  }

  const added: RegionTarget[] = []
  let addedVolume = 0
  for (const r of ranked) {
    if (addedVolume >= droppedVolume) break
    const sets = recentSplit.get(r) ?? SUBSTITUTE_SETS
    added.push({ region: r, workingSets: Math.max(3, Math.round(sets)) })
    addedVolume += sets
  }

  // Nothing survived and nothing to substitute → keep the original split but flag it.
  if (kept.length === 0 && added.length === 0) {
    return { targets, droppedRegions: [], addedRegions: [], steered: false, allGutted: true }
  }

  return {
    targets: [...kept, ...added],
    droppedRegions: dropped.map((t) => t.region),
    addedRegions: added.map((t) => t.region),
    steered: true,
    allGutted: false,
  }
}

/** A friendly region label for rationale text. */
function regionLabel(region: MuscleRegion): string {
  return REGION_LABELS[region] ?? region
}

/**
 * A one-line "why this workout" note describing how injuries steered the split, or
 * null when they didn't. Prepended to whichever rationale the plan path produces.
 */
export function describeInjurySteer(
  adj: InjuryAdjustedTargets,
  injuries: InjuryConstraint[],
): string | null {
  const injuredList = [
    ...new Set(
      injuries
        .filter((i) => i.severity === 'out' || i.severity === 'limiting')
        .map((i) => INJURY_SITE_LABELS[i.region]),
    ),
  ].join(', ')

  if (adj.allGutted) {
    return injuredList
      ? `Recorded injury constraints (${injuredList}) leave too few classified options for an automatic workout.`
      : null
  }
  if (!adj.steered || adj.droppedRegions.length === 0) return null

  const dropped = adj.droppedRegions.map(regionLabel).join('/')
  const because = injuredList || 'injury'
  if (adj.addedRegions.length > 0) {
    const added = adj.addedRegions.map(regionLabel).join('/')
    return `Recorded injury constraints shifted this to ${added} instead of ${dropped} (${because}).`
  }
  return `Recorded injury constraints removed ${dropped} today (${because}).`
}

/** Prepend the injury-steer note to a rationale (no-op when the note is null). */
function prependSteerNote(rationale: string, note: string | null): string {
  if (!note) return rationale
  const r = (rationale ?? '').trim()
  return r ? `${note} ${r}` : note
}

// ---------------------------------------------------------------------------
// Deterministic fallback (slate + policy-engine targets)
// ---------------------------------------------------------------------------

/** Turn the dealt slate straight into a proposal payload. The rationale
 *  is honest ("deterministic fallback"). The only generator in this repository,
 *  or is unavailable. Pure given the slate + defaults. */
export function fallbackPayload(
  slate: Slate,
  defaults: Map<string, { weight: number | null; reps: number | null }>,
  /** The anchor template's name, when this draft is a tune of one. A tuned draft
   *  IS that template, so it keeps its name; naming it from its muscles instead
   *  ("Chest / Lats" for Upper A) makes an agent that just said "Upper A is
   *  next" look like it staged something else entirely. */
  anchorName?: string | null,
): { payload: ProposalPayload; rationale: string } {
  const exercises: ProposalExercise[] = slate.exercises.map((d) => {
    const def = defaults.get(d.exerciseId)
    return {
      exerciseId: d.exerciseId,
      name: d.name,
      sets: d.sets,
      reps: def?.reps ?? null,
      targetWeight: def?.weight ?? null,
      supersetGroup: null,
      restSeconds: null,
      why: `Rotation pick — ${regionLabel(d.region).toLowerCase()} least recently trained.`,
      region: d.region,
    }
  })
  return {
    payload: { name: anchorName?.trim() || slateName(slate), exercises },
    rationale: 'Deterministic fallback — dealt from the staleness-weighted rotation pools with policy-engine targets.',
  }
}

/**
 * Apply the non-negotiable injury constraints to a deterministic fallback.
 * Profile filtering at pool construction normally makes this a no-op; the extra pass covers direct
 * muscle-region injuries and extreme all-gutted contexts. The fallback may be
 * empty when no compatible exercise exists — an honest empty draft beats
 * persisting a movement excluded by the recorded constraints.
 */
export function injurySafeFallback(
  fallback: ReturnType<typeof fallbackPayload>,
  injuries: InjuryConstraint[],
  anchorSplit: Map<MuscleRegion, number>,
): ReturnType<typeof fallbackPayload> {
  const out = new Set(
    injuries
      .filter((injury) => injury.severity === 'out' && injurySiteIsMuscleRegion(injury.region))
      .map((injury) => injury.region as MuscleRegion),
  )
  const limiting = new Set(
    injuries
      .filter((injury) => injury.severity === 'limiting' && injurySiteIsMuscleRegion(injury.region))
      .map((injury) => injury.region as MuscleRegion),
  )
  const used = new Map<MuscleRegion, number>()
  const exercises: ProposalExercise[] = []
  let changed = false

  for (const exercise of fallback.payload.exercises) {
    const region = exercise.region
    if (region && out.has(region)) {
      changed = true
      continue
    }
    if (region && limiting.has(region)) {
      const cap = Math.max(0, Math.floor((anchorSplit.get(region) ?? 0) * 0.5))
      const remaining = cap - (used.get(region) ?? 0)
      if (remaining <= 0) {
        changed = true
        continue
      }
      const sets = Math.min(exercise.sets, remaining)
      if (sets !== exercise.sets) changed = true
      exercises.push({ ...exercise, sets })
      used.set(region, (used.get(region) ?? 0) + sets)
      continue
    }
    exercises.push(exercise)
    if (region) used.set(region, (used.get(region) ?? 0) + exercise.sets)
  }

  if (!changed) return fallback
  const note = exercises.length > 0
    ? ' Recorded injury constraints removed or reduced incompatible work.'
    : ' No strength exercises matched the recorded training constraints; review the constraint or edit this draft before starting.'
  return {
    payload: { ...fallback.payload, exercises },
    rationale: `${fallback.rationale}${note}`,
  }
}

/** A terse name from the slate's dominant regions ("Chest / Back"). */
function slateName(slate: Slate): string {
  const counts = new Map<MuscleRegion, number>()
  for (const d of slate.exercises) counts.set(d.region, (counts.get(d.region) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r]) => cap(r.replace('_', ' ')))
  return top.length ? top.join(' / ') : 'Workout'
}

function cap(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s
}

// ---------------------------------------------------------------------------
// context_hash
// ---------------------------------------------------------------------------

/**
 * Stable hash of the coach signals that, if changed, make a proposal stale:
 * last completed workout id, a muscle-state digest, active injury ids, dislike ids,
 * goal ids, gym id. Deterministic — same signals ⇒ same hash. Exported for tests.
 */
export function computeContextHash(parts: {
  lastWorkoutId: string | null
  muscleDigest: string
  injuryRegions: string[]
  dislikeNames: string[]
  goalTitles: string[]
  gymId: string | null
}): string {
  const canonical = JSON.stringify({
    w: parts.lastWorkoutId,
    m: parts.muscleDigest,
    i: [...parts.injuryRegions].sort(),
    d: [...parts.dislikeNames].sort(),
    g: [...parts.goalTitles].sort(),
    gym: parts.gymId,
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/** Build the context_hash inputs from a CoachContext + the last workout id. */
function hashFromContext(ctx: CoachContext, lastWorkoutId: string | null): string {
  const muscleDigest = ctx.muscleState
    .map((m) => `${m.region}:${m.state}`)
    .sort()
    .join(',')
  return computeContextHash({
    lastWorkoutId,
    muscleDigest,
    injuryRegions: ctx.injuries.map((i) => i.region),
    dislikeNames: ctx.dislikes.map((d) => d.name),
    goalTitles: ctx.goals.map((g) => g.title),
    gymId: ctx.gymId,
  })
}

async function lastCompletedWorkoutId(): Promise<string | null> {
  const [row] = (
    await db.execute(
      sql`SELECT id FROM workouts WHERE status = 'completed' ORDER BY started_at DESC LIMIT 1`,
    )
  ).rows as unknown as { id: string }[]
  return row?.id ?? null
}

// ---------------------------------------------------------------------------
// History-implied defaults (policy-engine targets)
// ---------------------------------------------------------------------------

/**
 * The history-implied default is one ACTUAL weight/reps pair from each exercise's
 * MOST RECENT completed session. The most frequently repeated pair wins (then the
 * heavier pair as a deterministic tie-break), so a 200×3 top set plus 150×10
 * backoffs can never become the fictional combination 200×10. Using a lifetime
 * max can resurrect an old PR after detraining, injury, or a deliberate deload.
 * These recent-session values drive candidate hints, fallback targets, and the
 * ±15% gate. lb-normalized. Only ids in `ids` are queried.
 */
async function historyDefaults(
  ids: string[],
): Promise<Map<string, { weight: number | null; reps: number | null }>> {
  const out = new Map<string, { weight: number | null; reps: number | null }>()
  if (ids.length === 0) return out
  const rows = (
    await db.execute(sql`
      WITH ranked_sets AS (
        SELECT we.exercise_id AS id, w.id AS workout_id, ws.id AS set_id,
          COALESCE(ws.logical_set_id, ws.client_set_id, ws.id) AS logical_set_id,
          ws.set_number,
          CASE WHEN ws.weight_unit = 'kg' THEN ws.weight * 2.20462 ELSE ws.weight END AS weight_lb,
          ws.reps,
          dense_rank() OVER (
            PARTITION BY we.exercise_id
            ORDER BY w.started_at DESC, w.id DESC
          ) AS session_rank
        FROM workout_sets ws
        JOIN workout_exercises we ON ws.workout_exercise_id = we.id
        JOIN workouts w ON we.workout_id = w.id AND w.status = 'completed'
        WHERE we.exercise_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
          AND ws.completed = true
          AND ws.set_type <> 'warmup'
          AND ws.reps IS NOT NULL AND ws.reps > 0
      ), logical_sets AS (
        SELECT *,
          row_number() OVER (
            PARTITION BY id, workout_id, logical_set_id
            ORDER BY set_number, set_id
          ) AS logical_row
        FROM ranked_sets
      ), pair_counts AS (
        SELECT id, weight_lb, reps, count(*)::int AS pair_count
        FROM logical_sets
        WHERE session_rank = 1 AND logical_row = 1
        GROUP BY id, weight_lb, reps
      ), representative_pairs AS (
        SELECT id, weight_lb, reps,
          row_number() OVER (
            PARTITION BY id
            ORDER BY pair_count DESC, weight_lb DESC NULLS LAST, reps DESC
          ) AS pair_rank
        FROM pair_counts
      )
      SELECT id,
        weight_lb::float8 AS representative_weight,
        reps AS representative_reps
      FROM representative_pairs
      WHERE pair_rank = 1
    `)
  ).rows as unknown as Array<{
    id: string
    representative_weight: number | null
    representative_reps: number | null
  }>
  for (const r of rows) {
    out.set(r.id, {
      weight: r.representative_weight != null ? Math.round(r.representative_weight) : null,
      reps: r.representative_reps != null ? Number(r.representative_reps) : null,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// tune/shuffle anchor reads
// ---------------------------------------------------------------------------

interface TemplateAnchorRead {
  exercises: AnchorExercise[]
  /** The template's own name. A tuned draft is that template, so it should say
   *  so: naming it from its muscles instead ("Chest / Lats" for Upper A) makes
   *  an agent that just said "Upper A is next" look like it staged something
   *  else. Null when the row is gone; the muscle name is the fallback. */
  name: string | null
  /** Exact same-exercise warm-up rows, keyed by exercises.id. Working rows remain
   * tunable; only these explicitly authored rows are reattached after validation. */
  warmupsByExercise: Map<string, ProposalSetPrescription[]>
}

/** Read a template's anchor slots plus its explicitly-authored warm-up rows.
 * Template weights are normalized to proposal-canonical pounds at this boundary. */
async function templateAnchor(templateId: string): Promise<TemplateAnchorRead> {
  const nameRow = (
    await db.execute(sql`SELECT name FROM workout_templates WHERE id = ${templateId}`)
  ).rows[0] as { name?: string } | undefined

  const rows = (
    await db.execute(sql`
      SELECT te.id AS template_exercise_id, te.exercise_id,
        e.name, e.primary_muscle, e.secondary_muscles,
        ts.set_number, ts.target_weight::text AS target_weight, ts.target_weight_unit,
        ts.target_reps, ts.target_duration_s, ts.target_rpe::text AS target_rpe,
        ts.rest_seconds, ts.side
      FROM template_exercises te
      JOIN exercises e ON e.id = te.exercise_id
      LEFT JOIN template_sets ts
        ON ts.template_exercise_id = te.id AND ts.set_type = 'warmup'
      WHERE te.template_id = ${templateId}
      ORDER BY te.position, ts.set_number
    `)
  ).rows as unknown as Array<{
    template_exercise_id: string
    exercise_id: string
    name: string
    primary_muscle: string | null
    secondary_muscles: unknown
    set_number: number | null
    target_weight: string | null
    target_weight_unit: string | null
    target_reps: number | null
    target_duration_s: number | null
    target_rpe: string | null
    rest_seconds: number | null
    side: string | null
  }>

  const exercises: AnchorExercise[] = []
  const seenSlots = new Set<string>()
  const warmupsByExercise = new Map<string, ProposalSetPrescription[]>()
  for (const row of rows) {
    if (!seenSlots.has(row.template_exercise_id)) {
      seenSlots.add(row.template_exercise_id)
      const region = primaryRegionFor(row.name, row.primary_muscle, row.secondary_muscles)
      if (region) exercises.push({ exerciseId: row.exercise_id, region })
    }
    if (row.set_number == null) continue
    const targetWeight = convertWeight(
      row.target_weight == null ? null : Number(row.target_weight),
      normalizeWeightUnit(row.target_weight_unit),
      'lb',
      3,
    )
    const warmup: ProposalSetPrescription = {
      setType: 'warmup',
      targetWeight,
      reps: row.target_reps,
      targetDurationS: row.target_duration_s,
      targetRpe: row.target_rpe == null ? null : Number(row.target_rpe),
      restSeconds: row.rest_seconds,
      side: row.side === 'left' || row.side === 'right' ? row.side : null,
    }
    const existing = warmupsByExercise.get(row.exercise_id)
    if (existing) existing.push(warmup)
    else warmupsByExercise.set(row.exercise_id, [warmup])
  }
  return { exercises, warmupsByExercise, name: nameRow?.name ?? null }
}

/** Reattach only warm-ups that came from the explicit tune anchor. This runs
 * after the planner gate, so the model can never smuggle a default warm-up in;
 * working prescriptions remain whatever the tuned plan selected. */
function preserveTemplateWarmups(
  payload: ProposalPayload,
  warmupsByExercise: Map<string, ProposalSetPrescription[]>,
): ProposalPayload {
  if (warmupsByExercise.size === 0) return payload
  return {
    ...payload,
    exercises: payload.exercises.map((exercise) => {
      const warmups = warmupsByExercise.get(exercise.exerciseId)
      if (!warmups?.length) return exercise
      const working = resolveProposalSetPrescriptions(exercise).filter(
        (set) => set.setType !== 'warmup',
      )
      return {
        ...exercise,
        setPrescriptions: [
          ...warmups.map((set) => ({ ...set })),
          ...working.map((set) => ({ ...set })),
        ],
      }
    }),
  }
}

/** The prior proposal's payload exercises (for shuffle exclusion). */
async function priorProposalExercises(
  proposalId: string,
): Promise<{ ids: string[]; regions: MuscleRegion[]; payloadHash: string } | null> {
  const [row] = (
    await db.execute(sql`
      SELECT payload, md5(payload::text) AS payload_hash
      FROM workout_proposals
      WHERE id = ${proposalId} AND status = 'proposed'
      LIMIT 1
    `)
  ).rows as unknown as Array<{ payload: unknown; payload_hash: string }>
  const payload = row?.payload as ProposalPayload | undefined
  if (!row || !payload || !Array.isArray(payload.exercises)) return null
  const ids = payload.exercises.map((e) => e.exerciseId).filter((x): x is string => typeof x === 'string')
  const regions = payload.exercises
    .map((e) => e.region)
    .filter((r): r is MuscleRegion => r != null)
  return { ids, regions, payloadHash: row.payload_hash }
}

/** Resolve an exercise's primary muscle region via the enriched mapper. */
function primaryRegionFor(name: string, primaryMuscle: string | null, secondary: unknown): MuscleRegion | null {
  const sec = Array.isArray(secondary) ? secondary.filter((x): x is string => typeof x === 'string') : []
  const hits = musclesForExerciseEnriched(name, primaryMuscle, sec)
  const primary = hits.find((h) => h.weight === 1) ?? hits[0]
  return primary?.region ?? null
}

// ---------------------------------------------------------------------------
// generatePlan — the orchestrator
// ---------------------------------------------------------------------------

/**
 * Generate a plan (draft | tune | shuffle) and persist it as a `workout_proposals`
 * row (superseding prior proposed rows for today). Deals the slate
 * deterministically under the active constraints. Returns the persisted
 * Proposal.
 */
export async function generatePlan(input: GeneratePlanInput): Promise<Proposal> {
  const ctx = await assembleCoachContext(input.mode === 'draft' ? true : false)

  // Anchor + exclusions.
  let anchor: AnchorExercise[] | undefined
  let exclude: string[] | undefined
  let anchorRegions: MuscleRegion[] | undefined
  let anchorName: string | null = null
  let anchoredWarmups = new Map<string, ProposalSetPrescription[]>()
  let persistBinding: ProposalPersistBinding | undefined

  if (input.mode === 'tune' && input.templateId) {
    let template: TemplateAnchorRead
    try {
      template = await templateAnchor(input.templateId)
    } catch (error) {
      console.warn(
        '[gym/plan] template anchor read failed:',
        error instanceof Error ? error.message : String(error),
      )
      throw new TemplateAnchorUnavailableError(input.templateId)
    }
    if (template.exercises.length === 0) {
      throw new TemplateAnchorUnavailableError(input.templateId)
    }
    anchor = template.exercises
    anchoredWarmups = template.warmupsByExercise
    anchorRegions = anchor.map((a) => a.region)
    anchorName = template.name
  } else if (input.mode === 'shuffle' && input.proposalId) {
    // This read captures the exact payload the shuffle is derived from. Persistence
    // compares both id and hash under lock; a newer proposal or in-place edit wins.
    const prior = await priorProposalExercises(input.proposalId)
    if (!prior) throw new ProposalWriteConflictError(input.proposalId)
    exclude = prior.ids
    anchorRegions = prior.regions
    persistBinding = { proposalId: input.proposalId, payloadHash: prior.payloadHash }
  }

  let targets = buildRegionTargets({
    mode: input.mode,
    focus: input.focus,
    recentSplit: ctx.recentSplit,
    anchorRegions,
    muscleState: ctx.muscleState,
    readinessZone: ctx.readinessZone,
  })

  // Injury-aware split steering (draft/shuffle only — tune honors an explicit
  // template, so we never re-route its structure). When an active out/limiting
  // injury has gutted a target region's pool below its volume target (e.g. ankles
  // out → the squat/lunge/hinge/calf/stability pools are empty), swap that region
  // for a viable alternative instead of silently dealing a degraded lower-body
  // slate that can only be filled by the fallback dealer.
  const injuries = ctx.injuries.map((i) => ({ region: i.region, severity: i.severity }))
  const injuryAdj =
    input.mode === 'tune'
      ? null
      : injuryAdjustTargets({ targets, pools: ctx.pools, injuries, recentSplit: ctx.recentSplit })
  if (injuryAdj) targets = injuryAdj.targets
  const injurySteer = injuryAdj ? describeInjurySteer(injuryAdj, injuries) : null

  // Explicit size cap ("keep it short", first session back): applied BEFORE the
  // deal, so the slate, the candidate list, and the deterministic fallback all
  // shrink together. Tune keeps its template's structure (like injury steering).
  if (input.maxExercises != null && input.mode !== 'tune') {
    targets = capRegionTargets(targets, input.maxExercises)
  }

  // Deal the slate deterministically (seed from date + mode + focus so re-drafting
  // the same day varies by mode/focus but shuffles are excludes-driven).
  const seed = seedFromString(`${ctx.today}|${input.mode}|${input.focus ?? ''}|${input.proposalId ?? ''}`)
  const rng = mulberry32(seed)
  const slate = dealSlate(ctx.pools, targets, rng, { exclude, anchorTemplate: anchor })

  // Build the candidate list + history defaults.
  const candidateIds = new Set<string>(slate.exercises.map((d) => d.exerciseId))
  // Add alternates' ids too (buildCandidates pulls them; pre-fetch defaults for all).
  const candidatesPre = buildCandidates(slate, ctx.pools, new Map())
  for (const c of candidatesPre) candidateIds.add(c.id)
  const rawDefaults = await failSafe(() => historyDefaults([...candidateIds]), new Map())
  // #1790 — the history-implied default is the MOST RECENT session, which is
  // the right guard against a lifetime PR resurfacing but says nothing about
  // WHEN that session was. After a layoff it is itself stale, so ease it back
  // before it reaches the hints, the fallback targets or the ±15% gate.
  const detrainingMarks = await failSafe(
    () => readDetrainingMarksBatch([...candidateIds]),
    new Map(),
  )
  // Region marks detect the layoff (pressing is pressing, barbell or dumbbell);
  // the per-exercise marks supply the baseline and the specificity trim.
  const regionIndex = await failSafe(loadRegionIndex, new Map())
  const regionMarks = await failSafe(
    () => readRegionMarksBatch([...candidateIds], regionIndex),
    new Map<string, SessionMark[]>(),
  )
  const eased = deloadHistoryDefaults(
    rawDefaults,
    detrainingMarks,
    Date.now(),
    'lb',
    regionMarks,
  )
  const defaults = eased.defaults
  // The eased weights used to flow through while the EXPLANATION was dropped on
  // the floor — the same silent-change bug as the active snapshot. One terse
  // line on the draft's rationale, naming the movements that were eased.
  const easedNames = [...eased.reasons.keys()]
    .map((id) => candidatesPre.find((c) => c.id === id)?.name)
    .filter((n): n is string => Boolean(n))
  const layoffNote =
    eased.reasons.size === 0
      ? null
      : `Easing back after time off — ${easedNames.slice(0, 3).join(', ')}` +
        `${easedNames.length > 3 ? ` and ${easedNames.length - 3} more` : ''} ` +
        `start below your last working weights and climb over the next few sessions.`
  const steerNote = [injurySteer, layoffNote].filter(Boolean).join(' ') || null
  const candidates = buildCandidates(slate, ctx.pools, defaults)
  const programmingHistory = await failSafe(readProgrammingHistory, EMPTY_PROGRAMMING_HISTORY)
  const programmingMetadata = new Map<string, ProgrammingMetadata>(
    candidates.map((candidate) => [candidate.id, {
      region: candidate.region,
      pattern: candidate.pattern,
    }]),
  )
  const programmingPolicy = normalizeWorkoutProgrammingPolicy({
    goal: resolveProgrammingGoal(input.focus, ctx.goals),
  })
  const payloadForPersist = (payload: ProposalPayload): ProposalPayload => {
    const anchored = preserveTemplateWarmups(payload, anchoredWarmups)
    return {
      ...anchored,
      programmingPolicy,
      exercises: programWorkout(anchored.exercises, {
        metadata: programmingMetadata,
        history: programmingHistory,
        policy: programmingPolicy,
        preserveExplicitRest: false,
        redistributeWorkingSets: true,
      }),
    }
  }

  // Guard: too few candidates → deterministic fallback outright (nothing to plan).
  if (candidates.length < Math.min(MIN_CANDIDATES, slate.exercises.length) || slate.exercises.length === 0) {
    const fb = fallbackPayload(slate, defaults, anchorName)
    const persisted = await persistProposal(
      ctx,
      payloadForPersist(fb.payload),
      prependSteerNote(fb.rationale, steerNote),
      persistBinding,
    )
    return { ...persisted, generator: 'fallback' }
  }

  // Deal the workout deterministically: the slate the rotation pools produced,
  // scored against the session's own region targets and filtered by the active
  // constraints. The adaptive planner is not part of this repo.
  const anchorSplit = anchorSplitFor(slate, targets, ctx.recentSplit)
  const fb = injurySafeFallback(fallbackPayload(slate, defaults, anchorName), injuries, anchorSplit)
  const persisted = await persistProposal(
    ctx,
    payloadForPersist(fb.payload),
    prependSteerNote(fb.rationale, steerNote),
    persistBinding,
  )
  return { ...persisted, generator: 'fallback' }
}

/** The anchor split the gate measures against: the SESSION's final region
 *  targets — post injury-steer, readiness modifiers, and the maxExercises cap —
 *  i.e. the exact numbers the draft is asked to hit. The
 *  historical recent split is only a fallback for a slate region the targets
 *  don't cover, then the slate's own volume (so a from-scratch draft conserves
 *  against itself rather than failing on an empty anchor). Anchoring on the raw
 *  recent split instead used to reject every deliberately-light draft (focus
 *  "keep it light", small maxExercises, Low readiness) on region_volume even
 *  though the draft matched its targets. Exported for tests.
 */
export function anchorSplitFor(
  slate: Slate,
  targets: RegionTarget[],
  recentSplit: Map<MuscleRegion, number>,
): Map<MuscleRegion, number> {
  const out = new Map<MuscleRegion, number>()
  const targetByRegion = new Map(targets.map((t) => [t.region, t.workingSets]))
  const slateVol = regionVolume(slate.exercises.map((d) => ({ region: d.region, sets: d.sets })))
  for (const [region, sets] of slateVol) {
    out.set(region, targetByRegion.get(region) ?? recentSplit.get(region) ?? sets)
  }
  return out
}

/** Wrap a read so one failure fails-safe to a default (the whole planner is
 *  fail-open — a dead sub-read degrades to the deterministic path). */
async function failSafe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.warn('[gym/plan] sub-read failed (fail-safe):', err instanceof Error ? err.message : String(err))
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Default rest (the shipped gym_default_rest_seconds app setting)
// ---------------------------------------------------------------------------

/** Fallback when the setting is missing (mirrors /api/gym/settings DEFAULTS). */
export const DEFAULT_REST_SECONDS = 120

/** Read the user's default rest (seconds) from the single-row app_settings table.
 *  Fail-safe wrapped by callers; DEFAULT_REST_SECONDS when the column is null. */
async function readDefaultRestSeconds(): Promise<number> {
  const [row] = (
    await db.execute(sql`SELECT gym_default_rest_seconds FROM app_settings WHERE id = 1 LIMIT 1`)
  ).rows as unknown as Array<{ gym_default_rest_seconds: number | null }>
  const v = row?.gym_default_rest_seconds
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_REST_SECONDS
}

/** Fill any null per-exercise restSeconds with the user's default rest setting.
 *  Pure — non-null overrides (an explicit set_rest, or a per-exercise value
 *  already on the payload) are preserved. */
function withDefaultRest(payload: ProposalPayload, defaultRest: number): ProposalPayload {
  return {
    ...payload,
    exercises: payload.exercises.map((e) => ({
      ...e,
      restSeconds: e.restSeconds ?? defaultRest,
    })),
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface ProposalPersistBinding {
  proposalId: string
  payloadHash: string
}

interface PersistedProposalRow {
  id: string
  status: string
  created_at: string
}

/** Persist a proposal for today, superseding prior 'proposed' rows for the date.
 * Every writer shares one transaction-scoped advisory lock, so the supersede +
 * insert pair is atomic relative to other drafts. A shuffle additionally binds
 * to the exact current proposal payload it sampled; changed state fails closed. */
async function persistProposal(
  ctx: CoachContext,
  payload: ProposalPayload,
  rationale: string,
  binding?: ProposalPersistBinding,
): Promise<Proposal> {
  const lastWorkoutId = await failSafe(lastCompletedWorkoutId, null)
  const contextHash = hashFromContext(ctx, lastWorkoutId)
  const forDate = ctx.today

  // Fill null per-exercise rest with the shipped default so a drafted slot never
  // materializes rest-less (the logger's own default is a separate, later fallback).
  const defaultRest = await failSafe(readDefaultRestSeconds, DEFAULT_REST_SECONDS)
  const filled = withDefaultRest(payload, defaultRest)

  const row = await db.transaction(async (tx): Promise<PersistedProposalRow | null> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('gym:proposal-persist'))`)

    if (binding) {
      const [current] = (
        await tx.execute(sql`
          SELECT id, md5(payload::text) AS payload_hash
          FROM workout_proposals
          WHERE for_date = ${forDate} AND status = 'proposed'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE
        `)
      ).rows as unknown as Array<{ id: string; payload_hash: string }>
      if (
        current?.id !== binding.proposalId ||
        current.payload_hash !== binding.payloadHash
      ) {
        return null
      }
    }

    // Supersede prior proposed rows for today (only 'proposed' — never touch
    // started/dismissed history), then insert the replacement in the same tx.
    await tx.execute(sql`
      UPDATE workout_proposals SET status = 'superseded'
      WHERE for_date = ${forDate} AND status = 'proposed'
    `)

    const [inserted] = (
      await tx.execute(sql`
      INSERT INTO workout_proposals (for_date, payload, rationale, context_hash, status)
      VALUES (${forDate}, ${JSON.stringify(filled)}::jsonb, ${rationale}, ${contextHash}, 'proposed')
      RETURNING id, status, created_at::text AS created_at
    `)
    ).rows as unknown as PersistedProposalRow[]
    return inserted ?? null
  })

  if (!row) {
    if (binding) throw new ProposalWriteConflictError(binding.proposalId)
    throw new Error('Workout proposal insert returned no row.')
  }

  // Return the values we WROTE (payload/rationale/hash), not a RETURNING echo —
  // the payload is a big jsonb we already have in hand, and this keeps the returned
  // object authoritative even if the driver round-trips the jsonb differently.
  return {
    id: row.id,
    forDate,
    status: row.status,
    rationale,
    payload: filled,
    contextHash,
    createdAt: row.created_at,
  }
}

export interface LockedProposalEditor {
  current: Proposal | null
  update: (payload: ProposalPayload) => Promise<Proposal | null>
}

/**
 * Serializes the conversational-edit read-modify-write. The harness runs a turn's
 * tool calls concurrently (Promise.all — see harness.ts), so a single "set rest to
 * 2 min on everything" ask can fire several edit_workout_proposal calls in
 * parallel. Each call otherwise reads the full exercises array and writes the
 * whole array back, letting the last write silently drop earlier edits (#1096).
 *
 * The proposal SELECT and UPDATE intentionally use the SAME locked transaction.
 * Holding an advisory lock on one pooled connection while issuing the protected
 * queries through `db` could deadlock when waiting callers exhaust the pool.
 */
export async function withProposalEditLock<T>(
  ctx: CoachContext,
  fn: (editor: LockedProposalEditor) => Promise<T>,
): Promise<T> {
  // Complete supporting reads before reserving a pool connection for the lock.
  const defaultRest = await failSafe(readDefaultRestSeconds, DEFAULT_REST_SECONDS)
  const lastWorkoutId = await failSafe(lastCompletedWorkoutId, null)
  const currentHash = hashFromContext(ctx, lastWorkoutId)

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('gym:proposal-edit'))`)

    const [row] = (
      await tx.execute(sql`
        SELECT id, for_date::text AS for_date, status, rationale, payload, context_hash,
          created_at::text AS created_at
        FROM workout_proposals
        WHERE for_date = ${ctx.today} AND status = 'proposed'
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `)
    ).rows as unknown as Array<{
      id: string
      for_date: string
      status: string
      rationale: string | null
      payload: unknown
      context_hash: string | null
      created_at: string
    }>

    const current: Proposal | null = row
      ? {
          id: row.id,
          forDate: row.for_date,
          status: row.status,
          rationale: row.rationale,
          payload: (row.payload ?? { name: 'Workout', exercises: [] }) as ProposalPayload,
          contextHash: row.context_hash,
          createdAt: row.created_at,
          stale: row.context_hash != null && row.context_hash !== currentHash,
        }
      : null

    return fn({
      current,
      update: async (payload) => {
        if (!current) return null
        const filled = withDefaultRest(payload, defaultRest)
        const [updated] = (
          await tx.execute(sql`
            UPDATE workout_proposals
            SET payload = ${JSON.stringify(filled)}::jsonb, context_hash = ${currentHash}
            WHERE id = ${current.id} AND status = 'proposed'
            RETURNING id, for_date::text AS for_date, status, rationale, created_at::text AS created_at
          `)
        ).rows as unknown as Array<{
          id: string
          for_date: string
          status: string
          rationale: string | null
          created_at: string
        }>
        if (!updated) return null
        return {
          id: updated.id,
          forDate: updated.for_date,
          status: updated.status,
          rationale: updated.rationale,
          payload: filled,
          contextHash: currentHash,
          createdAt: updated.created_at,
          stale: false,
        }
      },
    })
  })
}

/**
 * Overwrite an EXISTING proposal's payload in place — the conversational-edit path
 * (edit_workout_proposal). Preserves the id + status, fills default rest for any
 * null slot, and RECOMPUTES context_hash to the CURRENT context so the just-edited
 * proposal never shows a stale banner right after the user's own edit (unlike shuffle,
 * which mints a new row). Returns the updated Proposal, or null when the row isn't a
 * live 'proposed' row (already started/dismissed/superseded/missing). This standalone
 * helper is for non-concurrent callers; conversational edits use
 * `withProposalEditLock`, whose read and write share one transaction.
 */
export async function updateProposalPayload(
  id: string,
  payload: ProposalPayload,
): Promise<Proposal | null> {
  const ctx = await assembleCoachContext()
  const defaultRest = await failSafe(readDefaultRestSeconds, DEFAULT_REST_SECONDS)
  const filled = withDefaultRest(payload, defaultRest)
  const lastWorkoutId = await failSafe(lastCompletedWorkoutId, null)
  const contextHash = hashFromContext(ctx, lastWorkoutId)

  const [row] = (
    await db.execute(sql`
      UPDATE workout_proposals
      SET payload = ${JSON.stringify(filled)}::jsonb, context_hash = ${contextHash}
      WHERE id = ${id} AND status = 'proposed'
      RETURNING id, for_date::text AS for_date, status, rationale, created_at::text AS created_at
    `)
  ).rows as unknown as Array<{
    id: string
    for_date: string
    status: string
    rationale: string | null
    created_at: string
  }>
  if (!row) return null

  return {
    id: row.id,
    forDate: row.for_date,
    status: row.status,
    rationale: row.rationale,
    payload: filled,
    contextHash,
    createdAt: row.created_at,
    stale: false,
  }
}

// ---------------------------------------------------------------------------
// getTodayProposal (GET — never generates)
// ---------------------------------------------------------------------------

/**
 * The latest 'proposed' proposal for today + a `stale` flag (the recomputed context
 * hash no longer matches what it was generated with → the UI offers a refresh).
 * Assembles the (cached) context to recompute the hash — never generates.
 */
export async function getTodayProposal(): Promise<Proposal | null> {
  const ctx = await assembleCoachContext()
  const forDate = ctx.today
  const [row] = (
    await db.execute(sql`
      SELECT id, for_date::text AS for_date, status, rationale, payload, context_hash,
        created_at::text AS created_at
      FROM workout_proposals
      WHERE for_date = ${forDate} AND status = 'proposed'
      ORDER BY created_at DESC
      LIMIT 1
    `)
  ).rows as unknown as Array<{
    id: string
    for_date: string
    status: string
    rationale: string | null
    payload: unknown
    context_hash: string | null
    created_at: string
  }>
  if (!row) return null

  const lastWorkoutId = await failSafe(lastCompletedWorkoutId, null)
  const currentHash = hashFromContext(ctx, lastWorkoutId)
  const stale = row.context_hash != null && row.context_hash !== currentHash

  return {
    id: row.id,
    forDate: row.for_date,
    status: row.status,
    rationale: row.rationale,
    payload: normalizeProposalExerciseNames(
      (row.payload ?? { name: 'Workout', exercises: [] }) as ProposalPayload,
    ),
    contextHash: row.context_hash,
    createdAt: row.created_at,
    stale,
  }
}

// ---------------------------------------------------------------------------
// dismiss + start
// ---------------------------------------------------------------------------

/** Dismiss a proposal (status → 'dismissed'). Returns false if not 'proposed'
 *  (honest rowcount — already started/dismissed/superseded/missing). */
export async function dismissProposal(proposalId: string): Promise<boolean> {
  const rows = (
    await db.execute(sql`
      UPDATE workout_proposals SET status = 'dismissed'
      WHERE id = ${proposalId} AND status = 'proposed'
      RETURNING id
    `)
  ).rows as unknown as Array<{ id: string }>
  return rows.length > 0
}

export interface StartFromProposalResult {
  workout?: ActiveWorkout
  /** An active workout already exists — the route 409s (UI offers resume/discard). */
  conflictActiveWorkoutId?: string
  /** The proposal wasn't in a startable state (missing / already used). */
  notStartable?: boolean
}

/**
 * Materialize a proposal as an active workout: create the workout + its
 * workout_exercises plus immutable set prescriptions directly from the payload, and
 * flip the proposal to 'started'. Guards on a single active workout (409). The
 * exercise targets come from the payload and are materialized before the
 * transaction commits, so the logger opens with the exact reviewed workout.
 */
export async function proposalToWorkoutStart(proposalId: string): Promise<StartFromProposalResult> {
  const [prop] = (
    await db.execute(
      sql`SELECT id, payload, status FROM workout_proposals WHERE id = ${proposalId} LIMIT 1`,
    )
  ).rows as unknown as Array<{ id: string; payload: unknown; status: string }>
  if (!prop || prop.status !== 'proposed') return { notStartable: true }

  const payload = prop.payload as ProposalPayload
  if (!payload || !Array.isArray(payload.exercises) || payload.exercises.length === 0) {
    return { notStartable: true }
  }
  if (new Set(payload.exercises.map((exercise) => exercise.exerciseId)).size !== payload.exercises.length) {
    return { notStartable: true }
  }

  // One-active-workout guard.
  const [active] = (
    await db.execute(sql`SELECT id FROM workouts WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`)
  ).rows as unknown as Array<{ id: string }>
  if (active) return { conflictActiveWorkoutId: active.id }

  let workoutId: string | null
  try {
    workoutId = await db.transaction(async (tx) => {
      const [locked] = (
        await tx.execute(sql`
          SELECT status, payload FROM workout_proposals
          WHERE id = ${proposalId}
          FOR UPDATE
        `)
      ).rows as unknown as Array<{ status: string; payload: unknown }>
      if (locked?.status !== 'proposed') return null

      // The proposal may have been edited after the optimistic read above but
      // before this transaction acquired the row lock. Materialize the locked
      // snapshot so Start always opens the exact proposal that wins that race.
      const lockedPayload = locked.payload as ProposalPayload
      if (!lockedPayload || !Array.isArray(lockedPayload.exercises) || lockedPayload.exercises.length === 0) {
        return null
      }

      const [created] = (
      await tx.execute(sql`
        INSERT INTO workouts (name, started_at, status, source, proposal_id)
        VALUES (${normalizeGeneratedWorkoutName(lockedPayload.name || 'Planned workout')}, now(), 'active', 'app', ${proposalId})
        RETURNING id
      `)
      ).rows as unknown as Array<{ id: string }>
      const wid = created!.id

      let position = 0
      for (const ex of lockedPayload.exercises) {
        const [inserted] = (
        await tx.execute(sql`
        INSERT INTO workout_exercises (workout_id, exercise_id, position, superset_group, rest_seconds, section)
        VALUES (${wid}, ${ex.exerciseId}, ${position}, ${ex.supersetGroup ?? null}, ${ex.restSeconds ?? null}, ${ex.section ?? 'main'})
        RETURNING id
      `)
        ).rows as unknown as Array<{ id: string }>
        if (inserted) {
          const prescriptions: SetPrescriptionInput[] = resolveProposalSetPrescriptions(ex)
            .map((set, index) => ({
              setNumber: index + 1,
              setType: set.setType,
              weight: set.targetWeight,
              weightUnit: 'lb',
              reps: set.reps,
              durationS: set.targetDurationS,
              rpe: set.targetRpe,
              restSeconds: set.restSeconds,
              side: set.side,
              source: 'proposal',
            }))
          await materializeSetPrescriptions(
            (query) => tx.execute(query),
            inserted.id,
            prescriptions,
          )
        }
        position += 1
      }

      await tx.execute(sql`
        UPDATE workout_proposals SET status = 'started' WHERE id = ${proposalId} AND status = 'proposed'
      `)
      return wid
    })
  } catch (error) {
    if (!isActiveWorkoutSingletonViolation(error)) throw error
    const [winner] = (
      await db.execute(sql`SELECT id FROM workouts WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`)
    ).rows as unknown as Array<{ id: string }>
    if (winner) return { conflictActiveWorkoutId: winner.id }
    throw error
  }

  if (!workoutId) return { notStartable: true }

  const workout = await getActiveWorkoutById(workoutId)
  return { workout: workout ?? undefined }
}

// Re-export the pure pieces the tests + route touch.
export type { DealtExercise, PoolExercise }
