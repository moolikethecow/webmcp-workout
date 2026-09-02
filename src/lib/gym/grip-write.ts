/**
 * Recording how a movement was held — on a whole exercise, or on one set.
 *
 * Deliberately NOT threaded through `editExercises`: that path rebuilds an
 * exercise's entire set list from a payload, which is the right shape for
 * changing the programming and the wrong shape for annotating what already
 * happened. Grip is an annotation. Keying these writes on
 * (workout, exercise name) instead lets the live logger and the
 * completed-session editor share one implementation, and keeps a grip change
 * from being able to disturb a single logged number.
 *
 * Both writers PATCH: a field left `undefined` is untouched, an explicit `null`
 * clears it. Clearing matters — on a SET, null means "inherit from the
 * exercise" (see `resolveGrip`), so being unable to clear would make a
 * mis-tapped override permanent.
 */
import { sql, type SQL } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { normalizeExerciseName, normalizedNameSql } from '@/lib/fitness/exercise-name'
import { type Attachment, type GripOrientation, type GripWidth } from './grip'

export interface GripPatch {
  gripWidth?: GripWidth | null
  gripOrientation?: GripOrientation | null
  attachment?: Attachment | null
}

export interface GripWriteResult {
  ok: boolean
  changed: number
  error?: string
}

/** The SET clauses for whichever fields the caller actually passed. */
function assignments(patch: GripPatch): SQL[] {
  const out: SQL[] = []
  if ('gripWidth' in patch) out.push(sql`grip_width = ${patch.gripWidth ?? null}`)
  if ('gripOrientation' in patch) {
    out.push(sql`grip_orientation = ${patch.gripOrientation ?? null}`)
  }
  if ('attachment' in patch) out.push(sql`attachment = ${patch.attachment ?? null}`)
  return out
}

const NOTHING_TO_SET =
  'Pass at least one of grip_width, grip_orientation, attachment.'

/**
 * Set the grip on an exercise within a workout — the session default that every
 * set inherits from.
 *
 * Scoped to the workout by a join, so a wrong id cannot reach another session.
 * Works on a running workout and a completed one alike: annotating what you
 * just did and correcting what you did last week are the same operation, and
 * splitting them would mean two implementations that could disagree.
 */
export async function setExerciseGrip(
  workoutId: string,
  exerciseName: string,
  patch: GripPatch,
): Promise<GripWriteResult> {
  const sets = assignments(patch)
  if (sets.length === 0) return { ok: false, changed: 0, error: NOTHING_TO_SET }

  const res = await db.execute(sql`
    UPDATE workout_exercises we
       SET ${sql.join(sets, sql`, `)}
      FROM exercises e
     WHERE we.exercise_id = e.id
       AND we.workout_id = ${workoutId}
       AND ${normalizedNameSql('e.name')} = ${normalizeExerciseName(exerciseName)}
  `)
  const changed = res.rowCount ?? 0
  return changed > 0
    ? { ok: true, changed }
    : { ok: false, changed: 0, error: `"${exerciseName}" is not in that workout.` }
}

/**
 * Same as `setExerciseGrip`, keyed by the workout_exercise id the UI already
 * holds — the logger has the row, not the name, and re-resolving a name it
 * never needed would be a second chance to pick the wrong exercise.
 */
export async function setExerciseGripById(
  workoutId: string,
  workoutExerciseId: string,
  patch: GripPatch,
): Promise<GripWriteResult> {
  const sets = assignments(patch)
  if (sets.length === 0) return { ok: false, changed: 0, error: NOTHING_TO_SET }

  const res = await db.execute(sql`
    UPDATE workout_exercises
       SET ${sql.join(sets, sql`, `)}
     WHERE id = ${workoutExerciseId} AND workout_id = ${workoutId}
  `)
  const changed = res.rowCount ?? 0
  return changed > 0
    ? { ok: true, changed }
    : { ok: false, changed: 0, error: 'That exercise is not in that workout.' }
}

/**
 * Set the grip on ONE logged set — the per-set override.
 *
 * Clearing a field here restores inheritance from the exercise rather than
 * recording "no grip", which is why the patch distinguishes an omitted key from
 * an explicit null.
 */
export async function setSetGrip(
  workoutId: string,
  setId: string,
  patch: GripPatch,
): Promise<GripWriteResult> {
  const sets = assignments(patch)
  if (sets.length === 0) return { ok: false, changed: 0, error: NOTHING_TO_SET }

  const res = await db.execute(sql`
    UPDATE workout_sets ws
       SET ${sql.join(sets, sql`, `)}
      FROM workout_exercises we
     WHERE ws.workout_exercise_id = we.id
       AND ws.id = ${setId}
       AND we.workout_id = ${workoutId}
  `)
  const changed = res.rowCount ?? 0
  return changed > 0
    ? { ok: true, changed }
    : { ok: false, changed: 0, error: 'That set is not in that workout.' }
}

/**
 * Carry a template's prescribed grip onto the session when a workout starts.
 *
 * Only fills exercises whose session grip is still empty, so a mid-session
 * change is never overwritten by a later call.
 */
export async function inheritTemplateGrip(workoutId: string, templateId: string): Promise<number> {
  const res = await db.execute(sql`
    UPDATE workout_exercises we
       SET grip_width = te.grip_width,
           grip_orientation = te.grip_orientation,
           attachment = te.attachment
      FROM template_exercises te
     WHERE te.template_id = ${templateId}
       AND te.exercise_id = we.exercise_id
       AND we.workout_id = ${workoutId}
       AND we.grip_width IS NULL
       AND we.grip_orientation IS NULL
       AND we.attachment IS NULL
       AND (te.grip_width IS NOT NULL OR te.grip_orientation IS NOT NULL OR te.attachment IS NOT NULL)
  `)
  return res.rowCount ?? 0
}
