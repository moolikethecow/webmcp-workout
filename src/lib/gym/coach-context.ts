/**
 * Deterministic coach-context assembly (GYM_PLAN §6). Gathers every signal the
 * planner reasons over into ONE typed object plus a compact (~2–3KB) prompt-ready
 * text rendering — the SAME assembly whether the caller is `plan.ts` (drafting) or
 * a future gym-day brief. NO LLM anywhere on this path; it is pure reads folded
 * deterministically.
 *
 * Non-safety sub-reads fail open individually. Injury state is the exception: a
 * failed injury read injects an unclassified out constraint, which intentionally
 * empties recommendation pools instead of pretending there are no injuries.
 *
 * Reuse (never duplicate):
 *   - muscle state  → lib/fitness/muscle-map.buildMuscleMap
 *   - readiness     → lib/health/readiness.computeReadiness (composite zone)
 *   - goal signals  → lib/goals/health-signals (exercise e1RM trends)
 *   - catalog rows  → the enriched `exercises` columns novelty.ts consumes
 */
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { buildMuscleMap } from '@/lib/fitness/muscle-map'
import { isMuscleRegion, type MuscleRegion } from '@/lib/fitness/muscles'
import { exerciseE1rms } from '@/lib/goals/health-signals'
import { computeReadiness } from '@/lib/health/readiness'
import { convertWeight, isWeightUnit } from '@/lib/units/weight'
import type { ProgrammingGoal } from './programming-policy'
import { logicalSetKey } from './load-semantics'
import {
  isInjurySite,
  parseExerciseInjuryProfile,
  type InjurySite,
} from './injury-profile'
import {
  buildPools,
  gymEquipmentTokens,
  gymExcludedNames,
  gymCompatible,
  isSnoozed,
  stalenessScore,
  type CatalogExercise,
  type GymEquipment,
  type Pool,
} from './novelty'

// ---------------------------------------------------------------------------
// The typed context object
// ---------------------------------------------------------------------------

export interface CoachGoal {
  title: string
  area: string | null
  fitnessIntent?: ProgrammingGoal | null
  /** For an exercise-linked goal: the linked lift name + its current/target e1RM. */
  exerciseName?: string
  current?: number | null
  target?: number | null
  trend?: 'up' | 'down' | 'flat' | null
}

export interface CoachExerciseSummary {
  name: string
  /** Compact last working-set line, e.g. "3×8@170lb". */
  lastSets: string
  /** e1RM 28d trend direction, or null when not enough data. */
  e1rmTrend: 'up' | 'down' | 'flat' | null
}

export interface CoachWorkoutSummary {
  date: string
  name: string | null
  exercises: CoachExerciseSummary[]
}

export interface CoachMuscleState {
  region: MuscleRegion
  state: string
  daysSince: number | null
  weeklySets: number
}

export interface CoachInjury {
  region: InjurySite
  severity: 'nagging' | 'limiting' | 'out' | string
  label: string | null
}

export interface CoachDislike {
  name: string
  reason: string | null
}

/** An exercise the user has explicitly marked preferred (the "Preferred it"
 *  replace-reason chip, #1876) — biases drafting toward it. */
export interface CoachPreference {
  name: string
}

export interface StalenessStats {
  /** How many eligible (non-disliked, in-gym) exercises exist. */
  poolSize: number
  /** The stalest few exercise names (novelty candidates), for the prompt. */
  stalest: string[]
  /** The freshest (most-recently-hammered) few, for context. */
  freshest: string[]
}

