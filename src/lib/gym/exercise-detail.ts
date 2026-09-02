/**
 * Exercise detail read model (GET /api/gym/exercises/[id]). Loads the exercise row,
 * its records/history/charts from the logged sets, and resolves image paths. The
 * PR/chart MATH lives in records.ts (pure, tested); this file is the DB glue.
 *
 * §3b filter sweep: every set query joins `w.status = 'completed'` so a live session
 * never appears in records/history/charts.
 */
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { MODALITIES } from '@/lib/fitness/catalog'
import { createCustomExercise } from '@/lib/fitness/catalog'
import { fillExerciseMetadata } from '@/lib/fitness/llm-fill'
import {
  convertStoredWeight,
  convertWeight,
  type WeightUnit,
} from '@/lib/units/weight'
import type { DistanceUnit } from '@/lib/units/system'
import { displayExerciseName } from './display-name'
import {
  computeCharts,
  computeRecords,
  computeRecordsByGrip,
  type Charts,
  type GripRecords,
  type Records,
  type SetInput,
  type Tracks,
} from './records'
import { regionsForRow, type RegionCredit } from './search'
import { normalizeExerciseName, normalizedNameSql } from '@/lib/fitness/exercise-name'
import { resolveGrip, toGripSpec } from './grip'

/** Max sessions returned in the history block. */
const HISTORY_LIMIT = 20

export interface DetailExercise {
  id: string
  name: string
  category: string | null
  equipment: string | null
  primaryMuscle: string | null
  secondaryMuscles: string[]
  regions: RegionCredit[]
  tracks: string
  /** How entered weight should be interpreted for strength math and display. */
  loadBasis: 'total' | 'per_side'
  /** Whether the logger deals this exercise as L/R rows. Distinct from
   *  `loadBasis`, which is about how an entered WEIGHT is read (per hand vs
   *  total) — this is about whether each set is performed one side at a time. */
  perSide: boolean
  isCustom: boolean
  aiFilled: boolean
  tracked: boolean
  disliked: boolean
  sets: number
  lastPerformed: string | null
  hasImages: boolean
  slug: string | null
  imagePath: string | null
  instructions: string[]
  /** Proxy-relative FEDB paths, e.g. "Incline_Dumbbell_Press/0.jpg". */
  images: string[]
  defaultRestSeconds: number | null
  restSecondsWarmup: number | null
  preferredUnit: string | null
  dislikeReason: string | null
}

export interface HistorySet {
  setNumber: number
  setType: string
  weight: number | null
  unit: string
  reps: number | null
  distanceM: number | null
  durationS: number | null
  rpe: number | null
  side: 'left' | 'right' | null
  logicalSetId: string
}
export interface HistorySession {
  workoutId: string
  date: string
  workoutName: string | null
  sets: HistorySet[]
}

type DisplayWeightRecord = Omit<NonNullable<Records['bestWeight']>, 'unit'> & {
  unit: WeightUnit
}
type DisplayE1rmRecord = Omit<NonNullable<Records['bestE1rm']>, 'unit'> & {
  unit: WeightUnit
}
type DisplayVolumeRecord = Omit<NonNullable<Records['bestSetVolume']>, 'unit'> & {
  unit: WeightUnit
}
type DisplayRepMaxEntry = Omit<Records['repMaxes'][number], 'unit'> & {
  unit: WeightUnit
}

/** Records are computed canonically in pounds, then widened only at this API's
 * display boundary. The pure PR selection/math in records.ts stays unchanged. */
export interface DisplayRecords
  extends Omit<Records, 'bestWeight' | 'bestE1rm' | 'bestSetVolume' | 'repMaxes'> {
  bestWeight: DisplayWeightRecord | null
  bestE1rm: DisplayE1rmRecord | null
  bestSetVolume: DisplayVolumeRecord | null
  repMaxes: DisplayRepMaxEntry[]
}

export interface ExerciseDetail {
  exercise: DetailExercise
  /** Unit used for every weight-valued field in records, history, and charts. */
  weightUnit: WeightUnit
  distanceUnit: DistanceUnit
  records: DisplayRecords
  history: HistorySession[]
  charts: Charts
}

