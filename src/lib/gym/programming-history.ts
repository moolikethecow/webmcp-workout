import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'

import { musclesForExerciseEnriched, type MuscleRegion } from '@/lib/fitness/muscles'

import type { SessionMark } from './detraining'
import {
  EMPTY_PROGRAMMING_HISTORY,
  type ProgrammingHistory,
} from './programming-policy'
import { KG_TO_LB } from './records'

export interface ProgrammingHistoryRow {
  workout_id: string
  exercise_id: string
  position: number
  superset_group: number | null
  rest_seconds: number | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]!
  return (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** Reduce bounded recent-session rows into personalization priors. History may
 * break ties and nudge rest, but the programming engine bounds it so a past bad
 * habit can never override the evidence-led class/order/rest floor. */
export function summarizeProgrammingHistory(rows: ProgrammingHistoryRow[]): ProgrammingHistory {
  if (rows.length === 0) return EMPTY_PROGRAMMING_HISTORY
  const positions = new Map<string, number[]>()
  const seenPosition = new Set<string>()
  const workoutIds = new Set<string>()
  const supersetWorkoutIds = new Set<string>()
  const rests: number[] = []
  for (const row of rows) {
    workoutIds.add(row.workout_id)
    if (row.superset_group != null) supersetWorkoutIds.add(row.workout_id)
    const positionKey = `${row.workout_id}:${row.exercise_id}`
    if (!seenPosition.has(positionKey)) {
      seenPosition.add(positionKey)
      const values = positions.get(row.exercise_id)
      if (values) values.push(row.position)
      else positions.set(row.exercise_id, [row.position])
    }
    if (row.rest_seconds != null && Number.isFinite(row.rest_seconds) && row.rest_seconds >= 0) {
      rests.push(row.rest_seconds)
    }
  }
  return {
    positionByExercise: new Map(
      [...positions].map(([exerciseId, values]) => [exerciseId, median(values) ?? 0]),
    ),
    supersetSessionRate: workoutIds.size > 0 ? supersetWorkoutIds.size / workoutIds.size : 0,
    medianRestSeconds: median(rests),
  }
}

/** The last twelve completed sessions are enough to personalize cadence without
 * turning old programming into an unbounded lifetime rule. */
export async function readProgrammingHistory(): Promise<ProgrammingHistory> {
  const rows = (
    await db.execute(sql`
      WITH recent_workouts AS (
        SELECT id
        FROM workouts
        WHERE status = 'completed'
        ORDER BY started_at DESC, id DESC
        LIMIT 12
      )
      SELECT rw.id AS workout_id, we.exercise_id, we.position, we.superset_group,
        COALESCE(ws.rest_seconds, we.rest_seconds)::int AS rest_seconds
      FROM recent_workouts rw
      JOIN workout_exercises we ON we.workout_id = rw.id
      LEFT JOIN workout_sets ws ON ws.workout_exercise_id = we.id
        AND ws.completed = true AND ws.set_type <> 'warmup'
      ORDER BY rw.id, we.position, ws.set_number
    `)
  ).rows as unknown as ProgrammingHistoryRow[]
  return summarizeProgrammingHistory(rows)
}

// ---------------------------------------------------------------------------
// Return-to-training reads (#1790)
// ---------------------------------------------------------------------------

/** Sessions to scan when looking for a layoff. Must comfortably exceed
 *  RAMP_SESSIONS so the gap that opened a re-entry block is still visible once
 *  The user is several sessions back into it. */
const DETRAINING_HISTORY_SESSIONS = 16

/**
 * Completed sessions for one exercise, NEWEST→OLDEST, each with its top
 * completed WORKING weight normalized to lb.
 *
 * Top set (not the mean) because the re-entry ramp anchors on what the user was
 * actually working up to before the layoff; back-off sets would understate the
 * baseline and compound with the de-load. Warmups and uncompleted sets are
 * excluded — the same completed-only, warmup-excluded basis the records and
 * e1RM helpers use, so the load math is never forked.
 *
 * ⚠️ Exercise-scoped ON PURPOSE, not region-scoped. A region gap can never be
 * longer than the gap for an exercise inside it, so a region signal could only
 * ever matter for an exercise with NO history of its own — and there it would
 * have to invent this exercise's baseline from a DIFFERENT movement's weights,
 * which is exactly the kind of load transfer that is unsafe to guess. Global
 * gym staleness is handled separately by `readLastGymSessionAt`.
 */
export async function readDetrainingMarks(exerciseId: string): Promise<SessionMark[]> {
  const rows = (
    await db.execute(sql`
      SELECT w.started_at,
        MAX(CASE WHEN ws.weight_unit = 'kg' THEN ws.weight * ${KG_TO_LB} ELSE ws.weight END)
          AS top_weight_lb
      FROM workouts w
      JOIN workout_exercises we ON we.workout_id = w.id
      JOIN workout_sets ws ON ws.workout_exercise_id = we.id
      WHERE we.exercise_id = ${exerciseId}
        AND w.status = 'completed'
        AND ws.completed = true
        AND ws.set_type <> 'warmup'
      GROUP BY w.id, w.started_at
      ORDER BY w.started_at DESC
      LIMIT ${DETRAINING_HISTORY_SESSIONS}
    `)
  ).rows as unknown as Array<{ started_at: string | Date; top_weight_lb: string | number | null }>

  return rows.map((r) => ({
    at: new Date(r.started_at).getTime(),
    topWeightLb: r.top_weight_lb == null ? null : Number(r.top_weight_lb),
  }))
}

/** When the user last completed ANY workout, as epoch ms — or null if they never have.
 *  Drives the stale-plan flag: a training plan whose last session is weeks old
 *  should offer a restart rather than silently resuming at week 6. */
export async function readLastGymSessionAt(): Promise<number | null> {
  const [row] = (
    await db.execute(sql`
      SELECT started_at FROM workouts WHERE status = 'completed'
      ORDER BY started_at DESC LIMIT 1
    `)
  ).rows as unknown as Array<{ started_at: string | Date }>
  return row ? new Date(row.started_at).getTime() : null
}

/**
 * `readDetrainingMarks` for many exercises in ONE query.
 *
 * The drafting path scores 40-120 candidates; a per-exercise round trip there
 * would be the dominant cost of a draft. Same basis as the single read.
 */
export async function readDetrainingMarksBatch(
  exerciseIds: readonly string[],
): Promise<Map<string, SessionMark[]>> {
  const out = new Map<string, SessionMark[]>()
  if (exerciseIds.length === 0) return out
  const rows = (
    await db.execute(sql`
      SELECT ranked.exercise_id, ranked.started_at, ranked.top_weight_lb
      FROM (
        SELECT we.exercise_id, w.started_at,
          MAX(CASE WHEN ws.weight_unit = 'kg' THEN ws.weight * ${KG_TO_LB} ELSE ws.weight END)
            AS top_weight_lb,
          ROW_NUMBER() OVER (PARTITION BY we.exercise_id ORDER BY w.started_at DESC) AS rn
        FROM workouts w
        JOIN workout_exercises we ON we.workout_id = w.id
        JOIN workout_sets ws ON ws.workout_exercise_id = we.id
        WHERE we.exercise_id IN (${sql.join(
          exerciseIds.map((id) => sql`${id}`),
          sql`, `,
        )})
          AND w.status = 'completed'
          AND ws.completed = true
          AND ws.set_type <> 'warmup'
        GROUP BY we.exercise_id, w.id, w.started_at
      ) ranked
      WHERE ranked.rn <= ${DETRAINING_HISTORY_SESSIONS}
      ORDER BY ranked.exercise_id, ranked.started_at DESC
    `)
  ).rows as unknown as Array<{
    exercise_id: string
    started_at: string | Date
    top_weight_lb: string | number | null
  }>

  for (const r of rows) {
    const list = out.get(r.exercise_id) ?? []
    list.push({
      at: new Date(r.started_at).getTime(),
      topWeightLb: r.top_weight_lb == null ? null : Number(r.top_weight_lb),
    })
    out.set(r.exercise_id, list)
  }
  return out
}

// ---------------------------------------------------------------------------
// Region-scoped reads (#1790 follow-up)
// ---------------------------------------------------------------------------

/**
 * exercise id → its PRIMARY muscle regions, for the whole catalog.
 *
 * Resolution is name-aware (`musclesForExerciseEnriched`), the same call
 * `buildPools` makes — the `primary_muscle` COLUMN is NULL on ~132 rows that
 * resolve perfectly well by name, and a column-only check drifted from the pool
 * builder twice already (#1787, #1806). Built once per workout/draft and reused,
 * because it is a whole-catalog read.
 */
export async function loadRegionIndex(): Promise<Map<string, MuscleRegion[]>> {
  const rows = (
    await db.execute(sql`
      SELECT id, name, primary_muscle, secondary_muscles FROM exercises
    `)
  ).rows as unknown as Array<{
    id: string
    name: string
    primary_muscle: string | null
    secondary_muscles: unknown
  }>
  const index = new Map<string, MuscleRegion[]>()
  for (const r of rows) {
    const secondary = Array.isArray(r.secondary_muscles) ? (r.secondary_muscles as string[]) : []
    const regions = musclesForExerciseEnriched(r.name, r.primary_muscle, secondary)
      .filter((h) => h.weight === 1)
      .map((h) => h.region)
    if (regions.length > 0) index.set(r.id, regions)
  }
  return index
}

/**
 * Completed sessions for every exercise sharing this one's primary regions,
 * NEWEST→OLDEST — one mark per WORKOUT (a session that trained the region), each
 * carrying whether it met its prescription.
 *
 * This is what detects a layoff: pressing is pressing whether the bar is a
 * barbell or a pair of dumbbells. Returns [] when the region cannot be resolved,
 * which makes the caller fall back to per-exercise history.
 */
export async function readRegionMarks(
  exerciseId: string,
  index: Map<string, MuscleRegion[]>,
): Promise<SessionMark[]> {
  const regions = index.get(exerciseId)
  if (!regions || regions.length === 0) return []
  const siblingIds: string[] = []
  for (const [id, rs] of index) {
    if (rs.some((r) => regions.includes(r))) siblingIds.push(id)
  }
  if (siblingIds.length === 0) return []

  const rows = (
    await db.execute(sql`
      SELECT w.started_at,
        -- A session MET its prescription when no prescribed working set came
        -- back short. Sets with no prescription recorded are ignored rather
        -- than counted as failures; a session with none is 'unknown' (NULL).
        --
        -- ⚠️ A set with NO LOGGED REPS is 'unknown', NOT a failure. Time-tracked
        -- work (a 20s door-frame stretch) logs duration and no reps, yet can
        -- still carry a phantom target_reps from its template — and bool_and is
        -- FALSE if any row is false, so one such row marked a whole REGION's
        -- session as missed and froze the ramp at step 0. Found on prod
        -- 2026-08-27: the user's cleanly-completed 08-26 chest session scored false
        -- purely because Door Frame Chest Stretch resolves to chest.
        bool_and(
          CASE WHEN ws.prescribed_reps IS NULL OR ws.reps IS NULL THEN NULL
               ELSE ws.reps >= ws.prescribed_reps END
        ) AS met_prescription
      FROM workouts w
      JOIN workout_exercises we ON we.workout_id = w.id
      JOIN workout_sets ws ON ws.workout_exercise_id = we.id
      WHERE we.exercise_id IN (${sql.join(
        siblingIds.map((id) => sql`${id}`),
        sql`, `,
      )})
        AND w.status = 'completed'
        AND ws.completed = true
        AND ws.set_type <> 'warmup'
      GROUP BY w.id, w.started_at
      ORDER BY w.started_at DESC
      LIMIT ${DETRAINING_HISTORY_SESSIONS}
    `)
  ).rows as unknown as Array<{ started_at: string | Date; met_prescription: boolean | null }>

  return rows.map((r) => ({
    at: new Date(r.started_at).getTime(),
    topWeightLb: null, // the region never supplies a baseline weight — by design
    ...(r.met_prescription == null ? {} : { metPrescription: r.met_prescription }),
  }))
}

/**
 * `readRegionMarks` for many exercises, one query per DISTINCT region set.
 *
 * Candidates sharing a region share a sibling set and therefore share an answer,
 * so a draft scoring 40-120 candidates issues a handful of queries rather than
 * one per candidate.
 */
export async function readRegionMarksBatch(
  exerciseIds: readonly string[],
  index: Map<string, MuscleRegion[]>,
): Promise<Map<string, SessionMark[]>> {
  const out = new Map<string, SessionMark[]>()
  const bySignature = new Map<string, string[]>()
  for (const id of exerciseIds) {
    const regions = index.get(id)
    if (!regions || regions.length === 0) continue
    const signature = [...regions].sort().join('|')
    const bucket = bySignature.get(signature)
    if (bucket) bucket.push(id)
    else bySignature.set(signature, [id])
  }
  for (const ids of bySignature.values()) {
    // Every id in the bucket resolves to the same siblings — read once, share.
    const marks = await readRegionMarks(ids[0]!, index)
    for (const id of ids) out.set(id, marks)
  }
  return out
}
