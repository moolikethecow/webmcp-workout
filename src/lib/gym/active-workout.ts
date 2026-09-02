/**
 * Active-workout read/write model (GYM_PLAN §2.4, §4, P2a). The DB glue behind
 * the live-logging routes: start a session, load the ActiveWorkout read model,
 * idempotently upsert sets (the optimistic write queue's landing zone), and edit
 * the exercise list. All writes are guarded so a status transition that races
 * loses honestly (rowcount guards → 404/409), and the set upsert keys on the
 * client-generated `client_set_id` so replaying the same batch is a no-op.
 *
 * The PROGRESSION ghosts + the "previous session" column come from the pure
 * engine (progression.ts) + a per-exercise last-completed-session read; this file
 * assembles them into the contract the logger UI consumes verbatim.
 */
import { randomUUID } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { cancelPushForWorkout } from '@/lib/gym/push'
import { isDistanceUnit, type DistanceUnit } from '@/lib/units/system'
import { isActiveWorkoutSingletonViolation } from './active-conflict'
import { displayExerciseName } from './display-name'
import {
  dominantUnit,
  evaluateProgression,
  type Session,
  type SessionHistory,
  type TargetSet,
  type Unit,
} from './progression'
import {
  detrainingSignal,
  deloadedTargetLb,
  type DetrainingSignal,
} from './detraining'
import {
  loadRegionIndex,
  readDetrainingMarks,
  readRegionMarks,
} from './programming-history'
import { listInjuries } from './injuries-gyms'
import { inheritTemplateGrip } from './grip-write'
import { EMPTY_GRIP, gripLabel, toGripSpec, type GripSpec } from './grip'
import {
  exerciseAllowedWithInjuries,
  parseExerciseInjuryProfile,
  type InjuryConstraint,
} from './injury-profile'

// ---------------------------------------------------------------------------
// The ActiveWorkout contract (consumed verbatim by the logger UI agents)
// ---------------------------------------------------------------------------

export interface ActiveSet {
  clientSetId: string | null
  /** Stable logical round id. Split L/R rows share one id. */
  logicalSetId: string
  setNumber: number
  setType: string
  weight: number | null
  weightUnit: string
  reps: number | null
  distanceM: number | null
  durationS: number | null
  rpe: number | null
  /** Rest after this exact set; null → exercise warmup/working fallback. */
  restSeconds?: number | null
  /** Which side a per-side hold worked (§10b.2): 'left' | 'right' | null. */
  side: 'left' | 'right' | null
  completed: boolean
}

export interface PreviousSet {
  setNumber: number
  /** Present on current read models; optional only for old cached/test payloads. */
  setType?: string
  weight: number | null
  unit: string
  reps: number | null
  durationS: number | null
  distanceM: number | null
  side?: 'left' | 'right' | null
  logicalSetId?: string
}

export interface TargetSetOut {
  setNumber?: number
  setType?: string
  weight?: number
  weightUnit?: Unit
  reps?: number
  distanceM?: number
  durationS?: number
  rpe?: number
  restSeconds?: number
  side?: 'left' | 'right' | null
  logicalSetId?: string
  source?: PrescriptionSource
}

export interface ActiveExercise {
  workoutExerciseId: string
  exerciseId: string
  name: string
  tracks: string
  /** Programming axis (§10b.1) — the player + logger read it for mobility UX. */
  modality: string
  /** Unilateral hold: the logger renders L/R set pairs (§10b.2). */
  perSide: boolean
  /** How load is authored for strength work: whole implement/body vs each arm/leg. */
  loadBasis: 'total' | 'per_side'
  /** Block role (§10b.3): 'warmup' | 'main' | 'cooldown'. */
  section: string
  position: number
  supersetGroup: number | null
  restSeconds: number
  /** Warm-up rest after exercise/session fallbacks resolve. */
  restSecondsWarmup?: number
  preferredUnit: string
  notes: string | null
  targets: TargetSetOut[]
  ruleText: string
  previous: PreviousSet[]
  sets: ActiveSet[]
  /**
   * How this exercise is being held in THIS session. Each set inherits any
   * field it does not set itself, so the logger can show one control for the
   * exercise rather than repeating it on every row.
   */
  grip: GripSpec
}