interface ExerciseRowRaw {
  id: string
  name: string
  category: string | null
  equipment: string | null
  primary_muscle: string | null
  secondary_muscles: unknown
  tracks: string
  load_basis: string
  per_side: boolean
  is_custom: boolean
  ai_filled: boolean
  tracked_at: string | null
  disliked_at: string | null
  dislike_reason: string | null
  catalog_slug: string | null
  instructions: unknown
  images: unknown
  default_rest_seconds: number | null
  rest_seconds_warmup: number | null
  preferred_unit: string | null
}

interface SetRowRaw {
  workout_id: string
  workout_name: string | null
  day: string
  set_number: number
  set_type: string
  weight: string | null
  weight_unit: string
  reps: number | null
  distance_m: string | null
  duration_s: number | null
  rpe: string | null
  side: string | null
  logical_set_id: string | null
  grip_width: string | null
  grip_orientation: string | null
  attachment: string | null
  we_grip_width: string | null
  we_grip_orientation: string | null
  we_attachment: string | null
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return []
}

function num(v: string | null): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function canonicalLbForDisplay(value: number, displayUnit: WeightUnit): number {
  return convertWeight(value, 'lb', displayUnit, 2) ?? value
}

/** Convert the canonical-lb record result without changing record selection or
 * arithmetic. Set volume scales by the same lb→kg factor because reps are
 * dimensionless. */
export function recordsForDisplay(records: Records, displayUnit: WeightUnit): DisplayRecords {
  return {
    ...records,
    bestWeight: records.bestWeight
      ? {
          ...records.bestWeight,
          value: canonicalLbForDisplay(records.bestWeight.value, displayUnit),
          unit: displayUnit,
        }
      : null,
    bestE1rm: records.bestE1rm
      ? {
          ...records.bestE1rm,
          value: canonicalLbForDisplay(records.bestE1rm.value, displayUnit),
          weight: canonicalLbForDisplay(records.bestE1rm.weight, displayUnit),
          unit: displayUnit,
        }
      : null,
    bestSetVolume: records.bestSetVolume
      ? {
          ...records.bestSetVolume,
          value: canonicalLbForDisplay(records.bestSetVolume.value, displayUnit),
          weight: canonicalLbForDisplay(records.bestSetVolume.weight, displayUnit),
          unit: displayUnit,
        }
      : null,
    repMaxes: records.repMaxes.map((entry) => ({
      ...entry,
      weight: canonicalLbForDisplay(entry.weight, displayUnit),
      unit: displayUnit,
    })),
  }
}

export function chartsForDisplay(charts: Charts, displayUnit: WeightUnit): Charts {
  const convertSeries = (series: Charts['e1rm']): Charts['e1rm'] =>
    series.map((point) => ({
      ...point,
      value: canonicalLbForDisplay(point.value, displayUnit),
    }))

  return {
    e1rm: convertSeries(charts.e1rm),
    volume: convertSeries(charts.volume),
    bestSet: convertSeries(charts.bestSet),
  }
}

/**
 * Load full detail for one exercise, or null if the id doesn't exist / is archived.
 * Fetches the row + all its completed-workout sets in two queries, then delegates
 * the math to records.ts.
 */