export interface CoachContext {
  /** App-tz today (YYYY-MM-DD). */
  today: string
  goals: CoachGoal[]
  recentWorkouts: CoachWorkoutSummary[]
  muscleState: CoachMuscleState[]
  injuries: CoachInjury[]
  dislikes: CoachDislike[]
  preferences: CoachPreference[]
  /** The default gym's equipment jsonb (null = no gym / no filter). */
  gymEquipment: string[] | GymEquipment | null
  gymName: string | null
  gymId: string | null
  /** Today's readiness zone word, or null (fail-open). */
  readinessZone: 'Primed' | 'Moderate' | 'Low' | null
  staleness: StalenessStats
  /** The enriched catalog rows (feeds novelty.buildPools). Not rendered in text. */
  catalog: CatalogExercise[]
  /** Pre-built rotation pools (buildPools over catalog + gymEquipment). */
  pools: Map<string, Pool>
  /** The per-region weekly working-set split from recent completed history — the
   *  anchor the volume-conservation gate measures against. */
  recentSplit: Map<MuscleRegion, number>
  /** §10b.8 mobility block (~300B in text form): passive weekly hold minutes vs
   *  the 10-min/muscle target + the trained-but-unstretched regions. Null =
   *  read failed or nothing logged (fail-open — the coach just says nothing). */
  mobility: {
    weekMinutes: number
    targetMinutes: number
    regionsWorked: number
    coldRegions: string[]
  } | null
}

// ---------------------------------------------------------------------------
// In-process cache (~5 min)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000
let cached: { at: number; ctx: CoachContext } | null = null

/** Drop the cache (tests + after a mutating action that should force a rebuild). */
export function invalidateCoachContext(): void {
  cached = null
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the coach context. Cached ~5 min in-process. Every sub-read is wrapped
 * fail-open, so one dead signal degrades gracefully to null/[] rather than throwing.
 * `force` bypasses the cache (a fresh draft after a dislike write).
 */
export async function assembleCoachContext(force = false): Promise<CoachContext> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ctx

  const today = await failOpen(readToday, isoTodayFallback())

  const [catalog, goals, recentWorkouts, muscleState, injuries, dislikes, preferences, gym, readinessZone, mobility] =
    await Promise.all([
      failOpen(readCatalog, [] as CatalogExercise[]),
      failOpen(readGoals, [] as CoachGoal[]),
      failOpen(readRecentWorkouts, [] as CoachWorkoutSummary[]),
      failOpen(readMuscleState, [] as CoachMuscleState[]),
      failClosedInjuries(),
      failOpen(readDislikes, [] as CoachDislike[]),
      failOpen(readPreferences, [] as CoachPreference[]),
      failOpen(readDefaultGym, { id: null, name: null, equipment: null } as GymRead),
      failOpen(readReadinessZone, null as CoachContext['readinessZone']),
      failOpen(readMobilityBlock, null as CoachContext['mobility']),
    ])

  const pools = buildPools(catalog, gym.equipment, injuries)
  const staleness = stalenessStats(catalog, gym.equipment)
  const recentSplit = splitFromMuscleState(muscleState)

  const ctx: CoachContext = {
    today,
    goals,
    recentWorkouts,
    muscleState,
    injuries,
    dislikes,
    preferences,
    gymEquipment: gym.equipment,
    gymName: gym.name,
    gymId: gym.id,
    readinessZone,
    staleness,
    catalog,
    pools,
    recentSplit,
    mobility,
  }
  cached = { at: Date.now(), ctx }
  return ctx
}

/** Run a read, returning `fallback` on any throw (fail-open discipline). */
async function failOpen<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.warn(
      '[coach-context] sub-read failed (fail-open):',
      err instanceof Error ? err.message : String(err),
    )
    return fallback
  }
}

/** Safety state is fail-closed: an unreadable injury table blocks automatic picks. */
async function failClosedInjuries(): Promise<CoachInjury[]> {
  try {
    return await readInjuries()
  } catch (err) {
    console.error(
      '[coach-context] injury read failed (recommendations blocked):',
      err instanceof Error ? err.message : String(err),
    )
    return [{ region: 'other', severity: 'out', label: 'injury state unavailable' }]
  }
}

function isoTodayFallback(): string {
  return new Date().toISOString().slice(0, 10)
}

async function readToday(): Promise<string> {
  const { getAppTimezone, todayInZone } = await import('@/lib/today')
  const tz = await getAppTimezone()
  return todayInZone(tz)
}

// ---------------------------------------------------------------------------
// Sub-reads
// ---------------------------------------------------------------------------

