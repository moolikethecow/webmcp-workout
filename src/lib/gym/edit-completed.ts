/**
 * Editing a COMPLETED workout (#1833).
 *
 * Until now a session was immutable once finished: `edit_active_workout` covers
 * only the live session, `edit_workout_proposal` only today's draft, and
 * `log_workout` only creates new sessions. So a mislabel made mid-workout — the
 * pendulum squats logged under Hack Squat because the catalog had no entry for
 * them — became permanent, polluting BOTH exercises' records.
 *
 * ── Why there is no "recompute" step ───────────────────────────────────────
 * The issue asked for a PR/records recompute alongside each edit. There is
 * nothing to recompute: records are DERIVED at read time (`computeRecords` over
 * `readExerciseSets`), never materialized into a table. Correcting a set row
 * therefore corrects every record that reads it, automatically. Adding a
 * recompute pass here would be inventing a cache that does not exist.
 *
 * ── Safety ─────────────────────────────────────────────────────────────────
 * Every statement joins through to the owning workout and requires
 * `status = 'completed'`, so a wrong id cannot reach another session's rows and
 * an ACTIVE session can never be edited through here — that is
 * `edit_active_workout`'s job, and it has its own in-progress guards.
 */
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'

export interface EditResult {
  ok: boolean
  /** Rows actually changed — 0 means the target did not match, not "success". */
  changed: number
  error?: string
}

const NOT_FOUND =
  'No completed session matched that id (an ACTIVE session is edited with edit_active_workout).'

/** Rename a completed session — the fix for drifted labels like three different
 *  session types all called "DAY 3", which makes workout_label filtering
 *  useless. */
export async function renameCompletedWorkout(
  workoutId: string,
  name: string,
): Promise<EditResult> {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, changed: 0, error: 'name cannot be blank.' }
  const res = await db.execute(sql`
    UPDATE workouts SET name = ${trimmed}
    WHERE id = ${workoutId} AND status = 'completed'
  `)
  const changed = res.rowCount ?? 0
  return changed > 0 ? { ok: true, changed } : { ok: false, changed: 0, error: NOT_FOUND }
}

/**
 * Point a logged exercise entry at a different catalog exercise, carrying its
 * sets with it.
 *
 * This is the mislabel fix, and it moves history between BOTH exercises'
 * records — the sets stop counting toward the wrong movement and start counting
 * toward the right one. Since records are derived, that correction is immediate.
 */
export async function repointCompletedExercise(
  workoutId: string,
  workoutExerciseId: string,
  toExerciseId: string,
): Promise<EditResult> {
  const res = await db.execute(sql`
    UPDATE workout_exercises we
       SET exercise_id = ${toExerciseId}
      FROM workouts w
     WHERE we.id = ${workoutExerciseId}
       AND we.workout_id = w.id
       AND w.id = ${workoutId}
       AND w.status = 'completed'
  `)
  const changed = res.rowCount ?? 0
  return changed > 0
    ? { ok: true, changed }
    : { ok: false, changed: 0, error: 'That exercise entry is not in this completed session.' }
}

export interface SetValuePatch {
  weight?: number | null
  reps?: number | null
  restSeconds?: number | null
  rpe?: number | null
}

/**
 * Correct the values on one logged set.
 *
 * Deliberately a PATCH: only the fields passed are touched, because a
 * replace-all here would silently blank the ones the caller left out — the
 * exact failure mode #1830 raises about templates. An explicit `null` clears a
 * field; an omitted key leaves it alone.
 */
export async function updateCompletedSetValues(
  workoutId: string,
  setId: string,
  patch: SetValuePatch,
): Promise<EditResult> {
  const sets = []
  if ('weight' in patch) sets.push(sql`weight = ${patch.weight ?? null}`)
  if ('reps' in patch) sets.push(sql`reps = ${patch.reps ?? null}`)
  if ('restSeconds' in patch) sets.push(sql`rest_seconds = ${patch.restSeconds ?? null}`)
  if ('rpe' in patch) sets.push(sql`rpe = ${patch.rpe ?? null}`)
  if (sets.length === 0) {
    return { ok: false, changed: 0, error: 'Pass at least one of weight, reps, rest_seconds, rpe.' }
  }

  const res = await db.execute(sql`
    UPDATE workout_sets ws
       SET ${sql.join(sets, sql`, `)}
      FROM workout_exercises we
      JOIN workouts w ON w.id = we.workout_id
     WHERE ws.id = ${setId}
       AND ws.workout_exercise_id = we.id
       AND w.id = ${workoutId}
       AND w.status = 'completed'
  `)
  const changed = res.rowCount ?? 0
  return changed > 0
    ? { ok: true, changed }
    : { ok: false, changed: 0, error: 'That set is not in this completed session.' }
}

/**
 * Remove one erroneous logged set.
 *
 * Set numbers are deliberately NOT renumbered afterwards. A gap is honest —
 * it says a set was removed — whereas resequencing would silently rewrite the
 * numbers every other reference already uses, including the `logical_set_id`
 * pairing that keeps a split L/R round counted once.
 */