export async function getExerciseDetail(
  id: string,
  displayUnit: WeightUnit = 'lb',
  distanceUnit: DistanceUnit = 'm',
): Promise<ExerciseDetail | null> {
  const [row] = (
    await db.execute(sql`
      SELECT e.id, e.name, e.category, e.equipment, e.primary_muscle, e.secondary_muscles,
        e.tracks, e.load_basis, e.per_side, e.is_custom, e.ai_filled, e.tracked_at::text AS tracked_at,
        e.disliked_at::text AS disliked_at, e.dislike_reason, e.catalog_slug,
        e.instructions, e.images, e.default_rest_seconds, e.rest_seconds_warmup,
        e.preferred_unit
      FROM exercises e
      WHERE e.id = ${id} AND e.archived_at IS NULL
      LIMIT 1
    `)
  ).rows as unknown as ExerciseRowRaw[]
  if (!row) return null

  // All logged sets for this exercise, completed workouts only, newest session
  // first, sets ordered within a session.
  const setRows = (
    await db.execute(sql`
      SELECT w.id AS workout_id, w.name AS workout_name, w.started_at::date::text AS day,
        ws.set_number, ws.set_type, ws.weight::text AS weight, ws.weight_unit,
        ws.reps, ws.distance_m::text AS distance_m, ws.duration_s, ws.rpe::text AS rpe,
        ws.side, ws.logical_set_id::text AS logical_set_id,
        ws.grip_width, ws.grip_orientation, ws.attachment,
        we.grip_width AS we_grip_width, we.grip_orientation AS we_grip_orientation,
        we.attachment AS we_attachment
      FROM workout_sets ws
      JOIN workout_exercises we ON ws.workout_exercise_id = we.id
      JOIN workouts w ON we.workout_id = w.id AND w.status = 'completed'
      WHERE we.exercise_id = ${id}
      ORDER BY w.started_at DESC, ws.set_number ASC
    `)
  ).rows as unknown as SetRowRaw[]

  const tracks = row.tracks as Tracks
  const secondaryMuscles = toStringArray(row.secondary_muscles)

  // Records/charts from ALL sets (every set type; records.ts applies exclusions).
  const setInputs: SetInput[] = setRows.map((s) => ({
    setType: s.set_type,
    weight: num(s.weight),
    unit: s.weight_unit,
    reps: s.reps,
    distanceM: num(s.distance_m),
    durationS: s.duration_s,
    date: s.day,
    side: s.side === 'left' || s.side === 'right' ? s.side : null,
    logicalSetId: s.logical_set_id ?? `${s.workout_id}:${s.set_number}`,
    loadBasis: row.load_basis === 'per_side' ? 'per_side' : 'total',
    // Resolved here, not in records.ts: the per-set column alone reads as "no
    // grip" for every set that simply inherited the exercise's.
    grip: resolveGrip(
      toGripSpec(s),
      toGripSpec({
        grip_width: s.we_grip_width,
        grip_orientation: s.we_grip_orientation,
        attachment: s.we_attachment,
      }),
    ),
  }))
  const loadBasis = row.load_basis === 'per_side' ? 'per_side' : 'total'
  const records = recordsForDisplay(computeRecords(setInputs, tracks), displayUnit)
  // One continuous history PLUS a best per handle — the exercise is never split.
  const gripRecords = computeRecordsByGrip(setInputs, tracks).map((g) => ({
    ...g,
    records: recordsForDisplay(g.records, displayUnit),
  }))
  const charts = chartsForDisplay(computeCharts(setInputs, tracks), displayUnit)

  // History: group sets by workout (already ordered newest-first), cap sessions.
  const history: HistorySession[] = []
  const byWorkout = new Map<string, HistorySession>()
  for (const s of setRows) {
    let session = byWorkout.get(s.workout_id)
    if (!session) {
      if (byWorkout.size >= HISTORY_LIMIT) continue // cap distinct sessions
      session = {
        workoutId: s.workout_id,
        date: s.day,
        workoutName: s.workout_name,
        sets: [],
      }
      byWorkout.set(s.workout_id, session)
      history.push(session)
    }
    const storedWeight = num(s.weight)
    session.sets.push({
      setNumber: s.set_number,
      setType: s.set_type,
      weight: convertStoredWeight(storedWeight, s.weight_unit, displayUnit),
      unit: displayUnit,
      reps: s.reps,
      distanceM: num(s.distance_m),
      durationS: s.duration_s,
      rpe: num(s.rpe),
      side: s.side === 'left' || s.side === 'right' ? s.side : null,
      logicalSetId: s.logical_set_id ?? `${s.workout_id}:${s.set_number}`,
    })
  }

  // Images: the row's own paths, else resolve from catalog_slug via the enrichment
  // (row.images is null on un-enriched customs; slug still lets the proxy find them).
  const rowImages = toStringArray(row.images)
  const images = rowImages.length > 0 ? rowImages : slugImages(row.catalog_slug)

  // set count (working, completed) for the header.
  const sets = new Set(
    setRows
      .filter((s) => s.set_type !== 'warmup')
      .map((s) => s.logical_set_id ?? `${s.workout_id}:${s.set_number}`),
  ).size
  const lastPerformed = setRows.length > 0 ? setRows[0]!.day : null

  const regions = regionsForRow(row.name, row.primary_muscle, secondaryMuscles)

  const exercise: DetailExercise = {
    id: row.id,
    name: displayExerciseName(row.name),
    category: row.category,
    equipment: row.equipment,
    primaryMuscle: row.primary_muscle,
    secondaryMuscles,
    regions,
    tracks: row.tracks,
    loadBasis,
    perSide: row.per_side === true,
    isCustom: row.is_custom,
    aiFilled: row.ai_filled,
    tracked: row.tracked_at != null || sets > 0,
    disliked: row.disliked_at != null,
    sets,
    lastPerformed,
    hasImages: images.length > 0,
    slug: row.catalog_slug,
    imagePath: images[0] ?? null,
    instructions: toStringArray(row.instructions),
    images,
    defaultRestSeconds: row.default_rest_seconds,
    restSecondsWarmup: row.rest_seconds_warmup,
    preferredUnit: row.preferred_unit,
    dislikeReason: row.dislike_reason,
  }

  return {
    exercise,
    weightUnit: displayUnit,
    distanceUnit,
    records,
    // Omitted when nothing clears the bar, so a caller never has to decide
    // whether an empty array means "not computed" or "nothing qualified".
    ...(gripRecords.length > 0
      ? {
          gripRecords: gripRecords.map((g) => ({
            key: g.key,
            label: g.label,
            sets: g.sets,
            sessions: g.sessions,
            records: g.records,
          })),
        }
      : {}),
    history,
    charts,
  }
}