interface CatalogRowRaw {
  id: string
  name: string
  primary_muscle: string | null
  secondary_muscles: unknown
  equipment: string | null
  force: string | null
  mechanic: string | null
  disliked_at: string | null
  preferred_at: string | null
  archived_at: string | null
  snoozed_until: string | null
  days_since_last: number | null
  recent_sets: number | null
  injury_profile: unknown
  injury_override: boolean | null
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Every exercise + its recency stats (days-since-last-performed, trailing-28d
 * working-set count), completed workouts only (§3b). This is the row novelty.ts
 * builds pools from. Excludes archived here (pool build re-checks defensively).
 * Exported for search_exercises' hidden-match diagnosis (poolExclusionReason).
 */
export async function readCatalog(): Promise<CatalogExercise[]> {
  // This SELECT names injury_override, added by the gym ensure. readCatalog is
  // reachable before any other gym surface has run (search_exercises' hidden-match
  // diagnosis, coach-context assembly), so on the first boot after a deploy the
  // column can legitimately not exist yet. The ensure is memoized by a
  // module-level promise, so this is a no-op every time after the first.
  await ensureGymSchema()
  const rows = (
    await db.execute(sql`
      SELECT e.id, e.name, e.primary_muscle, e.secondary_muscles, e.equipment,
        e.force, e.mechanic, e.disliked_at::text AS disliked_at,
        e.preferred_at::text AS preferred_at,
        e.archived_at::text AS archived_at, e.snoozed_until::text AS snoozed_until,
        e.injury_profile, e.injury_override, agg.days_since_last, COALESCE(agg.recent_sets, 0)::int AS recent_sets
      FROM exercises e
      LEFT JOIN (
        SELECT we.exercise_id,
          (
            CURRENT_DATE - (
              max(w.started_at) FILTER (
                WHERE ws.set_type <> 'warmup' AND ws.completed = true
              )
            )::date
          ) AS days_since_last,
          count(DISTINCT COALESCE(ws.logical_set_id, ws.client_set_id, ws.id)) FILTER (
            WHERE ws.set_type <> 'warmup'
              AND ws.completed = true
              AND w.started_at >= CURRENT_DATE - 28
          ) AS recent_sets
        FROM workout_exercises we
        JOIN workouts w ON we.workout_id = w.id AND w.status = 'completed'
        LEFT JOIN workout_sets ws ON ws.workout_exercise_id = we.id
        GROUP BY we.exercise_id
      ) agg ON agg.exercise_id = e.id
      WHERE e.archived_at IS NULL
        -- §10b: strength drafts never deal mobility work — a swap/draft slate
        -- must not offer "hamstring stretch" for a pull day. Mobility drafting
        -- (M4) reads its own stretch-modality pool.
        AND e.modality NOT IN ('stretch', 'dynamic', 'soft_tissue')
    `)
  ).rows as unknown as CatalogRowRaw[]

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    primaryMuscle: r.primary_muscle,
    secondaryMuscles: toStringArray(r.secondary_muscles),
    equipment: r.equipment,
    force: r.force,
    mechanic: r.mechanic,
    disliked: r.disliked_at != null,
    preferred: r.preferred_at != null,
    daysSinceLast: r.days_since_last == null ? null : Number(r.days_since_last),
    recentSets: r.recent_sets ?? 0,
    archived: r.archived_at != null,
    snoozedUntil: r.snoozed_until,
    injuryProfile: parseExerciseInjuryProfile(r.injury_profile),
    injuryOverride: r.injury_override === true,
  }))
}

/** Active goals + their exercise-link signals (best/target e1RM + trend). Only the
 *  exercise-linked ones carry live numbers; the rest are title/area context. */
