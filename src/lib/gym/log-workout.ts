/**
 * Post-hoc bulk workout entry (GYM_PLAN §6 "log_workout") — the chat/voice home
 * for "just did legs: squat 5×5 at 225…". This is NOT a mid-set affordance and
 * NOT a phase gate; it takes a WHOLE completed session as one payload and writes
 * it straight to history.
 *
 * Flow (deliberately reuses the live-logging + finish machinery — no duplicated
 * PR / habit / retain logic):
 *   1. resolve each exercise name → id (case-insensitive lookup; unknown names
 *      go through createExerciseWithFill — the same fail-open LLM-fill lane the
 *      Exercises tab "create «name»" uses, so a novel movement becomes a real
 *      tracked row rather than an error);
 *   2. INSERT a workout as status='active' (source 'app'), its workout_exercises
 *      (position + preserved superset_group), and its workout_sets (completed=true,
 *      database-generated client_set_id; adjacent opposite L/R rows share a
 *      logical_set_id; set_number stays dense per physical row;
 *      warmup/drop/failure set_types flow through);
 *   3. call finishWorkout(workoutId) — the SAME finish flow the logger uses — to
 *      flip active→completed, compute PRs (computeRecords vs all-time prior),
 *      auto-log the linked habit, and enqueue the one health retain.
 *
 * Because step 3 is finishWorkout, a bulk-logged PR can never disagree with the
 * logger's or the exercise-detail's PR math, and the habit/retain side-effects
 * are identical. If the session has no completed working data, finishWorkout
 * returns 422 and we roll the empty workout back to 'discarded' so it never
 * pollutes history.
 */
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { ensureFitnessTables, ensureGymSchema } from '@/lib/db/ensure-fitness'
import { getAppTimezone, todayInZone } from '@/lib/today'
import { createExerciseWithFill } from './exercise-detail'
import { finishWorkout, type WorkoutPr } from './finish'
import { normalizeExerciseName, normalizedNameSql } from '@/lib/fitness/exercise-name'

// ---------------------------------------------------------------------------
// Input contract (mirrors the tool's zod args, 1:1)
// ---------------------------------------------------------------------------

export type LogSetType = 'warmup' | 'normal' | 'drop' | 'failure'

export interface LogSetInput {
  weight?: number | null
  unit?: 'lb' | 'kg' | null
  reps?: number | null
  durationS?: number | null
  distanceM?: number | null
  rpe?: number | null
  setType?: LogSetType | null
  /** Per-side hold marker (§10b.2): "pigeon 2×60s each side" logs L/R rows. */
  side?: 'left' | 'right' | null
}

export interface LogExerciseInput {
  exerciseName: string
  sets: LogSetInput[]
}

