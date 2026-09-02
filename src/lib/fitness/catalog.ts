/**
 * Exercise-catalog read/write for the /health "add & track exercises" surface.
 * Search the catalog (vendored free-exercise-db + every name the user's Strong history
 * created), add a catalog exercise to the TRACKED set, or create a brand-new
 * custom exercise. Read paths are pure-ish (DB only); writes are idempotent.
 *
 * WHAT "TRACKED" MEANS (data model): an exercise carries a nullable `tracked_at`.
 * An exercise is "tracked" when `tracked_at IS NOT NULL` OR it already has logged
 * sets (history = implicitly tracked). Tracking is an explicit "keep this on my
 * radar" flag — it surfaces the exercise on /health (its muscle map credit, PR,
 * and volume) even before Strong has logged a single set of it, which is the gap
 * The user hit: exercises he wants to watch that aren't in his history yet. It does NOT
 * change logging (that stays in Strong) — it's a curation flag over the catalog.
 */
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { ensureExerciseTrackingColumn, ensureFitnessTables, ensureGymSchema } from '@/lib/db/ensure-fitness'
import { catalogMuscleToRegion, REGION_LABELS, isMuscleRegion } from './muscles'
import { normalizeExerciseName, normalizedNameSql } from './exercise-name'
import { displayExerciseName } from '@/lib/gym/display-name'

export interface CatalogExercise {
  id: string
  name: string
  category: string | null
  primaryMuscle: string | null
  /** Our figure region the primary muscle maps to (for a friendly label), if any. */
  region: string | null
  regionLabel: string | null
  /** Programming axis (GYM_PLAN §10b.1): strength | stretch | dynamic |
   *  soft_tissue | cardio. */
  modality: string
  /** Unilateral mobility work the logger pairs as L/R (M3). */
  perSide: boolean
  isCustom: boolean
  tracked: boolean
  /** Logged working sets all-time (0 if never done). */
  sets: number
  lastPerformed: string | null
}

// Allowed `tracks` values (custom-create coerces anything else to 'weight_reps').
// Must stay in lockstep with the catalog.test.ts allow-list (§3a). weighted_
// bodyweight = added weight + reps; assisted_bodyweight = assistance (stored
// positive) + reps.
const TRACKS = new Set([
  'weight_reps',
  'weighted_bodyweight',
  'assisted_bodyweight',
  'reps',
  'time',
  'distance_time',
])

// Allowed `modality` values (GYM_PLAN §10b.1; custom-create coerces anything
// else to 'strength'). Must stay in lockstep with the catalog.test.ts allow-list
// — same contract as TRACKS above.
export const MODALITIES = new Set([
  'strength',
  'stretch',
  'dynamic',
  'soft_tissue',
  'cardio',
])

interface RawRow {
  id: string
  name: string
  category: string | null
  primary_muscle: string | null
  modality: string
  per_side: boolean
  is_custom: boolean
  tracked_at: string | null
  sets: number
  last_performed: string | null
}

function toExercise(r: RawRow): CatalogExercise {
  const region = catalogMuscleToRegion(r.primary_muscle)
  return {
    id: r.id,
    name: displayExerciseName(r.name),
    category: r.category,
    primaryMuscle: r.primary_muscle,
    region,
    regionLabel: region ? REGION_LABELS[region] : null,
    modality: r.modality,
    perSide: r.per_side,
    isCustom: r.is_custom,
    tracked: r.tracked_at != null || r.sets > 0,
    sets: r.sets,
    lastPerformed: r.last_performed,
  }
}

/**
 * Search the catalog by name (case-insensitive substring). Ranks exact/prefix
 * matches first, then his own history + custom entries, then the rest. Excludes
 * archived. Caps results so the picker stays snappy over ~1000 rows.
 */