/** Standard FEDB two-frame image paths derived from a slug ("<slug>/0.jpg",
 *  "<slug>/1.jpg"). The proxy validates the path against the catalog, so a slug
 *  with only one frame simply 404s the second (harmless). */
function slugImages(slug: string | null): string[] {
  if (!slug) return []
  return [`${slug}/0.jpg`, `${slug}/1.jpg`]
}

// ---------------------------------------------------------------------------
// Mutations (POST create-with-fill, PATCH preferences). Kept here so the route
// handlers stay thin; the create path reuses catalog.createCustomExercise, then
// runs the LLM fill and writes the enriched columns.
// ---------------------------------------------------------------------------

/** A single-row lookup by case-insensitive name (or null). Used by POST to return
 *  an existing exercise as created:false without racing the unique constraint. */
async function findByName(name: string): Promise<{ id: string } | null> {
  const [row] = (
    await db.execute(
      sql`SELECT id FROM exercises
           WHERE ${normalizedNameSql('name')} = ${normalizeExerciseName(name)}
             AND archived_at IS NULL LIMIT 1`,
    )
  ).rows as unknown as { id: string }[]
  return row ?? null
}

export interface CreateExerciseResult {
  detail: ExerciseDetail
  created: boolean
  aiFilled: boolean
}

/**
 * POST create: if the name (case-insensitive) already exists, return it with
 * created:false (no fill). Else create a plain custom row, run the LLM fill, and on
 * success write the enriched columns (ai_filled=true). Fill failure still leaves a
 * usable plain row (aiFilled:false). Returns the full detail either way.
 */
export async function createExerciseWithFill(name: string): Promise<CreateExerciseResult> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('name required')

  const existing = await findByName(trimmed)
  if (existing) {
    // Non-null: the row exists and isn't archived (findByName filters archived).
    const detail = await getExerciseDetail(existing.id)
    return { detail: detail!, created: false, aiFilled: false }
  }

  return createFreshWithFill(trimmed)
}

async function createFreshWithFill(name: string): Promise<CreateExerciseResult> {
  const res = await createCustomExercise({ name })
  const id = res.exercise.id

  let aiFilled = false
  const fill = await fillExerciseMetadata(name)
  if (fill) {
    await db.execute(sql`
      UPDATE exercises SET
        category = COALESCE(category, ${fill.category}),
        equipment = COALESCE(equipment, ${fill.equipment}),
        primary_muscle = COALESCE(primary_muscle, ${fill.primaryMuscle}),
        secondary_muscles = ${JSON.stringify(fill.secondaryMuscles)}::jsonb,
        instructions = ${JSON.stringify(fill.instructions)}::jsonb,
        default_rest_seconds = COALESCE(default_rest_seconds, ${fill.defaultRestSeconds}),
        tracks = CASE WHEN tracks = 'weight_reps' AND ${fill.tracks} <> 'weight_reps' THEN ${fill.tracks} ELSE tracks END,
        modality = CASE WHEN modality = 'strength' AND ${fill.modality} <> 'strength' THEN ${fill.modality} ELSE modality END,
        per_side = CASE WHEN per_side = false THEN ${fill.perSide} ELSE per_side END,
        ai_filled = true
      WHERE id = ${id}
    `)
    aiFilled = true
  }

  const detail = await getExerciseDetail(id)
  return { detail: detail!, created: true, aiFilled }
}