export interface ActiveWorkout {
  /** What the start path changed or flagged; null once restored/dismissed. */
  startNotices?: StartNotices | null
  id: string
  /** Optimistic generation shared by logger writes and agent edits. */
  revision: number
  name: string | null
  status: string
  startedAt: string
  templateId: string | null
  templateName: string | null
  /** Effective gym load unit at read time (gym override, then app setting). */
  weightUnit?: Unit
  /** Effective gym distance input/display unit; storage remains metres. */
  distanceUnit?: DistanceUnit
  exercises: ActiveExercise[]
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Rest-seconds fallback when nothing else resolves (last resort in the chain). */
const HARD_DEFAULT_REST = 120
/** How many prior completed sessions of an exercise the engine sees. */
const PROGRESSION_HISTORY_SESSIONS = 8

export type PrescriptionSource =
  | 'template'
  | 'progression'
  | 'repeat'
  | 'proposal'
  | 'agent'
  /** Weight computed by the return-to-training ramp (#1790), not by a
   *  progression policy. Distinct so the provenance never lies about which
   *  engine chose the load. */
  | 'detraining'
  /** Carried over from the exercise just replaced (#1876 "keep the prescribed
   *  load/reps as your target?"). Distinct from 'template' — this target was
   *  authored for a DIFFERENT movement and just happens to still apply. */
  | 'replacement'

/** One immutable planned set snapshot. Actual performance lands in the ordinary
 * workout_sets fields; these values land in prescribed_* so a miss/edit never
 * rewrites what the plan asked for. */
export interface SetPrescriptionInput {
  setNumber: number
  setType?: 'warmup' | 'normal' | 'drop' | 'failure'
  weight?: number | null
  weightUnit?: Unit
  reps?: number | null
  distanceM?: number | null
  durationS?: number | null
  rpe?: number | null
  restSeconds?: number | null
  side?: 'left' | 'right' | null
  logicalSetId?: string
  source: PrescriptionSource
}

/** Small executor seam so callers already inside a transaction (notably proposal
 * Start) can materialize prescriptions atomically. Pass `q => tx.execute(q)`;
 * normal callers pass `q => db.execute(q)`. */
export type GymSqlExecute = (query: SQL) => Promise<unknown>

/** Materialize ordered planned sets as incomplete workout_sets rows. The stable
 * client UUIDs mean the logger can edit/complete them immediately; prescribed_*
 * remains the immutable start-time target. Existing rows at those set numbers are
 * replaced only when still incomplete, making an explicit re-materialization
 * deterministic without touching performed work. */
export async function materializeSetPrescriptions(
  execute: GymSqlExecute,
  workoutExerciseId: string,
  sets: SetPrescriptionInput[],
): Promise<void> {
  const ordered = assignLogicalSetIds(
    [...sets]
      .filter((set) => Number.isInteger(set.setNumber) && set.setNumber > 0)
      .sort((a, b) => a.setNumber - b.setNumber),
  )

  await execute(sql`
    DELETE FROM workout_sets
    WHERE workout_exercise_id = ${workoutExerciseId} AND completed = false
  `)

  for (const set of ordered) {
    const setType = set.setType ?? 'normal'
    const side = set.side === 'left' || set.side === 'right' ? set.side : null
    await execute(sql`
      INSERT INTO workout_sets (
        workout_exercise_id, set_number, set_type,
        weight, weight_unit, reps, distance_m, duration_s, rpe,
        prescribed_weight, prescribed_weight_unit, prescribed_reps,
        prescribed_distance_m, prescribed_duration_s, prescribed_rpe,
        rest_seconds, prescription_source, side, logical_set_id, completed, client_set_id
      ) VALUES (
        ${workoutExerciseId}, ${set.setNumber}, ${setType},
        NULL, ${set.weightUnit ?? 'lb'}, NULL, NULL, NULL, NULL,
        ${set.weight ?? null}, ${set.weightUnit ?? 'lb'}, ${set.reps ?? null},
        ${set.distanceM ?? null}, ${set.durationS ?? null}, ${set.rpe ?? null},
        ${set.restSeconds ?? null}, ${set.source}, ${side}, ${set.logicalSetId}, false, gen_random_uuid()
      )
    `)
  }
}

/** Give every physical row a logical round id. Adjacent opposite-side rows are one
 * round; bilateral/one-sided rows each get their own. Explicit ids always win. */
function assignLogicalSetIds<T extends { side?: 'left' | 'right' | null; setType?: string; logicalSetId?: string }>(
  sets: T[],
): Array<T & { logicalSetId: string }> {
  const out: Array<T & { logicalSetId: string }> = []
  for (let index = 0; index < sets.length; index += 1) {
    const current = sets[index]!
    if (current.logicalSetId) {
      out.push({ ...current, logicalSetId: current.logicalSetId })
      continue
    }
    const id = randomUUID()
    out.push({ ...current, logicalSetId: id })
    const next = sets[index + 1]
    if (
      next &&
      !next.logicalSetId &&
      current.side != null &&
      next.side != null &&
      current.side !== next.side &&
      (current.setType ?? 'normal') === (next.setType ?? 'normal')
    ) {
      out.push({ ...next, logicalSetId: id })
      index += 1
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export type StartFrom = 'template' | 'empty' | 'repeat_last' | 'workout'

export interface StartResult {
  /** The freshly created ActiveWorkout, when we created one. */
  workout?: ActiveWorkout
  /** Set when an active workout already exists — the UI offers resume/discard. */
  conflictActiveWorkoutId?: string
}

/**
 * Start a new active workout. Guard: at most ONE active workout at a time — if one
 * exists, returns { conflictActiveWorkoutId } (the route 409s) instead of creating
 * a second. No sets rows are pre-created; planned sets stay virtual (the UI
 * materializes them via PUT /sets). `from`:
 *   - 'template'    → workout_exercises copied from the template (position,
 *                     superset_group, rest_seconds).
 *   - 'repeat_last' → copies the exercises of the most recent completed session.
 *   - 'workout'     → copies the exercises of a SPECIFIC completed session
 *                     (History-tab "Repeat" — same mechanics as repeat_last but for
 *                     an explicit `sourceWorkoutId`).
 *   - 'empty'       → no exercises.
 */
export async function startWorkout(
  from: StartFrom,
  templateId?: string,
  sourceWorkoutId?: string,
): Promise<StartResult> {
  const existing = await activeWorkoutId()
  if (existing) return { conflictActiveWorkoutId: existing }

  // Resolve template name for the workout name when starting from one.
  let name: string | null = null
  let resolvedTemplateId: string | null = null
  let resolvedSourceWorkoutId: string | null = null
  if (from === 'template') {
    if (!templateId) throw new Error('templateId required when from=template')
    const [tpl] = (
      await db.execute(sql`SELECT id, name FROM workout_templates WHERE id = ${templateId} AND archived_at IS NULL LIMIT 1`)
    ).rows as unknown as { id: string; name: string }[]
    if (!tpl) throw new Error('template not found')
    name = tpl.name
    resolvedTemplateId = tpl.id
  } else if (from === 'repeat_last') {
    const [last] = (
      await db.execute(
        sql`SELECT id, name, template_id FROM workouts WHERE status = 'completed' ORDER BY started_at DESC LIMIT 1`,
      )
    ).rows as unknown as { id: string; name: string | null; template_id: string | null }[]
    if (last) {
      name = last.name
      resolvedTemplateId = last.template_id
      resolvedSourceWorkoutId = last.id
    }
  } else if (from === 'workout') {
    if (!sourceWorkoutId) throw new Error('sourceWorkoutId required when from=workout')
    const [src] = (
      await db.execute(
        sql`SELECT id, name, template_id FROM workouts WHERE id = ${sourceWorkoutId} AND status = 'completed' LIMIT 1`,
      )
    ).rows as unknown as { id: string; name: string | null; template_id: string | null }[]
    if (!src) throw new Error('workout not found')
    name = src.name
    resolvedTemplateId = src.template_id
    resolvedSourceWorkoutId = src.id
  }

  let workoutId: string
  try {
    const [created] = (
      await db.execute(sql`
        INSERT INTO workouts (name, template_id, started_at, status, source)
        VALUES (${name}, ${resolvedTemplateId}, now(), 'active', 'app')
        RETURNING id
      `)
    ).rows as unknown as { id: string }[]
    if (!created) throw new Error('Failed to create active workout')
    workoutId = created.id
  } catch (error) {
    if (!isActiveWorkoutSingletonViolation(error)) throw error
    const winner = await activeWorkoutId()
    if (!winner) throw error
    return { conflictActiveWorkoutId: winner }
  }

  try {
    if (from === 'template' && resolvedTemplateId) {
      await copyTemplateExercises(workoutId, resolvedTemplateId)
      // Carry the template's PRESCRIBED grip onto the session, so "do these on
      // the MAG handle" survives from the program into the logger. Only fills
      // exercises with no grip yet, so it can never overwrite a change made
      // during the session.
      await inheritTemplateGrip(workoutId, resolvedTemplateId)
    } else if ((from === 'repeat_last' || from === 'workout') && resolvedSourceWorkoutId) {
      await copyWorkoutExercises(workoutId, resolvedSourceWorkoutId)
    }

    const workout = await getActiveWorkoutById(workoutId)
    if (!workout) throw new Error('Started workout could not be reloaded')
    return { workout }
  } catch (error) {
    // The workout row is intentionally created before the copy/read work. If any
    // of that fails, remove only this still-active row so it cannot strand the
    // singleton and block every future start. Cascades clear partial children.
    try {
      await db.execute(sql`DELETE FROM workouts WHERE id = ${workoutId} AND status = 'active'`)
    } catch (cleanupError) {
      console.error(
        '[gym/active-workout] failed to clean up an incomplete workout start:',
        cleanupError instanceof Error ? cleanupError.message : cleanupError,
      )
    }
    throw error
  }
}

interface TemplateCopyRow {
  grip_width: string | null
  grip_orientation: string | null
  attachment: string | null
  template_exercise_id: string
  exercise_id: string
  exercise_name: string
  injury_profile: unknown
  injury_override: boolean
  position: number
  superset_group: number | null
  rest_seconds: number | null
  rest_seconds_warmup: number | null
  section: string
  notes: string | null
  target_sets: number | null
  target_reps: number | null
  target_weight: string | null
  target_weight_unit: string
  target_duration_s: number | null
  progression: unknown
  preferred_unit: string | null
  per_side: boolean
  load_basis: string
}

interface TemplateSetCopyRow {
  set_number: number
  set_type: string
  target_weight: string | null
  target_weight_unit: string
  target_reps: number | null
  target_distance_m: string | null
  target_duration_s: number | null
  target_rpe: string | null
  rest_seconds: number | null
  side: string | null
}

/** Copy a template's COMPLETE exercise/set prescription into a live workout.
 * Explicit progression policies are evaluated once here and snapshotted; a null
 * policy preserves the template's exact stored values. Legacy scalar target_*
 * slots are expanded when they predate template_sets. */
async function copyTemplateExercises(workoutId: string, templateId: string): Promise<void> {
  const rows = (
    await db.execute(sql`
      SELECT te.id AS template_exercise_id, te.exercise_id, te.position,
        te.superset_group,
        COALESCE(te.rest_seconds, e.default_rest_seconds) AS rest_seconds,
        COALESCE(te.rest_seconds_warmup, e.rest_seconds_warmup) AS rest_seconds_warmup,
        te.section, te.notes, te.target_sets, te.target_reps,
        te.target_weight::text AS target_weight, te.target_weight_unit,
        te.target_duration_s,
        -- exercise rule wins; template default fills rows that never authored
        -- one (#1790). COALESCE, so a bespoke rule is never overwritten.
        COALESCE(te.progression, t.progression) AS progression,
        e.preferred_unit, e.per_side, e.load_basis,
        e.name AS exercise_name, e.injury_profile, e.injury_override,
        te.grip_width, te.grip_orientation, te.attachment
      FROM template_exercises te
      JOIN workout_templates t ON t.id = te.template_id
      JOIN exercises e ON e.id = te.exercise_id
      WHERE te.template_id = ${templateId}
      ORDER BY te.position
    `)
  ).rows as unknown as TemplateCopyRow[]

  // Exercises whose prescribed grip has no history yet, so their numbers came
  // from a different handle. Surfaced rather than silently substituted.
  const gripFallbacks: Array<{ exercise: string; grip: string }> = []

  // Whole-catalog read: built ONCE per workout, not per exercise.
  const regionIndex = await loadRegionIndex()
  // ⚠️ startWorkout had NO injury awareness at all — plan.ts gates drafting on
  // exerciseAllowedWithInjuries, but starting a saved template handed over a
  // conflicting exercise silently. Same asymmetry as the detraining bug.
  const injuries: InjuryConstraint[] = (await listInjuries(true)).map((i) => ({
    region: i.region,
    severity: i.severity,
  })) as InjuryConstraint[]
  const notices: StartNotices = { eased: [], injuries: [] }

  for (const row of rows) {
    const [created] = (
      await db.execute(sql`
        INSERT INTO workout_exercises (
          workout_id, exercise_id, position, superset_group,
          rest_seconds, rest_seconds_warmup, section, notes
        ) VALUES (
          ${workoutId}, ${row.exercise_id}, ${row.position}, ${row.superset_group},
          ${row.rest_seconds}, ${row.rest_seconds_warmup}, ${row.section}, ${row.notes}
        )
        RETURNING id
      `)
    ).rows as unknown as Array<{ id: string }>
    if (!created) continue

    const stored = (
      await db.execute(sql`
        SELECT set_number, set_type, target_weight::text AS target_weight,
          target_weight_unit, target_reps,
          target_distance_m::text AS target_distance_m, target_duration_s,
          target_rpe::text AS target_rpe, rest_seconds, side
        FROM template_sets
        WHERE template_exercise_id = ${row.template_exercise_id}
        ORDER BY set_number
      `)
    ).rows as unknown as TemplateSetCopyRow[]

    let prescriptions =
      stored.length > 0
        ? stored.map(templateSetToPrescription)
        : legacyTemplatePrescriptions(row)

    const preferredUnit: Unit = row.preferred_unit === 'kg' ? 'kg' : 'lb'

    // #1790 — ask WHEN before asking what. A progression policy reads history
    // with no notion of elapsed time, so after a layoff the newest completed
    // session is a pre-break weight and the overlay rewrites a deliberate
    // restart load with it. Consult the re-entry signal FIRST.
    const detraining = detrainingSignal(
      {
        exercise: await readDetrainingMarks(row.exercise_id),
        region: await readRegionMarks(row.exercise_id, regionIndex),
      },
      Date.now(),
    )

    if (detraining.factor >= 1) {
      // Steady training — unchanged behaviour. Null policy still means "use the
      // exact template" now that templates own full set prescriptions.
      if (row.progression != null) {
        // Scoped to the grip this exercise is PRESCRIBED at, so MAG-handle work
        // is progressed from MAG-handle history rather than from whatever
        // handle happened to be used last.
        const { history, scopedToGrip } = await progressionHistory(
          row.exercise_id,
          toGripSpec(row),
        )
        if (!scopedToGrip && gripLabel(toGripSpec(row))) {
          gripFallbacks.push({ exercise: row.exercise_name, grip: gripLabel(toGripSpec(row))! })
        }
        const progression = evaluateProgression(row.progression, history, preferredUnit)
        const progressionUnit = dominantUnit(history, preferredUnit)
        prescriptions = mergeProgressionPrescription(
          prescriptions,
          progression.sets,
          progressionUnit,
        )
      }
    } else {
      // Coming back. The progression overlay is SKIPPED outright: its input is
      // the stale history that caused the bug. An explicitly authored template
      // weight wins as-is (the user's Day 1 said 95 where the ramp would say ~110 —
      // de-loading a de-load is worse than not helping), and only sets with no
      // authored weight take the computed re-entry load.
      const before = prescriptions
      prescriptions = applyReEntry(prescriptions, detraining, preferredUnit)
      const easedFrom = before.find(
        (set, i) => set.setType !== 'warmup' && prescriptions[i]?.weight !== set.weight,
      )
      const easedTo: number | null = easedFrom
        ? prescriptions[before.indexOf(easedFrom)]?.weight ?? null
        : null
      if (easedFrom && easedTo != null) {
        notices.eased.push({
          exercise: row.exercise_name,
          from: easedFrom.weight ?? null,
          to: easedTo,
          unit: preferredUnit,
          reason: detraining.reason ?? '',
        })
      }
      // Never a silent weight change: the session itself carries the why.
      await db.execute(sql`
        UPDATE workout_exercises SET prescription_rule = ${detraining.reason}
        WHERE id = ${created.id}
      `)
    }

    if (
      !row.injury_override &&
      !exerciseAllowedWithInjuries(parseExerciseInjuryProfile(row.injury_profile), injuries).allowed
    ) {
      // Flagged, NOT removed. Silently dropping an exercise is its own surprise,
      // and a physio-cleared movement carries injury_override precisely so it
      // stays. The user decides at the gym; the banner makes sure he knows.
      notices.injuries.push({
        exercise: row.exercise_name,
        reason:
          `conflicts with a live injury (${injuries.map((i) => i.region).join(', ')}) — ` +
          'swap or skip it unless a physio has cleared this movement.',
      })
    }

    await materializeSetPrescriptions(
      (query) => db.execute(query),
      created.id,
      prescriptions,
    )
  }

  if (gripFallbacks.length > 0) notices.gripFallbacks = gripFallbacks

  if (notices.eased.length > 0 || notices.injuries.length > 0 || gripFallbacks.length > 0) {
    await db.execute(sql`
      UPDATE workouts SET start_notices = ${JSON.stringify(notices)}::jsonb
      WHERE id = ${workoutId}
    `)
  }
}

/** What the start path changed or flagged, for the Train-tab banner + chat. */
export interface StartNotices {
  eased: Array<{
    exercise: string
    from: number | null
    to: number
    unit: Unit
    reason: string
  }>
  injuries: Array<{ exercise: string; reason: string }>
  /**
   * Exercises prescribed at a grip with no prior history, whose numbers
   * therefore came from a different handle. Named explicitly because a
   * suggested weight nobody can account for is one that gets ignored — or
   * loaded anyway.
   */
  gripFallbacks?: Array<{ exercise: string; grip: string }>
}

/**
 * Overlay the re-entry ramp onto a template's prescriptions (#1790).
 *
 * Working sets only — warmups are left exactly as authored, which is the same
 * choice `mergeProgressionPrescription` makes. An explicitly authored weight is
 * The user's own deliberate load and is never scaled; only a set whose weight would
 * otherwise have come from history takes the computed number.
 */
export function applyReEntry(
  base: SetPrescriptionInput[],
  signal: DetrainingSignal,
  unit: Unit,
): SetPrescriptionInput[] {
  const target = deloadedTargetLb(signal, unit)
  if (target == null) return base
  // Ease by DEFAULT, announce it, and let the user restore the template's numbers in
  // one action. The template itself is never touched — this rewrites today's
  // session only. Earlier this branched on whether the template was authored
  // before or after the layoff; that was inferring intent from a timestamp, and
  // it is unnecessary once the safe direction is the default and the undo is
  // one tap. NEVER raises: a template already lighter than the ramp (his Day 1
  // restart at 95 against a 110 target) is left exactly as written.
  return base.map((set) => {
    if (set.setType === 'warmup') return set
    if (set.weight != null && set.weight <= target) return set
    return { ...set, weight: target, weightUnit: unit, source: 'detraining' as const }
  })
}

function templateSetToPrescription(row: TemplateSetCopyRow): SetPrescriptionInput {
  return {
    setNumber: row.set_number,
    setType: validSetType(row.set_type),
    weight: num(row.target_weight),
    weightUnit: row.target_weight_unit === 'kg' ? 'kg' : 'lb',
    reps: row.target_reps,
    distanceM: num(row.target_distance_m),
    durationS: row.target_duration_s,
    rpe: num(row.target_rpe),
    restSeconds: row.rest_seconds,
    side: validSide(row.side),
    source: 'template',
  }
}

function legacyTemplatePrescriptions(row: TemplateCopyRow): SetPrescriptionInput[] {
  const hasTarget =
    row.target_reps != null || row.target_weight != null || row.target_duration_s != null
  const rounds = row.target_sets != null && row.target_sets > 0 ? row.target_sets : hasTarget ? 1 : 0
  const sets: SetPrescriptionInput[] = []
  for (let round = 0; round < rounds; round += 1) {
    const sides: Array<'left' | 'right' | null> = row.per_side ? ['left', 'right'] : [null]
    for (const side of sides) {
      sets.push({
        setNumber: sets.length + 1,
        setType: 'normal',
        weight: num(row.target_weight),
        weightUnit: row.target_weight_unit === 'kg' ? 'kg' : 'lb',
        reps: row.target_reps,
        durationS: row.target_duration_s,
        restSeconds: null,
        side,
        source: 'template',
      })
    }
  }
  return sets
}

/** Overlay a deterministic policy onto working sets while retaining warmups,
 * sides, distance/RPE, and exact per-set rest. Extra policy sets are materialized
 * so a required 3-set rule cannot degrade into two rows after a short session. */
export function mergeProgressionPrescription(
  base: SetPrescriptionInput[],
  progression: TargetSet[],
  unit: Unit,
): SetPrescriptionInput[] {
  const out = base.map((set) => ({ ...set }))
  const workingIndexes = out
    .map((set, i) => (set.setType === 'warmup' ? -1 : i))
    .filter((i) => i >= 0)

  for (let i = 0; i < progression.length; i += 1) {
    const target = progression[i]!
    const index = workingIndexes[i]
    if (index == null) {
      out.push({
        setNumber: out.length + 1,
        setType: 'normal',
        weight: target.weight ?? null,
        weightUnit: unit,
        reps: target.reps ?? null,
        durationS: target.durationS ?? null,
        side: target.side ?? null,
        source: 'progression',
      })
      continue
    }
    const current = out[index]!
    out[index] = {
      ...current,
      weight: target.weight ?? current.weight ?? null,
      weightUnit: target.weight != null ? unit : current.weightUnit,
      reps: target.reps ?? current.reps ?? null,
      durationS: target.durationS ?? current.durationS ?? null,
      source: 'progression',
    }
  }

  return out.map((set, i) => ({ ...set, setNumber: i + 1 }))
}

interface WorkoutExerciseCopyRow {
  source_workout_exercise_id: string
  exercise_id: string
  position: number
  superset_group: number | null
  rest_seconds: number | null
  rest_seconds_warmup: number | null
  section: string
  notes: string | null
}

/** Copy a specific completed workout, including every set visible in History as
 * the new session's immutable prescription. A completed workout can still contain
 * unchecked planned rows (Finish only requires one completed set), so filtering on
 * workout_sets.completed would silently turn a four-set session into one set when
 * repeated. Actual values win; untouched rows fall back to their saved prescription.
 * Warmups, heterogeneous reps/load, duration/distance/RPE, side, and per-set rest
 * all survive instead of collapsing to exercise names. */
async function copyWorkoutExercises(workoutId: string, sourceWorkoutId: string): Promise<void> {
  const exercises = (
    await db.execute(sql`
      SELECT we.id AS source_workout_exercise_id, we.exercise_id, we.position,
        we.superset_group, we.rest_seconds, we.rest_seconds_warmup,
        we.section, we.notes
      FROM workout_exercises we
      JOIN workouts w ON we.workout_id = w.id AND w.status = 'completed'
      WHERE w.id = ${sourceWorkoutId}
      ORDER BY we.position
    `)
  ).rows as unknown as WorkoutExerciseCopyRow[]

  for (const source of exercises) {
    const [created] = (
      await db.execute(sql`
        INSERT INTO workout_exercises (
          workout_id, exercise_id, position, superset_group,
          rest_seconds, rest_seconds_warmup, section, notes
        ) VALUES (
          ${workoutId}, ${source.exercise_id}, ${source.position}, ${source.superset_group},
          ${source.rest_seconds}, ${source.rest_seconds_warmup}, ${source.section}, ${source.notes}
        )
        RETURNING id
      `)
    ).rows as unknown as Array<{ id: string }>
    if (!created) continue

    const rows = (
      await db.execute(sql`
        SELECT set_number, set_type,
          COALESCE(weight, prescribed_weight)::text AS weight,
          CASE WHEN weight IS NOT NULL THEN weight_unit ELSE prescribed_weight_unit END AS weight_unit,
          COALESCE(reps, prescribed_reps) AS reps,
          COALESCE(distance_m, prescribed_distance_m)::text AS distance_m,
          COALESCE(duration_s, prescribed_duration_s) AS duration_s,
          COALESCE(rpe, prescribed_rpe)::text AS rpe,
          rest_seconds, side, logical_set_id::text AS logical_set_id
        FROM workout_sets
        WHERE workout_exercise_id = ${source.source_workout_exercise_id}
        ORDER BY set_number, created_at
      `)
    ).rows as unknown as Array<{
      set_number: number
      set_type: string
      weight: string | null
      weight_unit: string
      reps: number | null
      distance_m: string | null
      duration_s: number | null
      rpe: string | null
      rest_seconds: number | null
      side: string | null
      logical_set_id: string | null
    }>

    const copiedLogicalIds = new Map<string, string>()

    await materializeSetPrescriptions(
      (query) => db.execute(query),
      created.id,
      rows.map((set, i) => ({
        setNumber: i + 1,
        setType: validSetType(set.set_type),
        weight: num(set.weight),
        weightUnit: set.weight_unit === 'kg' ? 'kg' : 'lb',
        reps: set.reps,
        distanceM: num(set.distance_m),
        durationS: set.duration_s,
        rpe: num(set.rpe),
        restSeconds: set.rest_seconds,
        side: validSide(set.side),
        logicalSetId: copiedLogicalIds.get(set.logical_set_id ?? `set:${set.set_number}`) ?? (() => {
          const id = randomUUID()
          copiedLogicalIds.set(set.logical_set_id ?? `set:${set.set_number}`, id)
          return id
        })(),
        source: 'repeat',
      })),
    )
  }
}

function validSetType(value: string): SetPrescriptionInput['setType'] {
  return value === 'warmup' || value === 'drop' || value === 'failure' ? value : 'normal'
}

function validSide(value: string | null): 'left' | 'right' | null {
  return value === 'left' || value === 'right' ? value : null
}

// ---------------------------------------------------------------------------
// Active-workout probes + read model
// ---------------------------------------------------------------------------

/** The id of the current active workout, or null (uses the partial index). */
export async function activeWorkoutId(): Promise<string | null> {
  const [row] = (
    await db.execute(sql`SELECT id FROM workouts WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`)
  ).rows as unknown as { id: string }[]
  return row?.id ?? null
}

/** Load the active workout read model, or null when none is active. */
export async function getActiveWorkout(): Promise<ActiveWorkout | null> {
  const id = await activeWorkoutId()
  if (!id) return null
  return getActiveWorkoutById(id)
}

interface WorkoutRow {
  id: string
  revision: number
  name: string | null
  status: string
  started_at: string
  template_id: string | null
  template_name: string | null
  start_notices: unknown
}

interface ExerciseRow {
  workout_exercise_id: string
  exercise_id: string
  name: string
  tracks: string
  modality: string
  per_side: boolean
  load_basis: string
  section: string
  position: number
  superset_group: number | null
  we_rest: number | null
  we_rest_warmup: number | null
  ex_default_rest: number | null
  ex_rest_warmup: number | null
  preferred_unit: string | null
  notes: string | null
  prescription_rule: string | null
  grip_width: string | null
  grip_orientation: string | null
  attachment: string | null
}

/**
 * Load the ActiveWorkout by id (any status — the routes gate on status where it
 * matters). Assembles: the workout row, its exercises (with resolved rest +
 * unit), the materialized sets, the previous completed session's sets (set-number
 * aligned), and the progression ghosts + ruleText.
 */
export async function getActiveWorkoutById(id: string): Promise<ActiveWorkout | null> {
  const [w] = (
    await db.execute(sql`
      SELECT w.id, w.revision, w.name, w.status, w.started_at::text AS started_at,
        w.template_id, w.start_notices, t.name AS template_name
      FROM workouts w
      LEFT JOIN workout_templates t ON t.id = w.template_id
      WHERE w.id = ${id}
      LIMIT 1
    `)
  ).rows as unknown as WorkoutRow[]
  if (!w) return null

  const exRows = (
    await db.execute(sql`
      SELECT we.id AS workout_exercise_id, we.exercise_id, e.name, e.tracks,
        e.modality, e.per_side, e.load_basis, we.section,
        we.position, we.superset_group, we.rest_seconds AS we_rest,
        we.rest_seconds_warmup AS we_rest_warmup,
        e.default_rest_seconds AS ex_default_rest,
        e.rest_seconds_warmup AS ex_rest_warmup,
        e.preferred_unit, we.notes, we.prescription_rule,
        we.grip_width, we.grip_orientation, we.attachment
      FROM workout_exercises we
      JOIN exercises e ON e.id = we.exercise_id
      WHERE we.workout_id = ${id}
      ORDER BY we.position, we.id
    `)
  ).rows as unknown as ExerciseRow[]

  // Resolve app-level defaults once (rest + unit) for the fallback chain.
  const appDefaults = await appRestAndUnit()

  const exercises: ActiveExercise[] = []
  for (const ex of exRows) {
    const sets = await materializedSets(ex.workout_exercise_id)
    const previous = await previousSession(ex.exercise_id)
    const { history } = await progressionHistory(ex.exercise_id)
    const unit = (ex.preferred_unit as Unit | null) ?? appDefaults.unit
    // Progression policy: the template's per-exercise policy if this workout came
    // from a template; else last_time (null → default).
    const policy = await progressionPolicy(w.template_id, ex.exercise_id)
    const progression = evaluateProgression(policy, history, unit)
    const prescribed = await prescribedTargets(ex.workout_exercise_id)
    const resolvedRest = ex.we_rest ?? ex.ex_default_rest ?? appDefaults.rest
    const resolvedWarmupRest =
      ex.we_rest_warmup ?? ex.ex_rest_warmup ?? resolvedRest

    exercises.push({
      workoutExerciseId: ex.workout_exercise_id,
      exerciseId: ex.exercise_id,
      name: displayExerciseName(ex.name),
      tracks: ex.tracks,
      modality: ex.modality,
      perSide: ex.per_side,
      loadBasis: ex.load_basis === 'per_side' ? 'per_side' : 'total',
      section: ex.section,
      position: ex.position,
      supersetGroup: ex.superset_group,
      restSeconds: resolvedRest,
      restSecondsWarmup: resolvedWarmupRest,
      preferredUnit: unit,
      notes: ex.notes,
      grip: toGripSpec(ex),
      targets: prescribed.length > 0 ? prescribed : assignLogicalSetIds(progression.sets),
      ruleText:
        ex.prescription_rule ?? (policy != null
          ? progression.ruleText
          : prescribed.length > 0
            ? 'Follow the saved set prescription.'
            : progression.ruleText),
      previous,
      sets,
    })
  }

  return {
    id: w.id,
    revision: w.revision,
    name: w.name,
    status: w.status,
    startedAt: w.started_at,
    templateId: w.template_id,
    templateName: w.template_name,
    weightUnit: appDefaults.unit,
    distanceUnit: appDefaults.distanceUnit,
    startNotices: (w.start_notices as StartNotices | null) ?? null,
    exercises,
  }
}

/** app_settings gym rest + unit defaults (single-row typed table). */
async function appRestAndUnit(): Promise<{ rest: number; unit: Unit; distanceUnit: DistanceUnit }> {
  const [row] = (
    await db.execute(
      sql`SELECT
        gym_default_rest_seconds AS rest,
        COALESCE(gym_weight_unit_override, weight_unit) AS unit,
        COALESCE(
          gym_distance_unit_override,
          CASE WHEN unit_system = 'metric' THEN 'km' ELSE 'mi' END
        ) AS distance_unit
      FROM app_settings WHERE id = 1 LIMIT 1`,
    )
  ).rows as unknown as { rest: number | null; unit: string | null; distance_unit: string | null }[]
  return {
    rest: row?.rest ?? HARD_DEFAULT_REST,
    unit: (row?.unit as Unit) === 'kg' ? 'kg' : 'lb',
    distanceUnit: isDistanceUnit(row?.distance_unit) ? row.distance_unit : 'mi',
  }
}

interface SetRow {
  client_set_id: string | null
  logical_set_id: string
  set_number: number
  set_type: string
  weight: string | null
  weight_unit: string
  reps: number | null
  distance_m: string | null
  duration_s: number | null
  rpe: string | null
  rest_seconds: number | null
  side: string | null
  completed: boolean
}

function num(v: string | null): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Materialized sets for one workout_exercise, in set order. */
async function materializedSets(workoutExerciseId: string): Promise<ActiveSet[]> {
  const rows = (
    await db.execute(sql`
      SELECT client_set_id::text AS client_set_id, set_number, set_type,
        weight::text AS weight, weight_unit, reps, distance_m::text AS distance_m,
        duration_s, rpe::text AS rpe, rest_seconds, side,
        logical_set_id::text AS logical_set_id, completed
      FROM workout_sets
      WHERE workout_exercise_id = ${workoutExerciseId}
      ORDER BY set_number, created_at
    `)
  ).rows as unknown as SetRow[]
  return rows.map(toActiveSet)
}

function toActiveSet(r: SetRow): ActiveSet {
  return {
    clientSetId: r.client_set_id,
    logicalSetId: r.logical_set_id ?? r.client_set_id ?? randomUUID(),
    setNumber: r.set_number,
    setType: r.set_type,
    weight: num(r.weight),
    weightUnit: r.weight_unit,
    reps: r.reps,
    distanceM: num(r.distance_m),
    durationS: r.duration_s,
    rpe: num(r.rpe),
    restSeconds: r.rest_seconds,
    side: r.side === 'left' || r.side === 'right' ? r.side : null,
    completed: r.completed,
  }
}

interface PrescribedSetRow {
  set_number: number
  set_type: string
  prescribed_weight: string | null
  prescribed_weight_unit: string
  prescribed_reps: number | null
  prescribed_distance_m: string | null
  prescribed_duration_s: number | null
  prescribed_rpe: string | null
  rest_seconds: number | null
  prescription_source: string | null
  side: string | null
  logical_set_id: string
}

/** The immutable start-time targets aligned to the materialized set rows. */
async function prescribedTargets(workoutExerciseId: string): Promise<TargetSetOut[]> {
  const rows = (
    await db.execute(sql`
      SELECT set_number, set_type,
        prescribed_weight::text AS prescribed_weight, prescribed_weight_unit,
        prescribed_reps, prescribed_distance_m::text AS prescribed_distance_m,
        prescribed_duration_s, prescribed_rpe::text AS prescribed_rpe,
        rest_seconds, prescription_source, side,
        logical_set_id::text AS logical_set_id
      FROM workout_sets
      WHERE workout_exercise_id = ${workoutExerciseId}
        AND prescription_source IS NOT NULL
      ORDER BY set_number, created_at
    `)
  ).rows as unknown as PrescribedSetRow[]

  return rows.map((row) => {
    const target: TargetSetOut = {
      setNumber: row.set_number,
      setType: row.set_type,
      weightUnit: row.prescribed_weight_unit === 'kg' ? 'kg' : 'lb',
      side: validSide(row.side),
      logicalSetId: row.logical_set_id ?? undefined,
      source: validPrescriptionSource(row.prescription_source),
    }
    const weight = num(row.prescribed_weight)
    const distanceM = num(row.prescribed_distance_m)
    const rpe = num(row.prescribed_rpe)
    if (weight != null) target.weight = weight
    if (row.prescribed_reps != null) target.reps = row.prescribed_reps
    if (distanceM != null) target.distanceM = distanceM
    if (row.prescribed_duration_s != null) target.durationS = row.prescribed_duration_s
    if (rpe != null) target.rpe = rpe
    if (row.rest_seconds != null) target.restSeconds = row.rest_seconds
    return target
  })
}

function validPrescriptionSource(value: string | null): PrescriptionSource | undefined {
  return value === 'template' ||
    value === 'progression' ||
    value === 'repeat' ||
    value === 'detraining' ||
    value === 'proposal' ||
    value === 'agent' ||
    value === 'replacement'
    ? value
    : undefined
}

/** The most recent COMPLETED session's sets for an exercise, set-number aligned. */
async function previousSession(exerciseId: string): Promise<PreviousSet[]> {
  const rows = (
    await db.execute(sql`
      SELECT ws.set_number, ws.set_type, ws.weight::text AS weight, ws.weight_unit AS unit,
        ws.reps, ws.duration_s, ws.distance_m::text AS distance_m, ws.side,
        ws.logical_set_id::text AS logical_set_id
      FROM workout_sets ws
      JOIN workout_exercises we ON ws.workout_exercise_id = we.id
      JOIN workouts w ON we.workout_id = w.id AND w.status = 'completed'
      WHERE we.exercise_id = ${exerciseId}
        AND ws.completed = true
        AND w.id = (
          SELECT w2.id FROM workouts w2
          JOIN workout_exercises we2 ON we2.workout_id = w2.id
          JOIN workout_sets ws2 ON ws2.workout_exercise_id = we2.id AND ws2.completed = true
          WHERE we2.exercise_id = ${exerciseId} AND w2.status = 'completed'
          ORDER BY w2.started_at DESC LIMIT 1
        )
      ORDER BY ws.set_number
    `)
  ).rows as unknown as Array<{
    set_number: number
    set_type: string
    weight: string | null
    unit: string
    reps: number | null
    duration_s: number | null
    distance_m: string | null
    side: string | null
    logical_set_id: string
  }>
  return rows.map((r) => ({
    setNumber: r.set_number,
    setType: r.set_type,
    weight: num(r.weight),
    unit: r.unit,
    reps: r.reps,
    durationS: r.duration_s,
    distanceM: num(r.distance_m),
    side: validSide(r.side),
    logicalSetId: r.logical_set_id ?? undefined,
  }))
}

/**
 * Prior WORKING-set history for the progression engine — the last N completed
 * sessions of an exercise, OLDEST→NEWEST, each a list of working (non-warmup)
 * sets. Feeds evaluateProgression.
 */
/**
 * SQL matching the RESOLVED grip (set override over exercise default) against a
 * target, for each field the target actually specifies.
 *
 * Only specified fields constrain: a template that names the attachment and
 * nothing else must match every width it was done at, or "do these on the MAG
 * handle" would find no history the first time the width differed.
 */
function gripFilterSql(grip: GripSpec): SQL[] {
  const out: SQL[] = []
  if (grip.attachment) {
    out.push(sql`COALESCE(ws.attachment, we.attachment) = ${grip.attachment}`)
  }
  if (grip.gripWidth) {
    out.push(sql`COALESCE(ws.grip_width, we.grip_width) = ${grip.gripWidth}`)
  }
  if (grip.gripOrientation) {
    out.push(sql`COALESCE(ws.grip_orientation, we.grip_orientation) = ${grip.gripOrientation}`)
  }
  return out
}

/**
 * Sessions to progress from — scoped to the same grip when one is prescribed.
 *
 * The distinction that matters: the logger must know the difference between each and
 * recommendations should change per grip/hardware."* Pulldowns on the MAG
 * handle are not the same lift as wide-grip pulldowns, and prescribing one from
 * the other is why a suggested load can feel wrong in both directions on the
 * same exercise.
 *
 * Falls back to the unscoped history when that grip has no prior session, and
 * REPORTS the fallback rather than silently pretending the numbers are
 * comparable — a weight you can't account for is one you ignore, or load anyway.
 */
async function progressionHistory(
  exerciseId: string,
  grip: GripSpec = EMPTY_GRIP,
): Promise<{ history: SessionHistory; scopedToGrip: boolean }> {
  const filters = gripFilterSql(grip)
  if (filters.length > 0) {
    const scoped = await progressionHistoryRows(exerciseId, filters)
    if (scoped.length > 0) return { history: scoped, scopedToGrip: true }
  }
  return { history: await progressionHistoryRows(exerciseId, []), scopedToGrip: false }
}

async function progressionHistoryRows(
  exerciseId: string,
  filters: SQL[],
): Promise<SessionHistory> {
  const gripWhere = filters.length > 0 ? sql` AND ${sql.join(filters, sql` AND `)}` : sql``
  const rows = (
    await db.execute(sql`
      SELECT w.id AS workout_id, w.started_at,
        ws.weight::text AS weight, ws.weight_unit AS unit, ws.reps, ws.duration_s,
        ws.side
      FROM workout_sets ws
      JOIN workout_exercises we ON ws.workout_exercise_id = we.id
      JOIN workouts w ON we.workout_id = w.id AND w.status = 'completed'
      WHERE we.exercise_id = ${exerciseId} AND ws.set_type <> 'warmup'
        AND ws.completed = true${gripWhere}
        AND w.id IN (
          SELECT w2.id FROM workouts w2
          JOIN workout_exercises we2 ON we2.workout_id = w2.id
          JOIN workout_sets ws2 ON ws2.workout_exercise_id = we2.id AND ws2.completed = true
          WHERE we2.exercise_id = ${exerciseId} AND w2.status = 'completed'
            AND EXISTS (
              SELECT 1 FROM workout_sets ws3
              JOIN workout_exercises we3 ON ws3.workout_exercise_id = we3.id
              WHERE we3.id = we2.id AND ws3.id = ws2.id
            )
          GROUP BY w2.id, w2.started_at
          ORDER BY w2.started_at DESC LIMIT ${PROGRESSION_HISTORY_SESSIONS}
        )
      ORDER BY w.started_at ASC, ws.set_number ASC
    `)
  ).rows as unknown as Array<{
    workout_id: string
    weight: string | null
    unit: string
    reps: number | null
    duration_s: number | null
    side: string | null
  }>

  // Group into ordered sessions (already oldest→newest by started_at).
  const byWorkout = new Map<string, Session>()
  const order: string[] = []
  for (const r of rows) {
    let session = byWorkout.get(r.workout_id)
    if (!session) {
      session = []
      byWorkout.set(r.workout_id, session)
      order.push(r.workout_id)
    }
    session.push({
      weight: num(r.weight),
      unit: r.unit === 'kg' ? 'kg' : 'lb',
      reps: r.reps,
      durationS: r.duration_s,
      side: r.side === 'left' || r.side === 'right' ? r.side : null,
    })
  }
  return order.map((id) => byWorkout.get(id)!)
}

/** The stored progression policy for (template, exercise), or null (→ last_time). */
async function progressionPolicy(
  templateId: string | null,
  exerciseId: string,
): Promise<unknown> {
  if (!templateId) return null
  const [row] = (
    await db.execute(sql`
      SELECT te.progression AS exercise_progression, t.progression AS template_progression
      FROM template_exercises te
      JOIN workout_templates t ON t.id = te.template_id
      WHERE te.template_id = ${templateId} AND te.exercise_id = ${exerciseId}
      LIMIT 1
    `)
  ).rows as unknown as Array<{ exercise_progression: unknown; template_progression: unknown }>
  // Exercise → template (#1790). A bespoke per-exercise rule always wins; the
  // template default only fills rows that never authored one, so adding a
  // default can never silently rewrite a rule the user wrote deliberately.
  return row?.exercise_progression ?? row?.template_progression ?? null
}

// ---------------------------------------------------------------------------
// Set upsert (idempotent — the optimistic queue's landing zone)
// ---------------------------------------------------------------------------

export interface SetUpsertInput {
  clientSetId: string
  /** Split rows share one UUID; omitted legacy payloads fall back to clientSetId. */
  logicalSetId?: string
  workoutExerciseId: string
  setNumber: number
  setType?: string
  weight?: number | null
  weightUnit?: string | null
  reps?: number | null
  distanceM?: number | null
  durationS?: number | null
  rpe?: number | null
  /** Immutable prescription fields. Omitted values preserve an existing row;
   * new materialized rows may set them without fabricating performed data. */
  prescribedWeight?: number | null
  prescribedWeightUnit?: string | null
  prescribedReps?: number | null
  prescribedDistanceM?: number | null
  prescribedDurationS?: number | null
  prescribedRpe?: number | null
  prescriptionSource?: PrescriptionSource | null
  /** Per-set rest override. undefined preserves the current prescription value;
   * null clears to the exercise fallback. */
  restSeconds?: number | null
  /** Per-side hold marker (§10b.2). Anything but 'left'/'right' stores NULL. */
  side?: string | null
  completed?: boolean
}

export interface SetsResult {
  /** Canonical sets for each touched workout_exercise, keyed by id. */
  byExercise: Record<string, ActiveSet[]>
  /** Generation after this write committed. */
  revision: number
  /**
   * clientSetIds that flipped false→true (or were freshly created completed) IN
   * THIS write — as opposed to `sets` entries that merely RE-SEND an already-
   * completed row unchanged (the optimistic client always re-sends an exercise's
   * FULL set array on any edit, so an unrelated edit to a sibling set — e.g.
   * adding a new set or changing a not-yet-started set's rest override — re-sends
   * every prior ✓ alongside it). Callers use this to gate "just completed" side
   * effects (the rest-end push, GYM_PLAN §2.7b) so they fire once per real
   * completion instead of once per batch that happens to include an old ✓.
   */
  newlyCompletedClientSetIds: string[]
}

export type AtomicSetsResult =
  | { ok: true; result: SetsResult }
  | { ok: false; reason: 'inactive' | 'conflict' }

/** A stale active-workout mutation. Routes translate this to a typed 409; agent
 * tools translate it into a re-read/retry instruction instead of claiming the
 * edit landed. */
export class ActiveWorkoutRevisionConflictError extends Error {
  readonly code = 'stale_revision'

  constructor() {
    super('The active workout changed since it was loaded.')
    this.name = 'ActiveWorkoutRevisionConflictError'
  }
}

/** A destructive exercise-list edit would erase performance already logged in
 * this live session. Callers surface this as a typed conflict and can prescribe
 * the safe alternative: keep the performed movement and add the replacement. */
export class ActiveWorkoutPerformedSetsConflictError extends Error {
  readonly code = 'performed_sets_present'

  constructor(
    readonly workoutExerciseId: string,
    readonly operation: 'remove' | 'replace',
  ) {
    super(
      operation === 'replace'
        ? 'That exercise already has completed sets. Keep it in the session and add the replacement as a new exercise.'
        : 'That exercise already has completed sets and cannot be removed from the session history.',
    )
    this.name = 'ActiveWorkoutPerformedSetsConflictError'
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Idempotently upsert a batch of sets + optionally delete some. Keys on
 * `client_set_id` (ON CONFLICT DO UPDATE), so replaying the same payload yields
 * the same rows (TESTED). Only valid on an ACTIVE workout — returns null so the
 * route 409s otherwise (a finished workout's sets are edited via a future
 * history-edit path). Returns the canonical sets for every touched exercise.
 */
export async function upsertSets(
  workoutId: string,
  sets: SetUpsertInput[],
  expectedRevision: number,
  deleteClientSetIds: string[] = [],
): Promise<SetsResult | null> {
  const touched = new Set<string>()
  for (const s of sets) touched.add(s.workoutExerciseId)
  return db.transaction(async (tx) => {
    const guard = await lockActiveRevision(tx, workoutId)
    if (!guard || guard.status !== 'active') return null
    if (guard.revision !== expectedRevision) throw new ActiveWorkoutRevisionConflictError()

    if (touched.size > 0 && !(await exerciseIdsBelongTx(tx, workoutId, [...touched]))) {
      return null
    }
    // Snapshot which of the incoming "completed" rows were ALREADY completed
    // before this write — read before the upsert loop overwrites them, so a
    // resent-unchanged ✓ can be told apart from one this write just landed.
    const completingIds = sets.filter((s) => s.completed === true).map((s) => s.clientSetId)
    let priorCompleted = new Set<string>()
    if (completingIds.length > 0) {
      const rows = (
        await tx.execute(sql`
          SELECT client_set_id::text AS client_set_id FROM workout_sets
          WHERE client_set_id IN (${sql.join(completingIds.map((id) => sql`${id}`), sql`, `)})
            AND completed = true
        `)
      ).rows as unknown as { client_set_id: string }[]
      priorCompleted = new Set(rows.map((row) => row.client_set_id))
    }

    for (const set of sets) await executeSetUpsert(tx, set)

    if (deleteClientSetIds.length > 0) {
      await tx.execute(sql`
        DELETE FROM workout_sets
        WHERE client_set_id IN (${sql.join(
          deleteClientSetIds.map((id) => sql`${id}`),
          sql`, `,
        )})
          AND workout_exercise_id IN (
            SELECT id FROM workout_exercises WHERE workout_id = ${workoutId}
          )
      `)
    }

    const revision = await advanceActiveRevision(tx, workoutId, expectedRevision)
    const byExercise: Record<string, ActiveSet[]> = {}
    for (const weId of touched) {
      byExercise[weId] = await lockedMaterializedSets(tx, weId, false)
    }
    const newlyCompletedClientSetIds = completingIds.filter((id) => !priorCompleted.has(id))
    return { byExercise, revision, newlyCompletedClientSetIds }
  })
}

/**
 * Replace/reindex one exercise's set prescription as one compare-and-swap.
 * The agent passes the exact actual rows it read. We lock the workout/exercise
 * and their sets, reject if a logger write landed since that read, then apply
 * every upsert/delete in a single transaction. This is deliberately narrower
 * than the optimistic logger's ordinary field queue: structural warm-up edits
 * must never partially land or overwrite newly completed performance.
 */
export async function upsertExerciseSetsIfUnchanged(
  workoutId: string,
  workoutExerciseId: string,
  expectedSets: ActiveSet[],
  sets: SetUpsertInput[],
  expectedRevision: number,
  deleteClientSetIds: string[] = [],
): Promise<AtomicSetsResult> {
  return db.transaction(async (tx) => {
    const [guard] = (
      await tx.execute(sql`
        SELECT w.status, w.revision
        FROM workouts w
        JOIN workout_exercises we ON we.workout_id = w.id
        WHERE w.id = ${workoutId} AND we.id = ${workoutExerciseId}
        FOR UPDATE OF w, we
      `)
    ).rows as unknown as Array<{ status: string; revision: number }>
    if (!guard || guard.status !== 'active') return { ok: false, reason: 'inactive' } as const
    if (guard.revision !== expectedRevision) return { ok: false, reason: 'conflict' } as const

    const current = await lockedMaterializedSets(tx, workoutExerciseId)
    if (!sameActualSetSnapshot(current, expectedSets)) {
      return { ok: false, reason: 'conflict' } as const
    }

    for (const set of sets) await executeSetUpsert(tx, set)
    if (deleteClientSetIds.length > 0) {
      await tx.execute(sql`
        DELETE FROM workout_sets
        WHERE client_set_id IN (${sql.join(
          deleteClientSetIds.map((id) => sql`${id}`),
          sql`, `,
        )})
          AND workout_exercise_id = ${workoutExerciseId}
      `)
    }

    const revision = await advanceActiveRevision(tx, workoutId, expectedRevision)
    const canonical = await lockedMaterializedSets(tx, workoutExerciseId, false)
    // This path (agent warm-up edits) never feeds the rest-end push hook —
    // only the sets PUT route does — so there's nothing to report here.
    return {
      ok: true,
      result: { byExercise: { [workoutExerciseId]: canonical }, revision, newlyCompletedClientSetIds: [] },
    } as const
  })
}

async function lockedMaterializedSets(
  tx: Tx,
  workoutExerciseId: string,
  lock = true,
): Promise<ActiveSet[]> {
  const rows = (
    await tx.execute(sql`
      SELECT client_set_id::text AS client_set_id, set_number, set_type,
        weight::text AS weight, weight_unit, reps, distance_m::text AS distance_m,
        duration_s, rpe::text AS rpe, rest_seconds, side,
        logical_set_id::text AS logical_set_id, completed
      FROM workout_sets
      WHERE workout_exercise_id = ${workoutExerciseId}
      ORDER BY set_number, created_at
      ${lock ? sql`FOR UPDATE` : sql``}
    `)
  ).rows as unknown as SetRow[]
  return rows.map(toActiveSet)
}

function sameActualSetSnapshot(current: ActiveSet[], expected: ActiveSet[]): boolean {
  if (current.length !== expected.length) return false
  return current.every((row, index) => {
    const other = expected[index]
    return other != null &&
      row.clientSetId === other.clientSetId &&
      row.logicalSetId === other.logicalSetId &&
      row.setNumber === other.setNumber &&
      row.setType === other.setType &&
      sameSetNumber(row.weight, other.weight) &&
      row.weightUnit === other.weightUnit &&
      row.reps === other.reps &&
      sameSetNumber(row.distanceM, other.distanceM) &&
      row.durationS === other.durationS &&
      sameSetNumber(row.rpe, other.rpe) &&
      (row.restSeconds ?? null) === (other.restSeconds ?? null) &&
      row.side === other.side &&
      row.completed === other.completed
  })
}

function sameSetNumber(left: number | null, right: number | null): boolean {
  return left == null || right == null
    ? left == null && right == null
    : Math.abs(left - right) < 0.0001
}

async function executeSetUpsert(tx: Tx, set: SetUpsertInput): Promise<void> {
  const side = set.side === 'left' || set.side === 'right' ? set.side : null
  const restUpdate = set.restSeconds === undefined
    ? sql`rest_seconds = workout_sets.rest_seconds`
    : sql`rest_seconds = EXCLUDED.rest_seconds`
  // Older cached logger payloads predate logical set IDs. Preserve the
  // migration-assigned grouping for those rows instead of replacing it with
  // the client-row ID used as the INSERT fallback.
  const logicalSetUpdate = set.logicalSetId === undefined
    ? sql`logical_set_id = workout_sets.logical_set_id`
    : sql`logical_set_id = EXCLUDED.logical_set_id`
  const prescribedWeightUpdate = set.prescribedWeight === undefined
    ? sql`prescribed_weight = workout_sets.prescribed_weight`
    : sql`prescribed_weight = EXCLUDED.prescribed_weight`
  const prescribedWeightUnitUpdate = set.prescribedWeightUnit === undefined
    ? sql`prescribed_weight_unit = workout_sets.prescribed_weight_unit`
    : sql`prescribed_weight_unit = EXCLUDED.prescribed_weight_unit`
  const prescribedRepsUpdate = set.prescribedReps === undefined
    ? sql`prescribed_reps = workout_sets.prescribed_reps`
    : sql`prescribed_reps = EXCLUDED.prescribed_reps`
  const prescribedDistanceUpdate = set.prescribedDistanceM === undefined
    ? sql`prescribed_distance_m = workout_sets.prescribed_distance_m`
    : sql`prescribed_distance_m = EXCLUDED.prescribed_distance_m`
  const prescribedDurationUpdate = set.prescribedDurationS === undefined
    ? sql`prescribed_duration_s = workout_sets.prescribed_duration_s`
    : sql`prescribed_duration_s = EXCLUDED.prescribed_duration_s`
  const prescribedRpeUpdate = set.prescribedRpe === undefined
    ? sql`prescribed_rpe = workout_sets.prescribed_rpe`
    : sql`prescribed_rpe = EXCLUDED.prescribed_rpe`
  const prescriptionSourceUpdate = set.prescriptionSource === undefined
    ? sql`prescription_source = workout_sets.prescription_source`
    : sql`prescription_source = EXCLUDED.prescription_source`
  await tx.execute(sql`
    INSERT INTO workout_sets (
      workout_exercise_id, set_number, set_type, weight, weight_unit,
      reps, distance_m, duration_s, rpe,
      prescribed_weight, prescribed_weight_unit, prescribed_reps,
      prescribed_distance_m, prescribed_duration_s, prescribed_rpe,
      rest_seconds, prescription_source, side, logical_set_id, completed, client_set_id,
      completed_at
    ) VALUES (
      ${set.workoutExerciseId}, ${set.setNumber}, ${set.setType ?? 'normal'},
      ${set.weight ?? null}, ${set.weightUnit ?? 'lb'}, ${set.reps ?? null},
      ${set.distanceM ?? null}, ${set.durationS ?? null}, ${set.rpe ?? null},
      ${set.prescribedWeight ?? null}, ${set.prescribedWeightUnit ?? set.weightUnit ?? 'lb'},
      ${set.prescribedReps ?? null}, ${set.prescribedDistanceM ?? null},
      ${set.prescribedDurationS ?? null}, ${set.prescribedRpe ?? null},
      ${set.restSeconds ?? null}, ${set.prescriptionSource ?? null},
      ${side}, ${set.logicalSetId ?? set.clientSetId}, ${set.completed ?? false}, ${set.clientSetId},
      -- Stamped server-side, and only for a set arriving already complete.
      ${set.completed ? sql`now()` : sql`NULL`}
    )
    ON CONFLICT (client_set_id) DO UPDATE SET
      workout_exercise_id = EXCLUDED.workout_exercise_id,
      set_number = EXCLUDED.set_number,
      set_type = EXCLUDED.set_type,
      weight = EXCLUDED.weight,
      weight_unit = EXCLUDED.weight_unit,
      reps = EXCLUDED.reps,
      distance_m = EXCLUDED.distance_m,
      duration_s = EXCLUDED.duration_s,
      rpe = EXCLUDED.rpe,
      ${prescribedWeightUpdate},
      ${prescribedWeightUnitUpdate},
      ${prescribedRepsUpdate},
      ${prescribedDistanceUpdate},
      ${prescribedDurationUpdate},
      ${prescribedRpeUpdate},
      ${restUpdate},
      ${prescriptionSourceUpdate},
      side = EXCLUDED.side,
      ${logicalSetUpdate},
      completed = EXCLUDED.completed,
      -- Stamp on the false→true transition only, and never re-stamp. Editing a
      -- completed set's weight must not move its timestamp, and unchecking then
      -- rechecking is a correction rather than a second performance — keeping
      -- the first stamp is what makes the interval reflect the real session.
      -- Clears when a set goes back to incomplete, so no stale time survives.
      completed_at = CASE
        WHEN EXCLUDED.completed = false THEN NULL
        WHEN workout_sets.completed_at IS NOT NULL THEN workout_sets.completed_at
        ELSE now()
      END
  `)
}

async function lockActiveRevision(
  tx: Tx,
  workoutId: string,
): Promise<{ status: string; revision: number } | null> {
  const [row] = (
    await tx.execute(sql`
      SELECT status, revision FROM workouts WHERE id = ${workoutId} FOR UPDATE
    `)
  ).rows as unknown as Array<{ status: string; revision: number }>
  return row ?? null
}

async function advanceActiveRevision(
  tx: Tx,
  workoutId: string,
  expectedRevision: number,
): Promise<number> {
  const [row] = (
    await tx.execute(sql`
      UPDATE workouts SET revision = revision + 1
      WHERE id = ${workoutId} AND status = 'active' AND revision = ${expectedRevision}
      RETURNING revision
    `)
  ).rows as unknown as Array<{ revision: number }>
  if (!row) throw new ActiveWorkoutRevisionConflictError()
  return row.revision
}

/** True when every workout_exercise id belongs to `workoutId`. */
async function exerciseIdsBelongTx(tx: Tx, workoutId: string, ids: string[]): Promise<boolean> {
  const [row] = (
    await tx.execute(sql`
      SELECT count(*)::int AS n FROM workout_exercises
      WHERE workout_id = ${workoutId}
        AND id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
    `)
  ).rows as unknown as { n: number }[]
  return (row?.n ?? 0) === ids.length
}

/** True when the workout is currently 'active'. */
async function isActive(workoutId: string): Promise<boolean> {
  const [row] = (
    await db.execute(sql`SELECT status FROM workouts WHERE id = ${workoutId} LIMIT 1`)
  ).rows as unknown as { status: string }[]
  return row?.status === 'active'
}

// ---------------------------------------------------------------------------
// Exercise-list edits (add / remove / reorder / superset / replace)
// ---------------------------------------------------------------------------

export interface ExerciseEdits {
  add?: Array<{ exerciseId: string; position?: number }>
  remove?: string[] // workoutExerciseIds
  reorder?: Array<{ workoutExerciseId: string; position: number }>
  superset?: Array<{ workoutExerciseId: string; group: number | null }>
  replace?: Array<{
    workoutExerciseId: string
    newExerciseId: string
    /** #1876: carry the old exercise's prescribed load/reps forward as the new
     *  exercise's ghost target instead of deleting them. Default false (blank
     *  slate) — matches the prior behavior for callers that don't ask. */
    keepPrescription?: boolean
  }>
  /** Session-level defaults; individual sets can override through PUT /sets. */
  rest?: Array<{
    workoutExerciseId: string
    seconds: number | null
    warmupSeconds?: number | null
  }>
  /** THIS session's per-exercise note. Starting from a template seeds it from
   * `template_exercises.notes`; editing here diverges for the session only —
   * finishing with an apply-template-update carries it back to the template.
   * `applyToTemplate` promotes the note to the source template immediately, so a
   * cue learned mid-set is there next time without waiting for the finish sheet
   * (and without dragging the session's weights along with it). */
  notes?: Array<{
    workoutExerciseId: string
    notes: string | null
    applyToTemplate?: boolean
  }>
}

/**
 * Apply any-of the exercise-list edits and return the refreshed ActiveWorkout, or
 * null when the workout isn't active (409). REPLACE keeps position + superset but
 * DELETES the old exercise's materialized sets and recomputes targets/previous for
 * the new exercise (a different movement) — UNLESS `keepPrescription` is set, in
 * which case the old incomplete sets' prescribed_* values survive as the new
 * exercise's ghost target (relabeled source 'replacement'; #1876 — replacing used
 * to wipe the target and leave the next set logged blind). ADD appends at the end
 * unless a position is given.
 */
export async function editExercises(
  workoutId: string,
  edits: ExerciseEdits,
  expectedRevision: number,
): Promise<ActiveWorkout | null> {
  const changed = await db.transaction(async (tx) => {
    const guard = await lockActiveRevision(tx, workoutId)
    if (!guard || guard.status !== 'active') return false
    if (guard.revision !== expectedRevision) throw new ActiveWorkoutRevisionConflictError()

    // Preflight every destructive edit before writing anything. The workout row
    // lock serializes this check against logger set writes, so a completed set
    // cannot appear between the check and the remove/replace. Planned/incomplete
    // rows remain freely editable.
    for (const workoutExerciseId of new Set(edits.remove ?? [])) {
      await assertNoCompletedPerformance(tx, workoutId, workoutExerciseId, 'remove')
    }
    for (const replacement of edits.replace ?? []) {
      await assertNoCompletedPerformance(
        tx,
        workoutId,
        replacement.workoutExerciseId,
        'replace',
      )
    }

    // remove
    for (const weId of edits.remove ?? []) {
      await tx.execute(
        sql`DELETE FROM workout_exercises WHERE id = ${weId} AND workout_id = ${workoutId}`,
      )
    }

  // replace (keep position + superset, swap exercise_id)
    for (const r of edits.replace ?? []) {
      await tx.execute(sql`
      UPDATE workout_exercises SET exercise_id = ${r.newExerciseId}
      WHERE id = ${r.workoutExerciseId} AND workout_id = ${workoutId}
    `)
      if (r.keepPrescription) {
        // Sets are for the OLD movement, but the user asked to keep its prescribed
        // load/reps as the new exercise's ghost target (#1876). The preflight
        // above guarantees every row here is still incomplete, so only
        // prescribed_* (the target) survives — relabel the source so it never
        // claims to be the new exercise's own template/progression pick. Only
        // rows that actually carry a target are touched, so a manually-added
        // blank set doesn't get stamped into a fake empty target that would
        // suppress the new exercise's own progression fallback.
        await tx.execute(sql`
          UPDATE workout_sets SET prescription_source = 'replacement'
          WHERE workout_exercise_id = ${r.workoutExerciseId}
            AND (
              prescribed_weight IS NOT NULL OR prescribed_reps IS NOT NULL OR
              prescribed_distance_m IS NOT NULL OR prescribed_duration_s IS NOT NULL
            )
        `)
      } else {
        // Sets are for the OLD movement — delete them (prior/default behavior).
        await tx.execute(
          sql`DELETE FROM workout_sets WHERE workout_exercise_id = ${r.workoutExerciseId}`,
        )
      }
    }

  // add (append after the current max position unless a position is given).
  // Duplicates are allowed: adding an exercise already in the workout creates a
  // second instance (its own row + sets), e.g. curls early and again late.
    for (const a of edits.add ?? []) {
      const position = a.position ?? (await nextPosition(workoutId, tx))
      await tx.execute(sql`
      INSERT INTO workout_exercises (workout_id, exercise_id, position)
      VALUES (${workoutId}, ${a.exerciseId}, ${position})
    `)
    }

  // reorder
    for (const o of edits.reorder ?? []) {
      await tx.execute(sql`
      UPDATE workout_exercises SET position = ${o.position}
      WHERE id = ${o.workoutExerciseId} AND workout_id = ${workoutId}
    `)
    }

  // superset grouping (null clears)
    for (const s of edits.superset ?? []) {
      await tx.execute(sql`
      UPDATE workout_exercises SET superset_group = ${s.group}
      WHERE id = ${s.workoutExerciseId} AND workout_id = ${workoutId}
    `)
    }

  // Rest defaults. Every update is workout-scoped; invalid durations are ignored
  // rather than letting a tool/client persist a negative or multi-hour timer.
    for (const rest of edits.rest ?? []) {
      if (!validRestSeconds(rest.seconds)) continue
      if (rest.warmupSeconds !== undefined && !validRestSeconds(rest.warmupSeconds)) continue
      if (rest.warmupSeconds === undefined) {
        await tx.execute(sql`
        UPDATE workout_exercises SET rest_seconds = ${rest.seconds}
        WHERE id = ${rest.workoutExerciseId} AND workout_id = ${workoutId}
      `)
      } else {
        await tx.execute(sql`
        UPDATE workout_exercises
        SET rest_seconds = ${rest.seconds}, rest_seconds_warmup = ${rest.warmupSeconds}
        WHERE id = ${rest.workoutExerciseId} AND workout_id = ${workoutId}
      `)
      }
    }

  // Per-exercise notes. Blank input clears the note rather than storing '' — an
  // empty string and "no note" render identically, so keep one representation.
    for (const note of edits.notes ?? []) {
      const raw = typeof note.notes === 'string' ? note.notes.trim() : null
      const value = raw === '' ? null : raw
      await tx.execute(sql`
        UPDATE workout_exercises SET notes = ${value}
        WHERE id = ${note.workoutExerciseId} AND workout_id = ${workoutId}
      `)
      if (!note.applyToTemplate) continue
      // Scoped through the workout's OWN template + this slot's exercise, so a
      // stale/foreign workoutExerciseId can never write another template's row.
      await tx.execute(sql`
        UPDATE template_exercises te
        SET notes = ${value}
        FROM workout_exercises we
        JOIN workouts w ON w.id = we.workout_id
        WHERE we.id = ${note.workoutExerciseId}
          AND we.workout_id = ${workoutId}
          AND te.template_id = w.template_id
          AND te.exercise_id = we.exercise_id
      `)
    }

    await advanceActiveRevision(tx, workoutId, expectedRevision)
    return true
  })
  if (!changed) return null
  return getActiveWorkoutById(workoutId)
}

async function assertNoCompletedPerformance(
  tx: Tx,
  workoutId: string,
  workoutExerciseId: string,
  operation: 'remove' | 'replace',
): Promise<void> {
  const [performed] = (
    await tx.execute(sql`
      SELECT we.id
      FROM workout_exercises we
      WHERE we.id = ${workoutExerciseId}
        AND we.workout_id = ${workoutId}
        AND EXISTS (
          SELECT 1
          FROM workout_sets ws
          WHERE ws.workout_exercise_id = we.id
            AND ws.completed = true
        )
      LIMIT 1
    `)
  ).rows as unknown as Array<{ id: string }>
  if (performed) {
    throw new ActiveWorkoutPerformedSetsConflictError(workoutExerciseId, operation)
  }
}

function validRestSeconds(value: number | null): boolean {
  return value == null || (Number.isFinite(value) && value >= 0 && value <= 3600)
}

/** The next position (max + 1) for appending an exercise. */
async function nextPosition(workoutId: string, tx: Tx): Promise<number> {
  const [row] = (
    await tx.execute(
      sql`SELECT COALESCE(max(position), -1) + 1 AS next FROM workout_exercises WHERE workout_id = ${workoutId}`,
    )
  ).rows as unknown as { next: number }[]
  return row?.next ?? 0
}

// ---------------------------------------------------------------------------
// Name / notes / discard
// ---------------------------------------------------------------------------

/** Patch name/notes on an active workout. Returns null when not active (409). */
export async function patchWorkoutMeta(
  workoutId: string,
  meta: { name?: string | null; notes?: string | null },
): Promise<ActiveWorkout | null> {
  if (!(await isActive(workoutId))) return null
  const sets: ReturnType<typeof sql>[] = []
  if (meta.name !== undefined) sets.push(sql`name = ${meta.name}`)
  if (meta.notes !== undefined) sets.push(sql`notes = ${meta.notes}`)
  if (sets.length > 0) {
    await db.execute(sql`
      UPDATE workouts SET ${sql.join(sets, sql`, `)}
      WHERE id = ${workoutId} AND status = 'active'
    `)
  }
  return getActiveWorkoutById(workoutId)
}

/** Patch name/notes on a COMPLETED workout (naming a one-off from the finish
 *  sheet, after finish() already flipped the status). Returns true when a row
 *  changed. Active workouts keep going through patchWorkoutMeta. */
export async function patchCompletedWorkoutMeta(
  workoutId: string,
  meta: { name?: string | null; notes?: string | null },
): Promise<boolean> {
  const sets: ReturnType<typeof sql>[] = []
  if (meta.name !== undefined) sets.push(sql`name = ${meta.name}`)
  if (meta.notes !== undefined) sets.push(sql`notes = ${meta.notes}`)
  if (sets.length === 0) return false
  const res = await db.execute(sql`
    UPDATE workouts SET ${sql.join(sets, sql`, `)}
    WHERE id = ${workoutId} AND status = 'completed'
  `)
  return (res.rowCount ?? 0) > 0
}

/**
 * Discard an active workout → status='discarded' (rowcount-guarded transition
 * from 'active' only). Returns true when it flipped, false when it wasn't active
 * (already finished / discarded / missing) so the route can 404/409 honestly.
 */
export async function discardWorkout(workoutId: string): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE workouts SET status = 'discarded', ended_at = now()
    WHERE id = ${workoutId} AND status = 'active'
    RETURNING id, proposal_id
  `)
  const rows = res.rows as unknown as Array<{ id: string; proposal_id: string | null }>
  const flipped = rows.length > 0
  // Web Push (GYM_PLAN §2.7b): a discarded session has no next set — cancel the
  // pending rest ping so a stale "Rest over" can't fire after discard.
  if (flipped) cancelPushForWorkout(workoutId)

  // #1857: cancelling is not consuming. Starting a proposal moves it
  // 'proposed' → 'started', which un-stages it from the Train tab — so backing
  // out of the session left the user with no staged workout and nothing to restart
  // from, as if the plan had been thrown away. Put it back.
  //
  // Scoped to THIS workout's own proposal, and only while it is still
  // 'started': a proposal that has since been superseded, dismissed, or
  // consumed by a finished session must not be resurrected. Completing a
  // workout deliberately does none of this — that is the case where 'started'
  // is the correct final state.
  const proposalId = rows[0]?.proposal_id
  if (flipped && proposalId) {
    await db.execute(sql`
      UPDATE workout_proposals SET status = 'proposed'
      WHERE id = ${proposalId} AND status = 'started'
    `)
  }
  return flipped
}

/**
 * Undo the return-to-training ease for the LIVE session: put the template's own
 * weights back (#1790).
 *
 * No stored "original" is needed — the ramp never modifies the template, so the
 * template IS the original. Only UNCOMPLETED sets are rewritten; a set already
 * logged is history and stays exactly as performed (the same rule the completed
 * warmup guard enforces).
 *
 * Clears `start_notices.eased` so the banner does not reappear, and leaves any
 * injury flags in place — restoring weights says nothing about an injury.
 *
 * ⚠️ Rewrites `prescribed_weight` as well as `weight`. Restoring only the logged
 * weight left the logger's GHOST TARGETS still showing the eased number while
 * stamping `prescription_source = 'template'` — so the payload claimed the
 * template had prescribed a weight it never did. Found on prod 2026-08-27.
 */
export async function restoreTemplateWeights(
  workoutId: string,
): Promise<{ ok: true; restored: number } | { ok: false; error: string }> {
  const [w] = (
    await db.execute(sql`
      SELECT id, template_id, status, start_notices FROM workouts
      WHERE id = ${workoutId} LIMIT 1
    `)
  ).rows as unknown as Array<{
    id: string
    template_id: string | null
    status: string
    start_notices: unknown
  }>
  if (!w) return { ok: false, error: 'That workout no longer exists.' }
  if (w.status !== 'active') {
    return { ok: false, error: 'That workout is no longer active — its weights are history now.' }
  }
  if (!w.template_id) {
    return {
      ok: false,
      error: 'This session was not started from a template, so there are no template weights to restore.',
    }
  }

  const result = (
    await db.execute(sql`
      UPDATE workout_sets ws
      SET weight = ts.target_weight,
        weight_unit = ts.target_weight_unit,
        -- prescribed_* too, not just the logged weight (see the note above).
        prescribed_weight = ts.target_weight,
        prescribed_weight_unit = ts.target_weight_unit,
        prescription_source = 'template'
      FROM workout_exercises we, template_exercises te, template_sets ts
      WHERE ws.workout_exercise_id = we.id
        AND we.workout_id = ${workoutId}
        AND te.template_id = ${w.template_id}
        AND te.exercise_id = we.exercise_id
        AND ts.template_exercise_id = te.id
        AND ts.set_number = ws.set_number
        AND ws.completed = false
        AND ts.target_weight IS NOT NULL
      RETURNING ws.id
    `)
  ).rows as unknown as Array<{ id: string }>

  const notices = (w.start_notices as StartNotices | null) ?? null
  const remaining =
    notices && notices.injuries.length > 0 ? { eased: [], injuries: notices.injuries } : null
  await db.execute(sql`
    UPDATE workouts
    SET start_notices = ${remaining == null ? null : sql`${JSON.stringify(remaining)}::jsonb`},
      revision = revision + 1
    WHERE id = ${workoutId}
  `)

  return { ok: true, restored: result.length }
}
