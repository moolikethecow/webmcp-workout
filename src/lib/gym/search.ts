/**
 * Exercises-tab list query (GET /api/gym/exercises). The SQL applies q / equipment /
 * filter and the per-row aggregates (all-time set count, last-performed); the MUSCLE
 * filter and region computation run in JS over `musclesForExerciseEnriched`, because
 * region resolution is a keyword mapper, not a column.
 *
 * Pure helpers (token parsing, the muscle-match predicate, the ordering comparator)
 * are exported and unit-tested with no DB; `queryExercises` is the thin DB wrapper.
 *
 * §3b filter sweep discipline: set-count + last-performed aggregates count only
 * `status='completed'` workouts, so an active session never inflates counts here.
 */
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { displayExerciseName } from './display-name'
import { equipmentClass, EQUIPMENT_TOKENS } from './novelty'
import {
  isMuscleRegion,
  musclesForExerciseEnriched,
  REGION_LABELS,
  type MuscleHit,
  type MuscleRegion,
} from '@/lib/fitness/muscles'

export type ExerciseFilter = 'custom' | 'disliked' | 'tracked'

export interface ExerciseListParams {
  q?: string
  muscle?: string
  equipment?: string
  filter?: ExerciseFilter
  limit?: number
  offset?: number
}

/** A region credit on a list row, for the muscle chips. */
export interface RegionCredit {
  region: MuscleRegion
  label: string
  weight: number
}

export interface ExerciseListItem {
  id: string
  name: string
  category: string | null
  equipment: string | null
  primaryMuscle: string | null
  secondaryMuscles: string[]
  regions: RegionCredit[]
  tracks: string
  /** Programming axis (GYM_PLAN §10b.1): strength | stretch | dynamic |
   *  soft_tissue | cardio. */
  modality: string
  /** Unilateral mobility work the logger pairs as L/R (M3). */
  perSide: boolean
  isCustom: boolean
  aiFilled: boolean
  tracked: boolean
  disliked: boolean
  sets: number
  lastPerformed: string | null
  hasImages: boolean
  slug: string | null
  /** Exact proxy-relative image path from the row (GIF or legacy JPG). */
  imagePath: string | null
}

export interface ExerciseListResult {
  exercises: ExerciseListItem[]
  total: number
}

/** Raw row shape the list SQL returns (before muscle post-filter + region compute). */
interface RawListRow {
  id: string
  name: string
  category: string | null
  equipment: string | null
  primary_muscle: string | null
  secondary_muscles: unknown
  tracks: string
  modality: string
  per_side: boolean
  is_custom: boolean
  ai_filled: boolean
  tracked_at: string | null
  disliked_at: string | null
  catalog_slug: string | null
  image_path: string | null
  image_count: number
  sets: number
  last_performed: string | null
}

const DEFAULT_LIMIT = 50

/** Split a search query into lowercased tokens for token-AND matching (no deps). */
export function queryTokens(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** A token's acceptable forms: itself plus naive singulars ("pushdowns" →
 *  "pushdown", "presses" → "press"). Catalog names are singular; queries often
 *  aren't — without this, "tricep pushdowns" matches NOTHING. */
export function tokenForms(t: string): string[] {
  const forms = [t]
  if (t.length > 4 && t.endsWith('es')) forms.push(t.slice(0, -2))
  if (t.length > 3 && t.endsWith('s')) forms.push(t.slice(0, -1))
  return forms
}

/** The loosest form (for coarse SQL prefilters — JS re-checks strictly). */
export function tokenStem(t: string): string {
  const forms = tokenForms(t)
  return forms.reduce((a, b) => (b.length < a.length ? b : a))
}

/** True when every token (or a singular form of it) appears somewhere in the
 *  haystack (case-insensitive). An empty token list matches everything. */
export function nameMatchesTokens(name: string, tokens: string[]): boolean {
  const n = name.toLowerCase()
  return tokens.every((t) => tokenForms(t).some((form) => n.includes(form)))
}

/** Coerce a jsonb secondary_muscles value into a string[]. */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return []
}

/** The region credits for a row (via the enriched muscle mapper), as chips. */
export function regionsForRow(
  name: string,
  primaryMuscle: string | null,
  secondaryMuscles: string[],
): RegionCredit[] {
  const hits: MuscleHit[] = musclesForExerciseEnriched(name, primaryMuscle, secondaryMuscles)
  return hits.map((h) => ({
    region: h.region,
    label: REGION_LABELS[h.region],
    weight: h.weight,
  }))
}

/** Does this row train `muscleRegion`? (any credit, primary or secondary). */
export function rowMatchesMuscle(regions: RegionCredit[], muscleRegion: MuscleRegion): boolean {
  return regions.some((r) => r.region === muscleRegion)
}

/**
 * Ordering comparator: tracked/has-history rows first, then name A→Z. `hasHistory`
 * = has logged sets; `tracked` = explicit flag OR history (mirrors catalog). Pure +
 * stable; exported for tests.
 */
export function compareListItems(a: ExerciseListItem, b: ExerciseListItem): number {
  const aFirst = a.tracked || a.sets > 0 ? 0 : 1
  const bFirst = b.tracked || b.sets > 0 ? 0 : 1
  if (aFirst !== bFirst) return aFirst - bFirst
  return a.name.localeCompare(b.name)
}