export async function searchExercises(query: string, limit = 30): Promise<CatalogExercise[]> {
  await ensureFitnessTables()
  await ensureExerciseTrackingColumn()
  await ensureGymSchema() // modality/per_side ride the gym lane
  const q = query.trim().toLowerCase()
  const like = `%${q}%`
  const prefix = `${q}%`

  const rows = (
    await db.execute(sql`
      SELECT e.id, e.name, e.category, e.primary_muscle, e.modality, e.per_side, e.is_custom, e.tracked_at::text AS tracked_at,
        coalesce(cnt.sets, 0)::int AS sets,
        cnt.last_performed::text AS last_performed
      FROM exercises e
      LEFT JOIN (
        SELECT we.exercise_id,
          count(DISTINCT COALESCE(ws.logical_set_id, ws.client_set_id, ws.id))
            FILTER (WHERE ws.set_type <> 'warmup' AND ws.completed = true) AS sets,
          max(w.started_at)::date AS last_performed
        FROM workout_exercises we
        JOIN workouts w ON we.workout_id = w.id AND w.status = 'completed'
        LEFT JOIN workout_sets ws ON ws.workout_exercise_id = we.id
        GROUP BY we.exercise_id
      ) cnt ON cnt.exercise_id = e.id
      WHERE e.archived_at IS NULL
        AND (${q} = '' OR lower(e.name) LIKE ${like})
      ORDER BY
        (lower(e.name) = ${q}) DESC,
        (lower(e.name) LIKE ${prefix}) DESC,
        (coalesce(cnt.sets, 0) > 0) DESC,
        e.is_custom DESC,
        e.name ASC
      LIMIT ${limit}
    `)
  ).rows as unknown as RawRow[]
  return rows.map(toExercise)
}

/** The exercises the user is actively tracking (explicit flag OR has history), for the
 *  /health "Tracked exercises" list. Most-recently-performed first. */
export async function listTrackedExercises(limit = 60): Promise<CatalogExercise[]> {
  await ensureFitnessTables()
  await ensureExerciseTrackingColumn()
  await ensureGymSchema() // modality/per_side ride the gym lane
  const rows = (
    await db.execute(sql`
      SELECT e.id, e.name, e.category, e.primary_muscle, e.modality, e.per_side, e.is_custom, e.tracked_at::text AS tracked_at,
        coalesce(cnt.sets, 0)::int AS sets,
        cnt.last_performed::text AS last_performed
      FROM exercises e
      LEFT JOIN (
        SELECT we.exercise_id,
          count(DISTINCT COALESCE(ws.logical_set_id, ws.client_set_id, ws.id))
            FILTER (WHERE ws.set_type <> 'warmup' AND ws.completed = true) AS sets,
          max(w.started_at)::date AS last_performed
        FROM workout_exercises we
        JOIN workouts w ON we.workout_id = w.id AND w.status = 'completed'
        LEFT JOIN workout_sets ws ON ws.workout_exercise_id = we.id
        GROUP BY we.exercise_id
      ) cnt ON cnt.exercise_id = e.id
      WHERE e.archived_at IS NULL
        AND (e.tracked_at IS NOT NULL OR coalesce(cnt.sets, 0) > 0)
      ORDER BY cnt.last_performed DESC NULLS LAST, e.tracked_at DESC NULLS LAST, e.name ASC
      LIMIT ${limit}
    `)
  ).rows as unknown as RawRow[]
  return rows.map(toExercise)
}

/** Mark/unmark an exercise as explicitly tracked (idempotent). */
export async function setTracked(exerciseId: string, tracked: boolean): Promise<void> {
  await ensureFitnessTables()
  await ensureExerciseTrackingColumn()
  await db.execute(sql`
    UPDATE exercises SET tracked_at = ${tracked ? new Date() : null} WHERE id = ${exerciseId}
  `)
}

export interface CreateExerciseInput {
  name: string
  category?: string | null
  primaryMuscle?: string | null
  tracks?: string
  modality?: string
  perSide?: boolean
  /** How to perform it, one step per element. A custom row has no FEDB entry
   *  and usually no image either, so without these the detail sheet shows a
   *  name and nothing else — which is no use at the rack. */
  instructions?: string[] | null
}

export interface CreateExerciseResult {
  exercise: CatalogExercise
  /** false when the name already existed (we returned the existing row). */
  created: boolean
  /**
   * True when the name matched an ARCHIVED row, which this call un-archived.
   *
   * Archived is what made `created:false` a lie: every lookup filters
   * `archived_at IS NULL`, so the row handed back was one nothing else could
   * see. Asking to create a movement is an explicit statement that it should
   * exist, so the archive is lifted rather than reporting a phantom.
   */
  restored: boolean
}