async function readGoals(): Promise<CoachGoal[]> {
  const rows = (
    await db.execute(sql`
      SELECT g.id, g.title, g.area, g.fitness_intent,
        el.entity_id AS exercise_name, el.meta AS meta
      FROM goals g
      LEFT JOIN goal_links el
        ON el.goal_id = g.id AND el.entity_type = 'exercise'
      WHERE g.status = 'active'
      ORDER BY
        (g.fitness_intent IS NOT NULL) DESC,
        (el.entity_id IS NOT NULL) DESC,
        g.updated_at DESC NULLS LAST,
        g.created_at DESC NULLS LAST
      LIMIT 12
    `)
  ).rows as unknown as Array<{
    id: string
    title: string
    area: string | null
    fitness_intent: ProgrammingGoal | null
    exercise_name: string | null
    meta: unknown
  }>

  // Compute live e1RM for the exercise-linked goals (best + 28d trend) in one query.
  const names = [...new Set(rows.map((r) => r.exercise_name).filter((n): n is string => !!n))]
  const e1rms = names.length > 0 ? await exerciseE1rms(names) : new Map()

  return rows.map((r) => {
    const goal: CoachGoal = {
      title: r.title,
      area: r.area,
      fitnessIntent: r.fitness_intent,
    }
    if (r.exercise_name) {
      const e = e1rms.get(r.exercise_name)
      goal.exerciseName = r.exercise_name
      goal.current = e?.best ?? null
      goal.target = metaTargetLb(r.meta)
      goal.trend = e ? trendOf(e.recent, e.prior) : null
    }
    return goal
  })
}

/** Goal targets are stored with their entered unit; the planner's calculation
 * model is canonical lb, so normalize before comparing/rendering its context. */
export function metaTargetLb(meta: unknown): number | null {
  if (!meta || typeof meta !== 'object') return null
  const record = meta as Record<string, unknown>
  const value = record.target_value
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const unit = isWeightUnit(record.unit) ? record.unit : 'lb'
  return convertWeight(value, unit, 'lb', 1)
}

function trendOf(recent: number | null, prior: number | null): 'up' | 'down' | 'flat' | null {
  if (recent == null || prior == null || prior === 0) return null
  const pct = ((recent - prior) / Math.abs(prior)) * 100
  return Math.abs(pct) < 2 ? 'flat' : pct > 0 ? 'up' : 'down'
}

interface RecentSetRow {
  workout_id: string
  date: string
  workout_name: string | null
  exercise_name: string
  weight: number | null
  unit: string | null
  reps: number | null
  logical_set_id: string | null
}

/**
 * Last 10 completed workouts, compressed to one line per exercise: the last
 * working sets summarized ("3×8@170lb") + an e1RM 28d trend direction. Grouped in
 * JS from a flat set read (newest first, capped at 10 sessions).
 */
async function readRecentWorkouts(): Promise<CoachWorkoutSummary[]> {
  const rows = (
    await db.execute(sql`
      SELECT w.id AS workout_id, w.started_at::date::text AS date, w.name AS workout_name,
        e.name AS exercise_name, ws.weight::float8 AS weight, ws.weight_unit AS unit, ws.reps,
        ws.logical_set_id::text AS logical_set_id
      FROM workouts w
      JOIN workout_exercises we ON we.workout_id = w.id
      JOIN exercises e ON e.id = we.exercise_id
      JOIN workout_sets ws ON ws.workout_exercise_id = we.id
      WHERE w.status = 'completed'
        AND ws.set_type <> 'warmup'
        AND ws.completed = true
        AND w.id IN (
          SELECT id FROM workouts WHERE status = 'completed' ORDER BY started_at DESC LIMIT 10
        )
      ORDER BY w.started_at DESC, we.position ASC, ws.set_number ASC
    `)
  ).rows as unknown as RecentSetRow[]

  // Group → workout → exercise → sets.
  const order: string[] = []
  const byWorkout = new Map<string, { date: string; name: string | null; ex: Map<string, RecentSetRow[]> }>()
  const exNames = new Set<string>()
  for (const r of rows) {
    let w = byWorkout.get(r.workout_id)
    if (!w) {
      w = { date: r.date, name: r.workout_name, ex: new Map() }
      byWorkout.set(r.workout_id, w)
      order.push(r.workout_id)
    }
    const arr = w.ex.get(r.exercise_name) ?? []
    arr.push(r)
    w.ex.set(r.exercise_name, arr)
    exNames.add(r.exercise_name)
  }

  const trends = exNames.size > 0 ? await exerciseE1rms([...exNames]) : new Map()

  return order.map((id) => {
    const w = byWorkout.get(id)!
    const exercises: CoachExerciseSummary[] = []
    for (const [name, sets] of w.ex) {
      const e = trends.get(name)
      exercises.push({
        name,
        lastSets: summarizeSets(sets),
        e1rmTrend: e ? trendOf(e.recent, e.prior) : null,
      })
    }
    return { date: w.date, name: w.name, exercises }
  })
}