function toListItem(r: RawListRow): ExerciseListItem {
  const secondaryMuscles = toStringArray(r.secondary_muscles)
  const regions = regionsForRow(r.name, r.primary_muscle, secondaryMuscles)
  const hasHistory = r.sets > 0
  return {
    id: r.id,
    name: displayExerciseName(r.name),
    category: r.category,
    equipment: r.equipment,
    primaryMuscle: r.primary_muscle,
    secondaryMuscles,
    regions,
    tracks: r.tracks,
    modality: r.modality,
    perSide: r.per_side,
    isCustom: r.is_custom,
    aiFilled: r.ai_filled,
    tracked: r.tracked_at != null || hasHistory,
    disliked: r.disliked_at != null,
    sets: r.sets,
    lastPerformed: r.last_performed,
    // Images available when the row carries them OR a catalog_slug resolves them.
    hasImages: r.image_count > 0 || !!r.catalog_slug,
    slug: r.catalog_slug,
    imagePath: r.image_path,
  }
}

/**
 * List exercises for the Exercises tab. q/equipment/filter + aggregates run in SQL;
 * the muscle filter runs in JS (region mapper). `total` is the count AFTER all
 * filters but BEFORE pagination, so the UI can page. Excludes archived rows.
 */
export async function queryExercises(params: ExerciseListParams): Promise<ExerciseListResult> {
  const limit = params.limit && params.limit > 0 ? Math.min(params.limit, 200) : DEFAULT_LIMIT
  const offset = params.offset && params.offset > 0 ? params.offset : 0
  const q = (params.q ?? '').trim()
  const tokens = queryTokens(q)
  const equipment = (params.equipment ?? '').trim().toLowerCase()

  const muscle =
    params.muscle && isMuscleRegion(params.muscle) ? (params.muscle as MuscleRegion) : null

  // Build the WHERE fragments. q uses a coarse ILIKE prefilter in SQL (any token),
  // then token-AND is enforced exactly in JS (handles multi-token AND without a
  // combinatorial SQL clause). filter/equipment are exact SQL predicates.
  const conds = [sql`e.archived_at IS NULL`]
  if (tokens.length > 0) {
    // OR of per-token ILIKEs narrows the scan; JS does the strict AND after.
    // Stemmed forms + muscle/equipment columns so "tricep pushdowns rope" can
    // reach rows like "cable pushdown (with rope attachment)" (primary_muscle
    // supplies the "tricep", the singular stem supplies the "pushdown").
    const likes = tokens.flatMap((t) => {
      const stem = '%' + tokenStem(t) + '%'
      return [
        sql`lower(e.name) LIKE ${stem}`,
        sql`lower(e.primary_muscle) LIKE ${stem}`,
        sql`lower(e.equipment) LIKE ${stem}`,
      ]
    })
    conds.push(sql`(${sql.join(likes, sql` OR `)})`)
  }
  if (equipment) {
    // Match on CLASS, not on the literal string. The dropdown speaks the
    // My-Gyms vocabulary ("body only") and the catalog speaks the dataset it
    // was generated from ("body weight"), so exact equality returned ZERO rows
    // for 8 of the 12 options — including every one of the 324 bodyweight
    // movements. Expanding to the sibling tokens keeps this a plain indexed
    // IN-list rather than pushing the mapping into SQL.
    const wanted = equipmentClass(equipment)
    const tokens = EQUIPMENT_TOKENS.filter((t) => equipmentClass(t) === wanted)
    conds.push(
      tokens.length > 0
        ? sql`lower(e.equipment) IN (${sql.join(tokens.map((t) => sql`${t}`), sql`, `)})`
        : sql`lower(e.equipment) = ${equipment}`,
    )
  }
  if (params.filter === 'custom') conds.push(sql`e.is_custom = true`)
  else if (params.filter === 'disliked') conds.push(sql`e.disliked_at IS NOT NULL`)
  else if (params.filter === 'tracked') {
    conds.push(sql`(e.tracked_at IS NOT NULL OR cnt.sets > 0)`)
  }
  const where = sql.join(conds, sql` AND `)

  // Aggregates: all-time working-set count + last-performed, COMPLETED workouts
  // only (§3b — an active session must not inflate these).
  const rows = (
    await db.execute(sql`
      SELECT e.id, e.name, e.category, e.equipment, e.primary_muscle,
        e.secondary_muscles, e.tracks, e.modality, e.per_side, e.is_custom, e.ai_filled,
        e.tracked_at::text AS tracked_at, e.disliked_at::text AS disliked_at,
        e.catalog_slug,
        CASE WHEN jsonb_typeof(e.images) = 'array' THEN e.images ->> 0 ELSE NULL END AS image_path,
        COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(e.images) = 'array' THEN e.images ELSE '[]'::jsonb END), 0)::int AS image_count,
        COALESCE(cnt.sets, 0)::int AS sets,
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
      WHERE ${where}
    `)
  ).rows as unknown as RawListRow[]

  // JS pass: strict token-AND on name + muscle + equipment, muscle filter, map.
  let items = rows
    .filter((r) =>
      nameMatchesTokens(`${r.name} ${r.primary_muscle ?? ''} ${r.equipment ?? ''}`, tokens),
    )
    .map(toListItem)
  if (muscle) items = items.filter((it) => rowMatchesMuscle(it.regions, muscle))

  items.sort(compareListItems)
  const total = items.length
  const page = items.slice(offset, offset + limit)
  return { exercises: page, total }
}