export interface LogWorkoutInput {
  name?: string | null
  /** 'YYYY-MM-DD' — defaults to today (app tz). */
  date?: string | null
  exercises: LogExerciseInput[]
  notes?: string | null
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface LoggedExerciseSummary {
  name: string
  /** True when this name didn't exist and we created (fail-open filled) a row. */
  created: boolean
  setCount: number
}

export type LogWorkoutResult =
  | {
      ok: true
      workoutId: string
      name: string | null
      date: string
      exercises: LoggedExerciseSummary[]
      setsLogged: number
      totalVolumeLb: number
      prs: WorkoutPr[]
      habitLogged: boolean
    }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Case-insensitive single-row name lookup (non-archived). */
async function findExerciseByName(name: string): Promise<{ id: string } | null> {
  const [row] = (
    await db.execute(
      sql`SELECT id FROM exercises
           WHERE ${normalizedNameSql('name')} = ${normalizeExerciseName(name)}
             AND archived_at IS NULL LIMIT 1`,
    )
  ).rows as unknown as { id: string }[]
  return row ?? null
}

interface ResolvedExercise {
  input: LogExerciseInput
  exerciseId: string
  name: string
  created: boolean
}

/**
 * Resolve every exercise name to an id, creating (fail-open LLM-fill) any that
 * don't exist. `createExerciseWithFill` returns the existing row as created:false
 * when the name already exists, so this is safe against re-runs. Returns the
 * resolved list preserving input order.
 */
async function resolveExercises(exercises: LogExerciseInput[]): Promise<ResolvedExercise[]> {
  const out: ResolvedExercise[] = []
  for (const ex of exercises) {
    const name = ex.exerciseName.trim()
    if (!name) throw new Error('exercise_name is required for every exercise')
    const existing = await findExerciseByName(name)
    if (existing) {
      out.push({ input: ex, exerciseId: existing.id, name, created: false })
      continue
    }
    // Unknown movement → create it (fail-open; a fill hiccup still leaves a
    // usable plain custom row). Never blocks the log.
    const res = await createExerciseWithFill(name)
    out.push({
      input: ex,
      exerciseId: res.detail.exercise.id,
      name: res.detail.exercise.name,
      created: res.created,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

const VALID_SET_TYPES = new Set<LogSetType>(['warmup', 'normal', 'drop', 'failure'])

/** A set carries usable data when at least one measure is present + positive. */
function setHasData(s: LogSetInput): boolean {
  return (
    (s.weight != null && s.weight > 0) ||
    (s.reps != null && s.reps > 0) ||
    (s.durationS != null && s.durationS > 0) ||
    (s.distanceM != null && s.distanceM > 0)
  )
}

interface LogicalLogSet {
  set: LogSetInput
  logicalSetId: string
}

/** Match the live logger's logical-round authoring: adjacent opposite L/R rows
 * are one round, while bilateral, one-sided, and incompatible set types remain
 * independent. Empty input rows are removed before adjacency is evaluated. */
function assignLogicalSetIds(sets: LogSetInput[]): LogicalLogSet[] {
  const usable = sets.filter(setHasData)
  const out: LogicalLogSet[] = []
  for (let index = 0; index < usable.length; index += 1) {
    const current = usable[index]!
    const logicalSetId = randomUUID()
    out.push({ set: current, logicalSetId })

    const next = usable[index + 1]
    if (
      next &&
      current.side != null &&
      next.side != null &&
      current.side !== next.side &&
      (current.setType ?? 'normal') === (next.setType ?? 'normal')
    ) {
      out.push({ set: next, logicalSetId })
      index += 1
    }
  }
  return out
}

/**
 * Log a whole completed workout in one shot. Returns the finish summary (PRs +
 * habit auto-log + volume) exactly as the live logger's finish flow produces it.
 * Fail-closed on an empty session (rolls the placeholder workout to 'discarded').
 */
export async function logWorkout(input: LogWorkoutInput): Promise<LogWorkoutResult> {
  await ensureFitnessTables()
  await ensureGymSchema()

  const exercisesIn = input.exercises ?? []
  if (exercisesIn.length === 0) {
    return { ok: false, error: 'No exercises to log — pass at least one exercise with sets.' }
  }

  // Resolve the date (default: today in the app tz). Bulk entry stamps started_at
  // at noon of that day so the calendar/day math lands on the intended date
  // regardless of tz, and duration is a real (small) number rather than 0.
  const tz = await getAppTimezone()
  const day = normalizeDay(input.date, todayInZone(tz))

  const resolved = await resolveExercises(exercisesIn)

  // Build the workout in one transaction: active workout → exercises → completed
  // sets. Then finishWorkout runs the shared side-effects.
  const { workoutId, setsLogged, perExercise } = await db.transaction(async (tx) => {
    const [w] = (
      await tx.execute(sql`
        INSERT INTO workouts (name, started_at, ended_at, status, source, notes)
        VALUES (
          ${input.name?.trim() || null},
          ${`${day}T12:00:00`}::timestamptz,
          now(), 'active', 'app', ${input.notes?.trim() || null}
        )
        RETURNING id
      `)
    ).rows as unknown as { id: string }[]
    const wid = w!.id

    let totalSets = 0
    const perEx: LoggedExerciseSummary[] = []
    let position = 0
    for (const ex of resolved) {
      // A repeated exercise in the payload is a real second instance (curls at
      // the start and again at the end) — each entry gets its own slot.
      const [we] = (
        await tx.execute(sql`
          INSERT INTO workout_exercises (workout_id, exercise_id, position)
          VALUES (${wid}, ${ex.exerciseId}, ${position})
          RETURNING id
        `)
      ).rows as unknown as { id: string }[]
      const workoutExerciseId = we!.id
      position += 1

      // Insert only sets that carry data (empty rows would be dropped by finish
      // anyway — don't persist them). set_number is dense per exercise (1-based).
      let setNumber = 1
      const logicalSets = new Set<string>()
      for (const { set: s, logicalSetId } of assignLogicalSetIds(ex.input.sets ?? [])) {
        const setType: LogSetType =
          s.setType && VALID_SET_TYPES.has(s.setType) ? s.setType : 'normal'
        await tx.execute(sql`
          INSERT INTO workout_sets (
            workout_exercise_id, set_number, set_type, weight, weight_unit,
            reps, distance_m, duration_s, rpe, side, logical_set_id, completed
          ) VALUES (
            ${workoutExerciseId}, ${setNumber}, ${setType},
            ${s.weight ?? null}, ${s.unit ?? 'lb'}, ${s.reps ?? null},
            ${s.distanceM ?? null}, ${s.durationS ?? null}, ${s.rpe ?? null},
            ${s.side === 'left' || s.side === 'right' ? s.side : null},
            ${logicalSetId}, true
          )
        `)
        setNumber += 1
        logicalSets.add(logicalSetId)
      }
      const exSetCount = logicalSets.size
      totalSets += exSetCount
      perEx.push({ name: ex.name, created: ex.created, setCount: exSetCount })
    }

    return { workoutId: wid, setsLogged: totalSets, perExercise: perEx }
  })

  if (setsLogged === 0) {
    // Nothing usable — discard the placeholder so it never shows in history.
    await db.execute(
      sql`UPDATE workouts SET status = 'discarded', ended_at = now() WHERE id = ${workoutId} AND status = 'active'`,
    )
    return { ok: false, error: 'Every set was empty — nothing to log. Include a weight/reps/duration on each set.' }
  }

  // Reuse the finish flow: flips active→completed, PRs, habit auto-log, retain.
  const finish = await finishWorkout(workoutId)
  if (!finish.ok) {
    // finish only fails 'empty'/'not-active' here; guard anyway (roll back).
    await db.execute(
      sql`UPDATE workouts SET status = 'discarded', ended_at = now() WHERE id = ${workoutId} AND status = 'active'`,
    )
    return { ok: false, error: 'Could not finalize the workout (no completed working sets).' }
  }

  // Bulk entry has no MEASURED duration — finishWorkout derives one from
  // (now − started_at), which is meaningless for a post-hoc/backfilled log (and
  // wildly inflated for a past date). Null it out + pin started_at/ended_at to
  // the target day's noon so History places it correctly with no phantom length.
  await db.execute(sql`
    UPDATE workouts
    SET duration_seconds = NULL,
        started_at = ${`${day}T12:00:00`}::timestamptz,
        ended_at = ${`${day}T12:00:00`}::timestamptz
    WHERE id = ${workoutId}
  `)

  return {
    ok: true,
    workoutId,
    name: input.name?.trim() || null,
    date: day,
    exercises: perExercise,
    setsLogged,
    totalVolumeLb: finish.summary.totalVolumeLb,
    prs: finish.summary.prs,
    habitLogged: finish.summary.habitLogged,
  }
}

/** 'YYYY-MM-DD' (validated) or the fallback. */
function normalizeDay(raw: string | null | undefined, fallback: string): string {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim()
  return fallback
}