export async function removeCompletedSet(
  workoutId: string,
  setId: string,
): Promise<EditResult> {
  const res = await db.execute(sql`
    DELETE FROM workout_sets ws
     USING workout_exercises we, workouts w
     WHERE ws.id = ${setId}
       AND ws.workout_exercise_id = we.id
       AND we.workout_id = w.id
       AND w.id = ${workoutId}
       AND w.status = 'completed'
  `)
  const changed = res.rowCount ?? 0
  return changed > 0
    ? { ok: true, changed }
    : { ok: false, changed: 0, error: 'That set is not in this completed session.' }
}

/**
 * Move ONE logged set onto a different exercise within the same session.
 *
 * `repointCompletedExercise` moves a whole exercise entry, which is the wrong
 * shape whenever a single session mixed two machines under one name — The user's
 * 2025-08-05 leg day logged 230, 230 and 90 lb as "Hack Squat", and the 90 was
 * a pendulum squat. Repointing sends all three the same way; either choice is
 * wrong for one of them.
 *
 * Three pieces of care:
 *  - The destination entry is CREATED if the session doesn't already have one,
 *    appended at the end rather than inserted, so existing positions are
 *    untouched.
 *  - The set is RENUMBERED to the end of the destination. Keeping its old
 *    number would collide with a set already sitting at that number there.
 *  - A split L/R round shares a `logical_set_id`, and both halves are one
 *    round. Moving a single half would leave the pair straddling two
 *    exercises, so the whole logical set travels together.
 *
 * An emptied source entry is removed — a session listing an exercise with no
 * sets under it reads as a movement that was skipped, which isn't what
 * happened.
 */
export async function moveCompletedSet(
  workoutId: string,
  setId: string,
  toExerciseId: string,
): Promise<EditResult> {
  return db.transaction(async (tx) => {
    const [found] = (
      await tx.execute(sql`
        SELECT ws.id, ws.workout_exercise_id AS "fromEntryId", ws.logical_set_id AS "logicalSetId",
               we.exercise_id AS "fromExerciseId"
          FROM workout_sets ws
          JOIN workout_exercises we ON we.id = ws.workout_exercise_id
          JOIN workouts w ON w.id = we.workout_id
         WHERE ws.id = ${setId}
           AND w.id = ${workoutId}
           AND w.status = 'completed'
         LIMIT 1
      `)
    ).rows as unknown as Array<{
      fromEntryId: string
      logicalSetId: string | null
      fromExerciseId: string
    }>

    if (!found) {
      return { ok: false, changed: 0, error: 'That set is not in this completed session.' }
    }
    if (found.fromExerciseId === toExerciseId) {
      return { ok: false, changed: 0, error: 'That set is already on that exercise.' }
    }

    const [existing] = (
      await tx.execute(sql`
        SELECT id FROM workout_exercises
         WHERE workout_id = ${workoutId} AND exercise_id = ${toExerciseId}
         ORDER BY position LIMIT 1
      `)
    ).rows as unknown as Array<{ id: string }>

    let toEntryId = existing?.id
    if (!toEntryId) {
      const [created] = (
        await tx.execute(sql`
          INSERT INTO workout_exercises (workout_id, exercise_id, position, section)
          SELECT ${workoutId}, ${toExerciseId}, COALESCE(max(position), 0) + 1, 'main'
            FROM workout_exercises WHERE workout_id = ${workoutId}
          RETURNING id
        `)
      ).rows as unknown as Array<{ id: string }>
      toEntryId = created!.id
    }

    // Both halves of a split L/R round travel together; an unsplit set moves
    // alone. `logical_set_id` is the only thing tying the pair.
    const selector = found.logicalSetId
      ? sql`logical_set_id = ${found.logicalSetId} AND workout_exercise_id = ${found.fromEntryId}`
      : sql`id = ${setId}`

    // Read the destination's next number first rather than splicing a
    // subquery into the UPDATE: both halves of an L/R round must land on the
    // SAME number (the 1L/1R convention), which a correlated subquery
    // evaluated per row would not guarantee.
    const [tail] = (
      await tx.execute(sql`
        SELECT COALESCE(max(set_number), 0) + 1 AS "next"
          FROM workout_sets WHERE workout_exercise_id = ${toEntryId}
      `)
    ).rows as unknown as Array<{ next: number }>

    const res = await tx.execute(sql`
      UPDATE workout_sets
         SET workout_exercise_id = ${toEntryId}, set_number = ${tail!.next}
       WHERE ${selector}
    `)
    const changed = res.rowCount ?? 0

    await tx.execute(sql`
      DELETE FROM workout_exercises we
       WHERE we.id = ${found.fromEntryId}
         AND NOT EXISTS (SELECT 1 FROM workout_sets s WHERE s.workout_exercise_id = we.id)
    `)

    return { ok: true, changed }
  })
}