/**
 * Create a custom exercise (name + optional primary muscle/category). Name is
 * UNIQUE, so an existing name returns that row (created:false) instead of erroring
 * — the "type a name that already exists" path just tracks it. A newly created
 * custom exercise is auto-tracked.
 */
export async function createCustomExercise(input: CreateExerciseInput): Promise<CreateExerciseResult> {
  await ensureFitnessTables()
  await ensureExerciseTrackingColumn()
  await ensureGymSchema()
  // Issue #1873: normalize casing at write time so custom exercises don't
  // add to the pile of inconsistently-cased rows a future backfill has to fix.
  const name = displayExerciseName(input.name.trim())
  if (!name) throw new Error('name required')
  const tracks = input.tracks && TRACKS.has(input.tracks) ? input.tracks : 'weight_reps'
  const modality = input.modality && MODALITIES.has(input.modality) ? input.modality : 'strength'
  // Accept either our region ids or the catalog vocabulary for primary muscle;
  // store as-given (the mapper reads catalog vocab, and region ids pass through
  // isMuscleRegion). Empty → null.
  const primaryMuscle = input.primaryMuscle?.trim() || null

  // Look first, under the SHARED normalization and WITHOUT the archived
  // filter — the unique index is case-sensitive, so relying on the insert to
  // detect the collision both misses "bodyweight squat" vs "Bodyweight Squat"
  // and cannot tell an archived row from an absent one.
  const [existing] = (
    await db.execute(sql`
      SELECT id, archived_at IS NOT NULL AS "isArchived"
        FROM exercises
       WHERE ${normalizedNameSql('name')} = ${normalizeExerciseName(name)}
       ORDER BY archived_at NULLS FIRST
       LIMIT 1
    `)
  ).rows as unknown as Array<{ id: string; isArchived: boolean }>

  if (existing) {
    await db.execute(sql`
      UPDATE exercises
         SET archived_at = NULL,
             tracked_at = COALESCE(tracked_at, now())
       WHERE id = ${existing.id}
    `)
    const [restoredRow] = (
      await db.execute(sql`
        SELECT e.id, e.name, e.category, e.primary_muscle, e.modality, e.per_side, e.is_custom,
          e.tracked_at::text AS tracked_at, 0::int AS sets, NULL::text AS last_performed
        FROM exercises e WHERE e.id = ${existing.id} LIMIT 1
      `)
    ).rows as unknown as RawRow[]
    return {
      exercise: toExercise(restoredRow!),
      created: false,
      restored: existing.isArchived,
    }
  }

  const instructions =
    input.instructions && input.instructions.length > 0
      ? input.instructions.map((step) => step.trim()).filter(Boolean)
      : null
  const inserted = (
    await db.execute(sql`
      INSERT INTO exercises (name, category, primary_muscle, tracks, modality, per_side, instructions, is_custom, tracked_at)
      VALUES (
        ${name}, ${input.category?.trim() || null}, ${primaryMuscle}, ${tracks}, ${modality},
        ${input.perSide === true}, ${instructions ? JSON.stringify(instructions) : null}::jsonb, true, now()
      )
      ON CONFLICT (name) DO NOTHING
      RETURNING id
    `)
  ).rows as unknown as Array<{ id: string }>

  // A concurrent writer can still win the race between the SELECT above and
  // this INSERT; the conflict guard stays for exactly that case.
  const created = inserted.length > 0
  if (!created) {
    await db.execute(sql`
      UPDATE exercises SET tracked_at = now() WHERE name = ${name} AND tracked_at IS NULL
    `)
  }

  const [row] = (
    await db.execute(sql`
      SELECT e.id, e.name, e.category, e.primary_muscle, e.modality, e.per_side, e.is_custom, e.tracked_at::text AS tracked_at,
        0::int AS sets, NULL::text AS last_performed
      FROM exercises e WHERE e.name = ${name} LIMIT 1
    `)
  ).rows as unknown as RawRow[]
  return { exercise: toExercise(row!), created, restored: false }
}

/** Distinct primary-muscle options for the custom-exercise form (region ids +
 *  labels), so the picker offers the same vocabulary the figure paints. */
export function muscleOptions(): { value: string; label: string }[] {
  return (Object.keys(REGION_LABELS) as (keyof typeof REGION_LABELS)[])
    .filter((r) => isMuscleRegion(r))
    .map((r) => ({ value: r, label: REGION_LABELS[r] }))
}
