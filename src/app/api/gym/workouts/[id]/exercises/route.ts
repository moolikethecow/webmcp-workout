import { NextResponse, type NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'

import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import {
  ActiveWorkoutPerformedSetsConflictError,
  ActiveWorkoutRevisionConflictError,
  editExercises,
  type ExerciseEdits,
} from '@/lib/gym/active-workout'
import { assembleCoachContext } from '@/lib/gym/coach-context'
import { alternativesForProfile } from '@/lib/gym/novelty'
import { sourceProfile } from '@/lib/gym/source-profile'
import { setExerciseGripById } from '@/lib/gym/grip-write'
import { isAttachment, isGripOrientation, isGripWidth } from '@/lib/gym/grip'

/**
 * POST /api/gym/workouts/[id]/exercises — edit an active workout's exercise list
 * (GYM_PLAN §4). Any-of the following keys, applied in a single call:
 *
 *   {
 *     add?:      [{ exerciseId, position? }],
 *     remove?:   [workoutExerciseId],
 *     reorder?:  [{ workoutExerciseId, position }],
 *     superset?: [{ workoutExerciseId, group }],   // group null clears
 *     replace?:  [{ workoutExerciseId, newExerciseId, keepPrescription? }],
 *     rest?:     [{ workoutExerciseId, seconds, warmupSeconds? }],
 *     notes?:    [{ workoutExerciseId, notes, applyToTemplate? }]  // null/'' clears
 *     grip?:     [{ workoutExerciseId, gripWidth?, gripOrientation?, attachment? }]
 *                // how it is being held; null clears a field. Applied through
 *                // setExerciseGripById rather than editExercises, because grip
 *                // is an annotation and that path rebuilds the set list.
 *   }
 *   → 200 ActiveWorkout (updated)
 *   → 409 when the workout isn't 'active'
 *
 * REPLACE keeps position + superset but DELETES the old exercise's sets and
 * recomputes targets/previous for the new exercise — unless `keepPrescription`
 * is set, which carries the old target forward as the new exercise's ghost
 * target instead (#1876). Authed + ensureGymSchema().
 */

/** A per-exercise cue, not an essay — bound the column at the edge. */
const NOTES_MAX_CHARS = 2000
/** Matches the swap sheet's default suggestion count (GET .../alternatives'
 *  DEFAULT_N) — the #1876 metric asks "was the pick among what the sheet would
 *  have actually offered", so it must rank the same top-N. */
const SUGGESTION_N = 8

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** The pre-edit exercise_id for each workoutExerciseId about to be replaced —
 *  read BEFORE `editExercises` overwrites it, so the #1876 chosen-vs-suggested
 *  metric can recompute the suggestions the swap sheet would have shown for the
 *  exercise that just left. A workoutExerciseId not found in this workout is
 *  silently dropped (defensive; editExercises' own scoping is what actually
 *  guards the write). */
async function currentExerciseIds(
  workoutId: string,
  replace: Array<{ workoutExerciseId: string; newExerciseId: string }>,
): Promise<Array<{ workoutExerciseId: string; oldExerciseId: string; newExerciseId: string }>> {
  if (replace.length === 0) return []
  try {
    const ids = replace.map((r) => r.workoutExerciseId)
    const rows = (
      await db.execute(sql`
        SELECT id::text AS id, exercise_id::text AS exercise_id
        FROM workout_exercises
        WHERE workout_id = ${workoutId} AND id = ANY(${ids})
      `)
    ).rows as unknown as Array<{ id: string; exercise_id: string }>
    const oldExerciseIdByWe = new Map(rows.map((r) => [r.id, r.exercise_id]))
    return replace
      .map((r) => {
        const oldExerciseId = oldExerciseIdByWe.get(r.workoutExerciseId)
        return oldExerciseId ? { workoutExerciseId: r.workoutExerciseId, oldExerciseId, newExerciseId: r.newExerciseId } : null
      })
      .filter((r): r is { workoutExerciseId: string; oldExerciseId: string; newExerciseId: string } => r != null)
  } catch (err) {
    // Fail-open (#1876 metric-only): a snapshot miss must never block a replace.
    console.warn(
      '[gym/workouts/:id/exercises] chosen-vs-suggested snapshot failed:',
      err instanceof Error ? err.message : err,
    )
    return []
  }
}

/**
 * #1876 "chosen-vs-suggested" metric: after a replace SUCCEEDS, log whether the
 * picked exercise was among the deterministic alternatives the swap sheet would
 * have offered for the exercise it replaced ("after three replacements this
 * session the user picked a non-suggested exercise every time" — worth measuring
 * rather than guessing at). Recomputes the SAME ranking the GET alternatives
 * route serves. Fire-and-forget + fail-open: a logging miss must never surface
 * as a replace failure.
 */
async function logChosenVsSuggested(
  workoutId: string,
  replacements: Array<{ workoutExerciseId: string; oldExerciseId: string; newExerciseId: string }>,
): Promise<void> {
  try {
    const ctx = await assembleCoachContext()
    for (const r of replacements) {
      const profile = await sourceProfile(r.oldExerciseId)
      const suggested = alternativesForProfile(ctx.pools, profile, r.oldExerciseId, SUGGESTION_N)
      console.info('[gym.replace] chosen-vs-suggested', {
        workoutId,
        workoutExerciseId: r.workoutExerciseId,
        oldExerciseId: r.oldExerciseId,
        newExerciseId: r.newExerciseId,
        wasSuggested: suggested.some((a) => a.id === r.newExerciseId),
        suggestedCount: suggested.length,
      })
    }
  } catch (err) {
    console.warn(
      '[gym/workouts/:id/exercises] chosen-vs-suggested logging failed:',
      err instanceof Error ? err.message : err,
    )
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const b = body as Record<string, unknown>
  if (!Number.isInteger(b.expectedRevision) || (b.expectedRevision as number) < 0) {
    return NextResponse.json({ error: 'expectedRevision must be a non-negative integer' }, { status: 400 })
  }

  const edits: ExerciseEdits = {}

  if (Array.isArray(b.add)) {
    edits.add = (b.add as Array<Record<string, unknown>>)
      .filter((a) => typeof a.exerciseId === 'string')
      .map((a) => ({
        exerciseId: a.exerciseId as string,
        position: typeof a.position === 'number' ? a.position : undefined,
      }))
  }
  if (b.remove !== undefined) edits.remove = asStringArray(b.remove)
  if (Array.isArray(b.reorder)) {
    edits.reorder = (b.reorder as Array<Record<string, unknown>>)
      .filter((o) => typeof o.workoutExerciseId === 'string' && typeof o.position === 'number')
      .map((o) => ({ workoutExerciseId: o.workoutExerciseId as string, position: o.position as number }))
  }
  if (Array.isArray(b.superset)) {
    edits.superset = (b.superset as Array<Record<string, unknown>>)
      .filter((s) => typeof s.workoutExerciseId === 'string')
      .map((s) => ({
        workoutExerciseId: s.workoutExerciseId as string,
        group: typeof s.group === 'number' ? s.group : null,
      }))
  }
  if (Array.isArray(b.replace)) {
    edits.replace = (b.replace as Array<Record<string, unknown>>)
      .filter((r) => typeof r.workoutExerciseId === 'string' && typeof r.newExerciseId === 'string')
      .map((r) => ({
        workoutExerciseId: r.workoutExerciseId as string,
        newExerciseId: r.newExerciseId as string,
        keepPrescription: r.keepPrescription === true,
      }))
  }
  if (Array.isArray(b.rest)) {
    edits.rest = (b.rest as Array<Record<string, unknown>>)
      .filter((r) => {
        if (typeof r.workoutExerciseId !== 'string') return false
        if (!isRestSeconds(r.seconds)) return false
        return r.warmupSeconds === undefined || isRestSeconds(r.warmupSeconds)
      })
      .map((r) => ({
        workoutExerciseId: r.workoutExerciseId as string,
        seconds: r.seconds as number | null,
        warmupSeconds:
          r.warmupSeconds === undefined ? undefined : (r.warmupSeconds as number | null),
      }))
  }

  if (Array.isArray(b.notes)) {
    edits.notes = (b.notes as Array<Record<string, unknown>>)
      .filter((n) => typeof n.workoutExerciseId === 'string' && (n.notes === null || typeof n.notes === 'string'))
      .map((n) => ({
        workoutExerciseId: n.workoutExerciseId as string,
        notes: (n.notes as string | null)?.slice(0, NOTES_MAX_CHARS) ?? null,
        applyToTemplate: n.applyToTemplate === true,
      }))
  }

  // Grip is applied BEFORE the structural edits and NOT through editExercises:
  // that path rebuilds an exercise's set list from a payload, which is the wrong
  // shape for an annotation. Running first means the ActiveWorkout returned
  // below already reflects it, so the client needs no second round trip.
  const gripEdits = Array.isArray(b.grip)
    ? (b.grip as Array<Record<string, unknown>>).filter(
        (g) => typeof g.workoutExerciseId === 'string',
      )
    : []

  try {
    await ensureGymSchema()
    for (const g of gripEdits) {
      // `undefined` leaves a field alone; an explicit null clears it, which on
      // an exercise means "no grip recorded" and is a real thing to want.
      const patch: Parameters<typeof setExerciseGripById>[2] = {}
      if ('gripWidth' in g) patch.gripWidth = isGripWidth(g.gripWidth) ? g.gripWidth : null
      if ('gripOrientation' in g) {
        patch.gripOrientation = isGripOrientation(g.gripOrientation) ? g.gripOrientation : null
      }
      if ('attachment' in g) patch.attachment = isAttachment(g.attachment) ? g.attachment : null
      if (Object.keys(patch).length > 0) {
        await setExerciseGripById(id, g.workoutExerciseId as string, patch)
      }
    }
    // #1876: snapshot the pre-edit exercise_id BEFORE editExercises overwrites
    // it, so a successful replace can log chosen-vs-suggested against what the
    // exercise being REPLACED would have offered.
    const previousReplacements = await currentExerciseIds(id, edits.replace ?? [])
    const workout = await editExercises(id, edits, b.expectedRevision as number)
    if (!workout) return NextResponse.json({ error: 'Workout is not active' }, { status: 409 })
    if (previousReplacements.length > 0) void logChosenVsSuggested(id, previousReplacements)
    return NextResponse.json(workout)
  } catch (err) {
    if (err instanceof ActiveWorkoutPerformedSetsConflictError) {
      return NextResponse.json(
        {
          error: err.message,
          code: err.code,
          workoutExerciseId: err.workoutExerciseId,
          operation: err.operation,
        },
        { status: 409 },
      )
    }
    if (err instanceof ActiveWorkoutRevisionConflictError) {
      return NextResponse.json(
        { error: 'Workout changed since it was loaded', code: err.code },
        { status: 409 },
      )
    }
    console.error('[gym/workouts/:id/exercises] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to edit exercises' }, { status: 500 })
  }
}

function isRestSeconds(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3600)
  )
}