export interface PatchExerciseInput {
  disliked?: boolean
  dislikeReason?: string | null
  /** The "Preference" reason chip (#1876) — set when the user replaces an exercise
   *  because he prefers the new pick. Biases replacement ranking/drafting
   *  toward it; distinct from `disliked` and never mutually exclusive with it. */
  preferred?: boolean
  defaultRestSeconds?: number | null
  restSecondsWarmup?: number | null
  preferredUnit?: 'lb' | 'kg' | null
  loadBasis?: 'total' | 'per_side'
  /** Whether the logger deals this exercise one side at a time (L/R rows).
   *
   *  ⚠️ Not the same field as `loadBasis`, despite the shared vocabulary:
   *  `loadBasis: 'per_side'` says an entered weight means "per hand", while
   *  this says each set is performed one side at a time and needs its own row.
   *  A dumbbell bench press is per-side LOAD but not per-side EXECUTION.
   *
   *  Until now nothing could set this after creation — only the catalog
   *  generator's name heuristic (which deliberately skips `modality:
   *  'strength'`) and the AI fill at creation time. That left every strength
   *  unilateral stuck at false with no way to correct it, which made the
   *  side-labelled set rows from #1840 unreachable for exactly the exercises
   *  that need them (side planks, single-arm rows, split squats). */
  perSide?: boolean
  tracked?: boolean
  /** Temporary staleness cooldown (the "Bored of it" reason chip). A positive
   *  number of days → snoozed_until = now()+N days; 0 or null → clear the cooldown.
   *  Distinct from `disliked` (a hard, permanent exclusion). */
  snoozeDays?: number | null
  /** The measurement model. `tracks` defaults to 'weight_reps' at the column
   *  level, so a row created without an explicit one silently measures a hold
   *  or a carry in weight×reps and can never record a PR. Correcting it is the
   *  only way to give such a row real records. */
  tracks?: Tracks
  /** Primary muscle. A NULL here keeps the exercise out of every rotation pool
   *  (no muscle → no region → no pool), which makes it invisible to search and
   *  to any drafted workout even though it is neither archived nor disliked. */
  primaryMuscle?: string | null
  /** Clear this movement past the injury gate. Scoped to this exercise only —
   *  every other injury exclusion stays in force. */
  injuryOverride?: boolean
  /** How to perform it, one step per element. Fillable after the fact: a custom
   *  row created before instructions were supported shows a bare name in the
   *  detail sheet, and there is usually no image to fall back on. */
  instructions?: string[] | null
  /** Supporting muscles. A movement is rarely one region — a loaded carry is
   *  traps AND forearms — and without these the secondary region gets no volume
   *  credit at all, which quietly skews the balance read. */
  secondaryMuscles?: string[]
  /** strength | stretch | dynamic | soft_tissue | cardio. Wrong here and a warmup
   *  drill gets dealt as a working set: strength drafts read modality to decide
   *  what may appear at all, so a mobility movement mislabelled 'strength' is
   *  eligible for a leg day. */
  modality?: string
  /** FEDB-style equipment token ('barbell' | 'dumbbell' | 'cable' | 'machine' |
   *  …) or free text from a web-research pass (#1788). Null clears it. */
  equipment?: string | null
}

export class ActiveLoadCorrectionError extends Error {
  constructor() {
    super('Undo the active Strong-history correction before switching to total load')
    this.name = 'ActiveLoadCorrectionError'
  }
}

/**
 * PATCH any-of the per-exercise preference columns. Returns the updated detail, or
 * null when the id doesn't exist (route returns an honest 404 — .returning()
 * rowcount guard, repo convention). Only the provided fields are touched.
 */