/** Compress a group of working sets into "N×reps@weight" form. When reps/weight
 *  vary it uses the modal reps + top weight ("4×8@185lb"); rep-only tracks drop the
 *  weight ("3×12"). */
function summarizeSets(sets: RecentSetRow[]): string {
  const n = new Set(
    sets.map((set, index) => logicalSetKey(set.logical_set_id, index)),
  ).size
  const reps = sets.map((s) => s.reps).filter((r): r is number => r != null && r > 0)
  const weightsLb = sets
    .map((set) => {
      if (set.weight == null || !Number.isFinite(set.weight) || set.weight <= 0) return null
      const storedUnit = isWeightUnit(set.unit) ? set.unit : 'lb'
      return convertWeight(set.weight, storedUnit, 'lb', 4)
    })
    .filter((weight): weight is number => weight != null)
  const modalRep = reps.length > 0 ? modal(reps) : null
  const topWeightLb = weightsLb.length > 0 ? Math.max(...weightsLb) : null
  if (topWeightLb != null && modalRep != null) {
    return `${n}×${modalRep}@${trim(topWeightLb)}lb`
  }
  if (modalRep != null) return `${n}×${modalRep}`
  return `${n} sets`
}

function modal(xs: number[]): number {
  const counts = new Map<number, number>()
  let best = xs[0]!
  let bestN = 0
  for (const x of xs) {
    const c = (counts.get(x) ?? 0) + 1
    counts.set(x, c)
    if (c > bestN) {
      best = x
      bestN = c
    }
  }
  return best
}

/** Muscle state via the shared /api/health/muscle-map path — never re-query. */
async function readMuscleState(): Promise<CoachMuscleState[]> {
  const map = await buildMuscleMap()
  return Object.values(map.regions).map((r) => ({
    region: r.region,
    state: r.state,
    daysSince: r.daysSince,
    weeklySets: r.weeklySets,
  }))
}

/** Active (unresolved/future-resolved) injuries; region validated as InjurySite. */
async function readInjuries(): Promise<CoachInjury[]> {
  const rows = (
    await db.execute(sql`
      SELECT region, severity, label
      FROM injuries
      -- Active = unresolved OR resolved in the FUTURE: the "Tweaked" reason chip
      -- writes an auto-expiring soft flag as resolved_at = now()+7d (see
      -- injuries-gyms.ts resolvedActivePredicate) — it must reach the coach gate
      -- until it expires.
      WHERE resolved_at IS NULL OR resolved_at > now()
      ORDER BY created_at DESC
    `)
  ).rows as unknown as Array<{ region: string; severity: string | null; label: string | null }>
  return rows
    .filter((r) => isInjurySite(r.region))
    .map((r) => ({
      region: r.region as InjurySite,
      severity: (r.severity ?? 'nagging') as CoachInjury['severity'],
      label: r.label,
    }))
}

/** §10b.8 mobility block: weekly hold minutes + trained-but-unstretched regions.
 *  The mobility ledger is not part of this repo, so the field is always null and
 *  every reader is written to treat that as "nothing logged". */
async function readMobilityBlock(): Promise<CoachContext['mobility']> {
  return null
}

