import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import {
  ActiveWorkoutRevisionConflictError,
  upsertSets,
  type SetUpsertInput,
} from '@/lib/gym/active-workout'
import { onSetsCompleted } from '@/lib/gym/push'

/**
 * PUT /api/gym/workouts/[id]/sets — the optimistic write queue's landing zone
 * (GYM_PLAN §2.4, §4).
 *
 *   body {
 *     sets?: [{ clientSetId (uuid, REQUIRED), workoutExerciseId, setNumber,
 *               setType?, weight?, weightUnit?, reps?, distanceM?, durationS?,
 *               rpe?, restSeconds?, completed }],
 *     deleteClientSetIds?: [uuid]
 *   }
 *   → 200 { byExercise: { [workoutExerciseId]: ActiveSet[] } } — canonical sets
 *          for every touched exercise.
 *   → 409 when the workout isn't 'active' (a finished workout's sets are edited
 *          via a future history-edit path, not this one) OR a set references a
 *          workoutExerciseId that doesn't belong to this workout.
 *
 * IDEMPOTENT: keys on client_set_id (ON CONFLICT DO UPDATE), so replaying the same
 * payload yields the same rows. Authed + ensureGymSchema() first.
 */

interface RawSet {
  clientSetId?: unknown
  logicalSetId?: unknown
  workoutExerciseId?: unknown
  setNumber?: unknown
  setType?: unknown
  weight?: unknown
  weightUnit?: unknown
  reps?: unknown
  distanceM?: unknown
  durationS?: unknown
  rpe?: unknown
  restSeconds?: unknown
  side?: unknown
  completed?: unknown
}

const UNITS = new Set(['lb', 'kg'])
const SET_TYPES = new Set(['warmup', 'normal', 'drop', 'failure'])
const SIDES = new Set(['left', 'right'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Parse + validate one raw set, or null if it's structurally invalid. */
function parseSet(raw: RawSet): SetUpsertInput | null {
  if (typeof raw.clientSetId !== 'string' || !raw.clientSetId) return null
  if (typeof raw.workoutExerciseId !== 'string' || !raw.workoutExerciseId) return null
  if (typeof raw.setNumber !== 'number' || !Number.isFinite(raw.setNumber)) return null

  const out: SetUpsertInput = {
    clientSetId: raw.clientSetId,
    workoutExerciseId: raw.workoutExerciseId,
    setNumber: raw.setNumber,
  }
  if (raw.logicalSetId !== undefined) {
    if (typeof raw.logicalSetId !== 'string' || !UUID.test(raw.logicalSetId)) return null
    out.logicalSetId = raw.logicalSetId
  }
  if (typeof raw.setType === 'string' && SET_TYPES.has(raw.setType)) out.setType = raw.setType
  if (raw.weight === null || typeof raw.weight === 'number') out.weight = raw.weight as number | null
  if (typeof raw.weightUnit === 'string' && UNITS.has(raw.weightUnit)) out.weightUnit = raw.weightUnit
  if (raw.reps === null || typeof raw.reps === 'number') out.reps = raw.reps as number | null
  if (raw.distanceM === null || typeof raw.distanceM === 'number') {
    out.distanceM = raw.distanceM as number | null
  }
  if (raw.durationS === null || typeof raw.durationS === 'number') {
    out.durationS = raw.durationS as number | null
  }
  if (raw.rpe === null || typeof raw.rpe === 'number') out.rpe = raw.rpe as number | null
  if (raw.restSeconds !== undefined) {
    if (
      raw.restSeconds !== null &&
      (typeof raw.restSeconds !== 'number' ||
        !Number.isFinite(raw.restSeconds) ||
        raw.restSeconds < 0 ||
        raw.restSeconds > 3600)
    ) {
      return null
    }
    out.restSeconds = raw.restSeconds as number | null
  }
  // Per-side hold marker (§10b.2): only 'left'/'right' pass; anything else → null.
  if (raw.side === null || (typeof raw.side === 'string' && SIDES.has(raw.side))) {
    out.side = raw.side as string | null
  }
  if (typeof raw.completed === 'boolean') out.completed = raw.completed
  return out
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const b = body as { sets?: unknown; deleteClientSetIds?: unknown; expectedRevision?: unknown }
  if (!Number.isInteger(b.expectedRevision) || (b.expectedRevision as number) < 0) {
    return NextResponse.json({ error: 'expectedRevision must be a non-negative integer' }, { status: 400 })
  }

  const rawSets = Array.isArray(b.sets) ? (b.sets as RawSet[]) : []
  const parsed: SetUpsertInput[] = []
  for (const raw of rawSets) {
    const s = parseSet(raw)
    if (!s) return NextResponse.json({ error: 'Invalid set in payload' }, { status: 400 })
    parsed.push(s)
  }
  const deletes = Array.isArray(b.deleteClientSetIds)
    ? (b.deleteClientSetIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : []

  try {
    await ensureGymSchema()
    const result = await upsertSets(id, parsed, b.expectedRevision as number, deletes)
    if (!result) {
      return NextResponse.json({ error: 'Workout is not active' }, { status: 409 })
    }
    // Web Push rest-timer hook (GYM_PLAN §2.7b): if any set in this batch flipped
    // to completed, (re)schedule the locked-phone rest ping off the latest one.
    // Detached + fail-open — a push error can never affect the write above.
    // Gate on newlyCompletedClientSetIds (not just input.completed === true): the
    // optimistic client resends an exercise's FULL set array on ANY edit, so an
    // unrelated change (a new not-yet-started set, a rest-value tweak) re-sends
    // every already-completed sibling alongside it — those must NOT re-trigger
    // the "just completed" ping (#1836).
    const newlyCompleted = new Set(result.newlyCompletedClientSetIds)
    const completedExerciseIds = parsed
      .filter((input) => {
        if (!newlyCompleted.has(input.clientSetId)) return false
        const canonical = result.byExercise[input.workoutExerciseId] ?? []
        const row = canonical.find((set) => set.clientSetId === input.clientSetId)
        if (!row) return false
        const logicalGroup = canonical.filter((set) => set.logicalSetId === row.logicalSetId)
        return logicalGroup.length > 0 && logicalGroup.every((set) => set.completed)
      })
      .map((s) => s.workoutExerciseId)
    if (completedExerciseIds.length > 0) {
      void onSetsCompleted(id, completedExerciseIds)
    }
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof ActiveWorkoutRevisionConflictError) {
      return NextResponse.json(
        { error: 'Workout changed since it was loaded', code: err.code },
        { status: 409 },
      )
    }
    console.error('[gym/workouts/:id/sets] PUT failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to save sets' }, { status: 500 })
  }
}