export async function patchExercise(
  id: string,
  input: PatchExerciseInput,
): Promise<ExerciseDetail | null> {
  if (input.loadBasis === 'total') {
    const active = (
      await db.execute(sql`
        SELECT id FROM exercise_load_corrections
        WHERE exercise_id = ${id} AND active = true AND reverted_at IS NULL
        LIMIT 1
      `)
    ).rows as unknown as Array<{ id: string }>
    if (active.length > 0) throw new ActiveLoadCorrectionError()
  }
  const sets: ReturnType<typeof sql>[] = []
  if (input.disliked !== undefined) {
    sets.push(input.disliked ? sql`disliked_at = now()` : sql`disliked_at = NULL`)
    // A dislike reason only makes sense alongside disliked=true; clear it on un-dislike.
    if (input.disliked) {
      if (input.dislikeReason !== undefined) {
        sets.push(sql`dislike_reason = ${input.dislikeReason}`)
      }
    } else {
      sets.push(sql`dislike_reason = NULL`)
    }
  } else if (input.dislikeReason !== undefined) {
    sets.push(sql`dislike_reason = ${input.dislikeReason}`)
  }
  if (input.defaultRestSeconds !== undefined) {
    sets.push(sql`default_rest_seconds = ${input.defaultRestSeconds}`)
  }
  if (input.restSecondsWarmup !== undefined) {
    sets.push(sql`rest_seconds_warmup = ${input.restSecondsWarmup}`)
  }
  if (input.preferredUnit !== undefined) {
    sets.push(sql`preferred_unit = ${input.preferredUnit}`)
  }
  if (input.loadBasis !== undefined) {
    sets.push(sql`load_basis = ${input.loadBasis}`)
  }
  if (input.perSide !== undefined) {
    sets.push(sql`per_side = ${input.perSide}`)
  }
  if (input.tracked !== undefined) {
    sets.push(input.tracked ? sql`tracked_at = now()` : sql`tracked_at = NULL`)
  }
  if (input.preferred !== undefined) {
    sets.push(input.preferred ? sql`preferred_at = now()` : sql`preferred_at = NULL`)
  }
  if (input.snoozeDays !== undefined) {
    // >0 days → cooldown that far ahead; 0 / null / negative → clear it.
    if (typeof input.snoozeDays === 'number' && input.snoozeDays > 0) {
      sets.push(sql`snoozed_until = now() + (${input.snoozeDays} * interval '1 day')`)
    } else {
      sets.push(sql`snoozed_until = NULL`)
    }
  }
  if (input.tracks !== undefined) {
    sets.push(sql`tracks = ${input.tracks}`)
  }
  if (input.primaryMuscle !== undefined) {
    const m = input.primaryMuscle?.trim()
    sets.push(sql`primary_muscle = ${m ? m : null}`)
  }
  if (input.instructions !== undefined) {
    const steps = (input.instructions ?? []).map((t) => t.trim()).filter(Boolean)
    sets.push(
      steps.length > 0
        ? sql`instructions = ${JSON.stringify(steps)}::jsonb`
        : sql`instructions = NULL`,
    )
  }
  if (input.injuryOverride !== undefined) {
    sets.push(sql`injury_override = ${input.injuryOverride}`)
  }
  if (input.secondaryMuscles !== undefined) {
    const cleaned = input.secondaryMuscles.map((m) => m.trim()).filter(Boolean)
    sets.push(sql`secondary_muscles = ${JSON.stringify(cleaned)}::jsonb`)
  }
  if (input.modality !== undefined && MODALITIES.has(input.modality)) {
    sets.push(sql`modality = ${input.modality}`)
  }
  if (input.equipment !== undefined) {
    const e = input.equipment?.trim()
    sets.push(sql`equipment = ${e ? e : null}`)
  }

  if (sets.length === 0) {
    // Nothing to change — treat as a read (still 404 if missing).
    return getExerciseDetail(id)
  }

  const updated = (
    await db.execute(sql`
      UPDATE exercises SET ${sql.join(sets, sql`, `)}
      WHERE id = ${id} AND archived_at IS NULL
      RETURNING id
    `)
  ).rows as unknown as { id: string }[]
  if (updated.length === 0) return null
  return getExerciseDetail(id)
}