/** Disliked exercises (disliked_at IS NOT NULL): name + reason. */
async function readDislikes(): Promise<CoachDislike[]> {
  const rows = (
    await db.execute(sql`
      SELECT name, dislike_reason
      FROM exercises
      WHERE disliked_at IS NOT NULL AND archived_at IS NULL
      ORDER BY disliked_at DESC
    `)
  ).rows as unknown as Array<{ name: string; dislike_reason: string | null }>
  return rows.map((r) => ({ name: r.name, reason: r.dislike_reason }))
}

/** Preferred exercises (preferred_at IS NOT NULL — the "Preferred it" replace-
 *  reason chip, #1876): biases drafting toward what the user actually picks over the
 *  deterministic suggestions. */
async function readPreferences(): Promise<CoachPreference[]> {
  const rows = (
    await db.execute(sql`
      SELECT name
      FROM exercises
      WHERE preferred_at IS NOT NULL AND archived_at IS NULL
      ORDER BY preferred_at DESC
    `)
  ).rows as unknown as Array<{ name: string }>
  return rows.map((r) => ({ name: r.name }))
}

interface GymRead {
  id: string | null
  name: string | null
  equipment: string[] | GymEquipment | null
}
/** The default gym + its equipment jsonb (null when no default gym set). */
async function readDefaultGym(): Promise<GymRead> {
  const [row] = (
    await db.execute(sql`
      SELECT id, name, equipment FROM gyms WHERE is_default = true
      ORDER BY created_at DESC LIMIT 1
    `)
  ).rows as unknown as Array<{ id: string; name: string; equipment: unknown }>
  if (!row) return { id: null, name: null, equipment: null }
  return { id: row.id, name: row.name, equipment: normalizeEquipment(row.equipment) }
}

/** Coerce the equipment jsonb into a string[] (null when absent/empty). */
function normalizeEquipment(v: unknown): string[] | GymEquipment | null {
  if (Array.isArray(v)) {
    const arr = toStringArray(v)
    return arr.length > 0 ? arr : null
  }
  if (!v || typeof v !== 'object') return null
  const row = v as Record<string, unknown>
  const equipment: GymEquipment = {
    categories: toStringArray(row.categories),
    machines: toStringArray(row.machines),
    machines_excluded: toStringArray(row.machines_excluded),
  }
  return gymEquipmentTokens(equipment) || gymExcludedNames(equipment).length > 0
    ? equipment
    : null
}

/** Today's readiness zone word (fail-open null). Reuses the composite. */
async function readReadinessZone(): Promise<CoachContext['readinessZone']> {
  const r = await computeReadiness()
  return r.zone
}

// ---------------------------------------------------------------------------
// Derived stats
// ---------------------------------------------------------------------------

/** Staleness stats over the eligible (non-disliked, in-gym, non-archived) catalog. */
function stalenessStats(
  catalog: CatalogExercise[],
  gymEquipment: string[] | GymEquipment | null,
): StalenessStats {
  const tokens = gymEquipmentTokens(gymEquipment)
  const excluded = gymExcludedNames(gymEquipment)
  const eligible = catalog.filter(
    (e) =>
      !e.archived &&
      !e.disliked &&
      !isSnoozed(e.snoozedUntil) &&
      gymCompatible(e, tokens, excluded),
  )
  const scored = eligible
    .map((e) => ({ name: e.name, score: stalenessScore(e) }))
    .sort((a, b) => b.score - a.score)
  const stalest = scored.slice(0, 8).map((s) => s.name)
  const freshest = scored.slice(-8).reverse().map((s) => s.name)
  return { poolSize: eligible.length, stalest, freshest }
}

/**
 * Derive the "recent split" anchor from muscle state: each region's weekly working
 * sets from the muscle-map (already completed-only, secondary=0.5 weighted). This
 * is what the volume-conservation gate measures a draft against.
 */
function splitFromMuscleState(states: CoachMuscleState[]): Map<MuscleRegion, number> {
  const out = new Map<MuscleRegion, number>()
  for (const s of states) {
    if (s.weeklySets > 0) out.set(s.region, s.weeklySets)
  }
  return out
}

function trim(n: number): number {
  return Math.round(n * 100) / 100
}
