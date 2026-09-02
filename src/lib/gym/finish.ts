/**
 * Finish flow (GYM_PLAN §4 "Finish flow", P2a) — the one place a live session
 * becomes history. finishWorkout():
 *   (a) require ≥1 completed set, else 422 { error: 'empty workout' };
 *   (b) flip status active→completed (rowcount-guarded), stamp ended_at + duration;
 *   (c) compute the FinishSummary (volume, counts, PRs vs ALL-TIME prior history);
 *   (d) auto-log the linked habit IDEMPOTENTLY (≥1 working set), calling the same
 *       internal fn the log_habit tool uses (logHabitForDate) — never HTTP;
 *   (e) enqueue ONE deterministic health retain (fail-open);
 *   (f) carry the template-update verdict (the apply step is a separate route).
 *
 * PR math REUSES lib/gym/records.ts (computeRecords) — the same Epley + warmup /
 * weighted / assisted exclusions, so a "PR" here can never disagree with the
 * exercise-detail records or a goal signal. A warmup heavier than the working PR
 * must NOT trigger (records.ts drops warmups; a regression test pins it).
 */
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { displayExerciseName } from '@/lib/gym/display-name'
import { cancelPushForWorkout } from '@/lib/gym/push'
import { enqueueRetain } from '@/lib/ai/retain-queue'
import { logHabitForDate } from '@/lib/habits'
import { workoutRetainDocumentId } from '@/lib/memory/document-id'
import { getAppTimezone, todayInZone } from '@/lib/today'
import { taggedKind } from '@/lib/tags'
import { convertWeight, normalizeWeightUnit, type WeightUnit } from '@/lib/units/weight'
import { carryableProgressionCount } from './templates-read'
import {
  loadVolume,
  logicalSetKey,
  normalizeLoadBasis,
  normalizeSetSide,
  type LoadBasis,
} from './load-semantics'
import {
  computeRecords,
  toLb,
  type SetInput,
  type Tracks,
} from './records'
import {
  buildTemplateUpdate,
  diffWorkoutVsTemplate,
  matchExerciseSlots,
  sameExactSetPrescription,
  type DiffVerdict,
  type TemplateExerciseShape,
  type UpdateMode,
  type WorkoutExerciseShape,
} from './template-diff'
import {
  buildTemplateFromWorkout,
  type TemplateSetInput,
  type WorkoutSetForTemplate,
} from './templates-read'

export type PrKind = 'weight' | 'e1rm' | 'volume' | 'reps'

export interface WorkoutPr {
  exerciseName: string
  kind: PrKind
  value: number
  unit: string
  /** The previous all-time best of this kind (null if none — first-ever). */
  prev: number | null
  /** True when this exercise has NO prior logged history at all (first-ever
   *  session), so every kind trivially "beats" a null prior. Lets the UI
   *  distinguish a real PR from a debut-session freebie. */
  isDebut?: boolean
}

export interface FinishSummary {
  durationSeconds: number
  totalVolumeLb: number
  setsCompleted: number
  exercisesCompleted: number
  prs: WorkoutPr[]
  habitLogged: boolean
  templateDiff: { verdict: DiffVerdict; canUpdate: boolean }
  /** The template this session ran from, when it had one. `progressionExercises`
   * counts the exercises whose policy would carry onto a NEW template saved from
   * this workout — 0 means there's nothing to offer. */
  sourceTemplate: { name: string; progressionExercises: number } | null
}

/** API/display shape for the live finish sheet. The canonical summary stays in
 * pounds for records and retention; only this read model follows the app-wide
 * display setting. */
export interface DisplayFinishSummary extends FinishSummary {
  totalVolume: number
  weightUnit: WeightUnit
}

/** Convert the canonical finish result at the user-visible boundary. */
export function finishSummaryForDisplay(
  summary: FinishSummary,
  displayUnit: WeightUnit,
): DisplayFinishSummary {
  return {
    ...summary,
    totalVolume: Math.round(convertWeight(summary.totalVolumeLb, 'lb', displayUnit) ?? 0),
    weightUnit: displayUnit,
    prs: summary.prs.map((pr) => {
      if (pr.kind === 'reps') return pr
      return {
        ...pr,
        value: round1(convertWeight(pr.value, 'lb', displayUnit, 1) ?? pr.value),
        prev:
          pr.prev == null
            ? null
            : round1(convertWeight(pr.prev, 'lb', displayUnit, 1) ?? pr.prev),
        unit: displayUnit,
      }
    }),
  }
}

export type FinishResult =
  | { ok: true; summary: FinishSummary }
  | { ok: false; status: 422; error: 'empty workout' }
  | { ok: false; status: 404 } // not active / missing (lost the transition race)

interface FinishRow {
  workout_id: string
  template_id: string | null
  workout_name: string | null
  started_at: string
  exercise_id: string
  exercise_name: string
  tracks: string
  load_basis: string
  we_position: number
  we_superset: number | null
  exercise_rest_seconds: number | null
  exercise_rest_seconds_warmup: number | null
  section: string
  exercise_notes: string | null
  set_number: number | null
  set_type: string
  weight: string | null
  unit: string
  reps: number | null
  distance_m: string | null
  duration_s: number | null
  rpe: string | null
  prescribed_weight: string | null
  prescribed_weight_unit: string
  prescribed_reps: number | null
  prescribed_distance_m: string | null
  prescribed_duration_s: number | null
  prescribed_rpe: string | null
  rest_seconds: number | null
  side: string | null
  logical_set_id: string | null
  completed: boolean
  workout_day: string
}

function num(v: string | null): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Finish an active workout. Returns a discriminated result the route maps to
 * 200 / 422 / 404. The status flip is rowcount-guarded so a double-finish (or a
 * finish racing a discard) resolves to exactly one winner.
 */
export async function finishWorkout(workoutId: string): Promise<FinishResult> {
  // Pull the whole session (all sets across all exercises) in one read.
  const rows = (
    await db.execute(sql`
      SELECT w.id AS workout_id, w.template_id, w.name AS workout_name,
        w.started_at::text AS started_at, e.id AS exercise_id, e.name AS exercise_name,
        e.tracks, e.load_basis, we.position AS we_position, we.superset_group AS we_superset,
        we.rest_seconds AS exercise_rest_seconds,
        we.rest_seconds_warmup AS exercise_rest_seconds_warmup,
        we.section, we.notes AS exercise_notes,
        ws.set_number, ws.set_type, ws.weight::text AS weight, ws.weight_unit AS unit, ws.reps,
        ws.distance_m::text AS distance_m, ws.duration_s, ws.rpe::text AS rpe,
        ws.prescribed_weight::text AS prescribed_weight,
        ws.prescribed_weight_unit, ws.prescribed_reps,
        ws.prescribed_distance_m::text AS prescribed_distance_m,
        ws.prescribed_duration_s, ws.prescribed_rpe::text AS prescribed_rpe,
        ws.rest_seconds, ws.side, ws.logical_set_id::text AS logical_set_id, ws.completed,
        w.started_at::date::text AS workout_day
      FROM workouts w
      JOIN workout_exercises we ON we.workout_id = w.id
      JOIN exercises e ON e.id = we.exercise_id
      LEFT JOIN workout_sets ws ON ws.workout_exercise_id = we.id
      WHERE w.id = ${workoutId} AND w.status = 'active'
      ORDER BY we.position, ws.set_number
    `)
  ).rows as unknown as FinishRow[]

  if (rows.length === 0) {
    // Either the workout isn't active (already finished/discarded/missing) or it
    // has no exercises at all. Distinguish: probe the status.
    const active = await isActive(workoutId)
    if (!active) return { ok: false, status: 404 }
    // Active but no exercise/set rows → empty.
    return { ok: false, status: 422, error: 'empty workout' }
  }

  // A "completed set" = a real logged set marked completed (weight or reps or
  // duration present). Placeholder rows (all-null) don't count.
  const completedSets = rows.filter((r) => r.completed && hasData(r))
  if (completedSets.length === 0) {
    return { ok: false, status: 422, error: 'empty workout' }
  }

  const startedAt = new Date(completedSets[0]!.started_at)
  const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000))

  // ---- (b) flip status (rowcount-guarded) ----
  const flip = await db.execute(sql`
    UPDATE workouts
    SET status = 'completed', ended_at = now(), duration_seconds = ${durationSeconds}
    WHERE id = ${workoutId} AND status = 'active'
    RETURNING id
  `)
  if ((flip.rows as unknown as { id: string }[]).length === 0) {
    // Lost the race (a concurrent finish/discard won) — honest 404.
    return { ok: false, status: 404 }
  }

  // Web Push (GYM_PLAN §2.7b): the session is over — cancel any pending rest ping.
  cancelPushForWorkout(workoutId)

  // ---- (c) summary numbers ----
  const totalVolumeLb = computeTotalVolume(completedSets)
  const exerciseIds = new Set(completedSets.map((r) => r.exercise_id))
  const summary: FinishSummary = {
    durationSeconds,
    totalVolumeLb,
    setsCompleted: logicalSetCount(completedSets),
    exercisesCompleted: exerciseIds.size,
    prs: await detectPRs(workoutId, completedSets),
    habitLogged: false,
    templateDiff: await computeTemplateDiff(rows),
    sourceTemplate: await loadSourceTemplate(workoutId, rows[0]?.template_id ?? null),
  }

  // ---- (d) habit auto-log (idempotent, ≥1 working set) ----
  const hasWorkingSet = completedSets.some((r) => r.set_type !== 'warmup')
  if (hasWorkingSet) {
    summary.habitLogged = await autoLogHabit(workoutId)
  }

  // ---- (e) one health retain (fail-open) ----
  enqueueWorkoutRetain(workoutId, completedSets[0]!.workout_name, summary)

  return { ok: true, summary }
}

/** A row carries real data (not an all-null placeholder). */
function hasData(r: FinishRow): boolean {
  return (
    (num(r.weight) ?? 0) > 0 ||
    (r.reps ?? 0) > 0 ||
    (r.duration_s ?? 0) > 0 ||
    (num(r.distance_m) ?? 0) > 0
  )
}

async function isActive(workoutId: string): Promise<boolean> {
  const [row] = (
    await db.execute(sql`SELECT status FROM workouts WHERE id = ${workoutId} LIMIT 1`)
  ).rows as unknown as { status: string }[]
  return row?.status === 'active'
}

/** Total working-set volume in lb (warmup + assisted excluded; weighted = added
 *  weight only — mirrors records.ts). Per-side Both rows count two sides; split
 *  L/R rows each count one side. Equipment never changes the convention. */
function computeTotalVolume(sets: FinishRow[]): number {
  let total = 0
  for (const r of sets) {
    if (r.set_type === 'warmup') continue
    if (r.tracks === 'assisted_bodyweight') continue // assistance isn't load
    if (r.tracks !== 'weight_reps' && r.tracks !== 'weighted_bodyweight') continue
    const w = num(r.weight)
    const reps = r.reps
    if (w == null || w <= 0 || reps == null || reps <= 0) continue
    total += loadVolume(
      toLb(w, r.unit),
      reps,
      normalizeLoadBasis(r.load_basis),
      normalizeSetSide(r.side),
    )
  }
  return Math.round(total)
}

/** Completed physical rows collapse to their stable logical round identity. */
function logicalSetCount(sets: FinishRow[]): number {
  return new Set(sets.map((set, index) => logicalSetKey(set.logical_set_id, index))).size
}

// ---------------------------------------------------------------------------
// PR detection (REUSES records.ts math)
// ---------------------------------------------------------------------------

function toSetInput(r: FinishRow): SetInput {
  return {
    setType: r.set_type,
    weight: num(r.weight),
    unit: r.unit,
    reps: r.reps,
    distanceM: num(r.distance_m),
    durationS: r.duration_s,
    loadBasis: normalizeLoadBasis(r.load_basis),
    side: normalizeSetSide(r.side),
    logicalSetId: r.logical_set_id,
    date: r.workout_day,
  }
}

/**
 * PRs = this session's best (weight / e1rm / volume / reps) that BEAT the all-time
 * prior best for that exercise. Prior history = every completed set of the
 * exercise EXCLUDING this workout (which is now 'completed' after the flip — we
 * exclude by workout id). Reuses computeRecords so exclusions (warmup / weighted /
 * assisted) are identical to the detail surface.
 */
async function detectPRs(
  workoutId: string,
  sessionSets: FinishRow[],
): Promise<WorkoutPr[]> {
  const prs: WorkoutPr[] = []
  const byExercise = new Map<string, {
    name: string
    tracks: Tracks
    loadBasis: LoadBasis
    sets: FinishRow[]
  }>()
  for (const r of sessionSets) {
    let ex = byExercise.get(r.exercise_id)
    if (!ex) {
      ex = {
        name: displayExerciseName(r.exercise_name),
        tracks: r.tracks as Tracks,
        loadBasis: normalizeLoadBasis(r.load_basis),
        sets: [],
      }
      byExercise.set(r.exercise_id, ex)
    }
    ex.sets.push(r)
  }

  for (const [exerciseId, ex] of byExercise) {
    const priorSets = await priorHistorySets(exerciseId, workoutId, ex.loadBasis)
    // No prior history at all → this is the exercise's first-ever logged
    // session, so every kind trivially beats a null prior. Flagged so the UI
    // can call these out as debut logs rather than a wall of "new records".
    const isDebut = priorSets.length === 0
    const prior = computeRecords(priorSets, ex.tracks)
    const session = computeRecords(ex.sets.map(toSetInput), ex.tracks)

    // weight PR (heaviest working set; for assisted "best" is least assistance).
    if (session.bestWeight) {
      const beats =
        prior.bestWeight == null ||
        (ex.tracks === 'assisted_bodyweight'
          ? session.bestWeight.value < prior.bestWeight.value
          : session.bestWeight.value > prior.bestWeight.value)
      if (beats) {
        prs.push({
          exerciseName: ex.name,
          kind: 'weight',
          value: round1(session.bestWeight.value),
          unit: 'lb',
          prev: prior.bestWeight ? round1(prior.bestWeight.value) : null,
          isDebut,
        })
      }
    }
    // e1RM PR (weight_reps only — records.ts computes it only there).
    if (session.bestE1rm && (prior.bestE1rm == null || session.bestE1rm.value > prior.bestE1rm.value)) {
      prs.push({
        exerciseName: ex.name,
        kind: 'e1rm',
        value: round1(session.bestE1rm.value),
        unit: 'lb',
        prev: prior.bestE1rm ? round1(prior.bestE1rm.value) : null,
        isDebut,
      })
    }
    // Best logical-set volume PR. Both and paired L/R representations compare
    // identically because records.ts owns the grouping semantics.
    if (session.bestSetVolume) {
      const sessionVol = session.bestSetVolume.value
      const priorVol = prior.bestSetVolume?.value ?? null
      if (priorVol == null || sessionVol > priorVol) {
        prs.push({
          exerciseName: ex.name,
          kind: 'volume',
          value: round1(sessionVol),
          unit: 'lb',
          prev: priorVol != null ? round1(priorVol) : null,
          isDebut,
        })
      }
    }
    // reps PR (max working-set reps) — meaningful for reps/bodyweight tracks.
    const sessionMaxReps = maxWorkingReps(ex.sets)
    const priorMaxReps = maxRepsFromInputs(priorSets)
    if (sessionMaxReps != null && (priorMaxReps == null || sessionMaxReps > priorMaxReps)) {
      prs.push({
        exerciseName: ex.name,
        kind: 'reps',
        value: sessionMaxReps,
        unit: 'reps',
        prev: priorMaxReps,
        isDebut,
      })
    }
  }
  return prs
}

/** All completed sets of an exercise EXCEPT this workout, as SetInput. */
async function priorHistorySets(
  exerciseId: string,
  excludeWorkoutId: string,
  loadBasis: LoadBasis,
): Promise<SetInput[]> {
  const rows = (
    await db.execute(sql`
      SELECT ws.set_type, ws.weight::text AS weight, ws.weight_unit AS unit, ws.reps,
        ws.distance_m::text AS distance_m, ws.duration_s, ws.side,
        ws.logical_set_id::text AS logical_set_id, w.started_at::date::text AS day
      FROM workout_sets ws
      JOIN workout_exercises we ON ws.workout_exercise_id = we.id
      JOIN workouts w ON we.workout_id = w.id AND w.status = 'completed'
      WHERE we.exercise_id = ${exerciseId} AND w.id <> ${excludeWorkoutId}
    `)
  ).rows as unknown as Array<{
    set_type: string
    weight: string | null
    unit: string
    reps: number | null
    distance_m: string | null
    duration_s: number | null
    side: string | null
    logical_set_id: string | null
    day: string
  }>
  return rows.map((r) => ({
    setType: r.set_type,
    weight: num(r.weight),
    unit: r.unit,
    reps: r.reps,
    distanceM: num(r.distance_m),
    durationS: r.duration_s,
    loadBasis,
    side: normalizeSetSide(r.side),
    logicalSetId: r.logical_set_id,
    date: r.day,
  }))
}

/** Max reps across working (non-warmup) sets of a session. */
function maxWorkingReps(sets: FinishRow[]): number | null {
  let max: number | null = null
  for (const r of sets) {
    if (r.set_type === 'warmup') continue
    if (r.reps != null && r.reps > 0 && (max == null || r.reps > max)) max = r.reps
  }
  return max
}

function maxRepsFromInputs(sets: SetInput[]): number | null {
  let max: number | null = null
  for (const s of sets) {
    if (s.setType === 'warmup') continue
    if (s.reps != null && s.reps > 0 && (max == null || s.reps > max)) max = s.reps
  }
  return max
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// ---------------------------------------------------------------------------
// (d) habit auto-log
// ---------------------------------------------------------------------------

/**
 * Auto-log the gym-linked habit for TODAY, idempotently. Reads
 * app_settings.gym_linked_habit_id; if set, and the habit isn't already logged
 * today, calls logHabitForDate (the same internal fn the log_habit tool uses — no
 * HTTP). Returns true if a log now exists for today (whether we wrote it or it was
 * already there). Fail-open: never let a habit hiccup break the finish.
 */
export async function autoLogHabit(workoutId: string): Promise<boolean> {
  try {
    const [row] = (
      await db.execute(
        sql`SELECT gym_linked_habit_id AS habit_id FROM app_settings WHERE id = 1 LIMIT 1`,
      )
    ).rows as unknown as { habit_id: string | null }[]
    const habitId = row?.habit_id ?? null
    if (!habitId) return false

    const tz = await getAppTimezone()
    const today = todayInZone(tz)

    // Idempotency: don't clobber a manual entry (partial/skipped) for today.
    const [existing] = (
      await db.execute(
        sql`SELECT id FROM habit_log WHERE habit_id = ${habitId} AND date = ${today} LIMIT 1`,
      )
    ).rows as unknown as { id: string }[]
    if (existing) {
      // A manual habit tick has no gym provenance and must never be removed when
      // workout history is deleted. If another workout already owns this log,
      // this workout joins that managed completion so the final owner removes it.
      const [managed] = (
        await db.execute(sql`
          SELECT 1 AS one FROM gym_habit_log_links
          WHERE habit_log_id = ${existing.id} AND gym_managed = true
          LIMIT 1
        `)
      ).rows as unknown as Array<{ one: number }>
      if (managed) {
        await db.execute(sql`
          INSERT INTO gym_habit_log_links (
            workout_id, habit_id, habit_log_id, habit_date, gym_managed
          ) VALUES (${workoutId}, ${habitId}, ${existing.id}, ${today}, true)
          ON CONFLICT (workout_id) DO NOTHING
        `)
      }
      return true
    }

    const log = await logHabitForDate({
      habit_id: habitId,
      date: today,
      completion_state: 'full',
      logged_via: 'app',
    })
    await db.execute(sql`
      INSERT INTO gym_habit_log_links (
        workout_id, habit_id, habit_log_id, habit_date, gym_managed
      ) VALUES (${workoutId}, ${habitId}, ${log.id}, ${today}, true)
      ON CONFLICT (workout_id) DO NOTHING
    `)
    return true
  } catch (err) {
    console.warn('[gym/finish] habit auto-log failed (continuing):', err instanceof Error ? err.message : err)
    return false
  }
}

// ---------------------------------------------------------------------------
// (e) retain
// ---------------------------------------------------------------------------

/** Enqueue one deterministic health retain for the finished workout. */
function enqueueWorkoutRetain(
  workoutId: string,
  workoutName: string | null,
  summary: FinishSummary,
): void {
  try {
    const label = workoutName ? `${workoutName}` : 'Workout'
    const mins = Math.round(summary.durationSeconds / 60)
    const prText =
      summary.prs.length > 0
        ? ` PRs: ${summary.prs
            .filter((p) => p.kind === 'e1rm' || p.kind === 'weight')
            .slice(0, 3)
            .map((p) => `${p.exerciseName} ${round1(p.value)}${p.unit === 'lb' ? 'lb' : ''}`)
            .join(', ')}.`
        : ''
    const content =
      `Workout: ${label} — ${summary.exercisesCompleted} exercise${summary.exercisesCompleted === 1 ? '' : 's'}, ` +
      `${summary.setsCompleted} set${summary.setsCompleted === 1 ? '' : 's'}, ` +
      `${summary.totalVolumeLb.toLocaleString('en-US')} lb volume, ${mins} min.${prText}`
    enqueueRetain(content, {
      bank: 'health',
      context: { skill: 'workout_log', surface: 'web' },
      tags: [taggedKind('workout')],
      surfaceInChat: false,
      documentId: workoutRetainDocumentId(workoutId),
    })
  } catch (err) {
    // Fail-open: a retain hiccup never fails the finish.
    console.warn('[gym/finish] retain failed (continuing):', err instanceof Error ? err.message : err)
  }
}

// ---------------------------------------------------------------------------
// (f) template diff
// ---------------------------------------------------------------------------

/** Compute the template-update verdict for the finish summary. */
/** Name + carryable-policy count for the template a session ran from. Fail-open:
 *  the finish sheet degrades to "no progression to carry", never an error. */
async function loadSourceTemplate(
  workoutId: string,
  templateId: string | null,
): Promise<FinishSummary['sourceTemplate']> {
  if (!templateId) return null
  try {
    const [row] = (
      await db.execute(
        sql`SELECT name FROM workout_templates WHERE id = ${templateId} LIMIT 1`,
      )
    ).rows as unknown as Array<{ name: string }>
    if (!row) return null
    return {
      name: row.name,
      progressionExercises: await carryableProgressionCount(workoutId),
    }
  } catch {
    return null
  }
}

async function computeTemplateDiff(
  allRows: FinishRow[],
): Promise<{ verdict: DiffVerdict; canUpdate: boolean }> {
  const templateId = allRows[0]?.template_id ?? null
  if (!templateId) return { verdict: 'unchanged', canUpdate: false }

  const template = await loadTemplateForApply(templateId)
  const workout = buildWorkoutShape(allRows)
  const diff = diffWorkoutVsTemplate(template, workout, true)
  if (diff.verdict !== 'unchanged') {
    return { verdict: diff.verdict, canUpdate: diff.canUpdate }
  }

  const logged = buildTemplateFromWorkout(allRows.map(finishRowToTemplateInput))
  const exactSetsMatch = sameExactSetPrescription(template, logged)
  const metadataMatch = sameTemplateValueMetadata(template, logged)
  return {
    verdict: exactSetsMatch && metadataMatch ? 'unchanged' : 'values_changed',
    canUpdate: true,
  }
}

/** Build the same full History-visible/prescribed projection used by Apply. An
 * unchecked planned row is not a deletion: actual values win when present and
 * untouched rows retain their prescription. */
function buildWorkoutShape(allRows: FinishRow[]): WorkoutExerciseShape[] {
  // Every exercise in the workout (even with zero completed sets) is part of the
  // structure; its working-set list may be empty.
  const byExercise = new Map<string, WorkoutExerciseShape>()
  for (const r of allRows) {
    const slotKey = `${r.we_position}:${r.exercise_id}`
    if (!byExercise.has(slotKey)) {
      byExercise.set(slotKey, {
        exerciseId: r.exercise_id,
        position: r.we_position,
        supersetGroup: r.we_superset,
        workingSets: [],
      })
    }
  }
  for (const r of allRows) {
    if (r.set_number == null || r.set_type === 'warmup') continue
    byExercise.get(`${r.we_position}:${r.exercise_id}`)!.workingSets.push({
      reps: r.reps ?? r.prescribed_reps,
      weight: num(r.weight ?? r.prescribed_weight),
      weightUnit: normalizeWeightUnit(
        r.weight != null ? r.unit : r.prescribed_weight_unit,
      ),
      logicalSetId: r.logical_set_id,
    })
  }
  return [...byExercise.values()].sort((a, b) => a.position - b.position)
}

/** Preserve every materialized set for exact template comparison. Actual values
 * win when logged; untouched rows fall back field-by-field to their prescription. */
function finishRowToTemplateInput(row: FinishRow): WorkoutSetForTemplate {
  return {
    exerciseId: row.exercise_id,
    position: row.we_position,
    supersetGroup: row.we_superset,
    exerciseRestSeconds: row.exercise_rest_seconds,
    exerciseRestSecondsWarmup: row.exercise_rest_seconds_warmup,
    section: row.section,
    exerciseNotes: row.exercise_notes,
    setNumber: row.set_number,
    setType: row.set_type ?? 'normal',
    weight: num(row.weight ?? row.prescribed_weight),
    weightUnit: normalizeWeightUnit(
      row.weight != null ? row.unit : row.prescribed_weight_unit,
    ),
    reps: row.reps ?? row.prescribed_reps,
    distanceM: num(row.distance_m ?? row.prescribed_distance_m),
    durationS: row.duration_s ?? row.prescribed_duration_s,
    rpe: num(row.rpe ?? row.prescribed_rpe),
    restSeconds: row.rest_seconds,
    side: exactSide(row.side),
    logicalSetId: row.logical_set_id,
  }
}

/** Template-level rest values may inherit from the exercise. Starting a workout
 * snapshots that resolved value, so compare against the same resolution instead
 * of treating every inherited default as a user edit. */
function sameTemplateValueMetadata(
  template: ApplyTemplateSlot[],
  logged: ReturnType<typeof buildTemplateFromWorkout>,
): boolean {
  const loggedByPosition = new Map(logged.map((slot) => [slot.position, slot]))
  return template.every((slot) => {
    const after = loggedByPosition.get(slot.position)
    if (!after || after.exerciseId !== slot.exerciseId) return false
    const resolvedRest = slot.restSeconds ?? slot.exerciseDefaultRestSeconds
    const resolvedWarmupRest = slot.restSecondsWarmup ?? slot.exerciseDefaultRestSecondsWarmup
    return (
      after.restSeconds === resolvedRest &&
      after.restSecondsWarmup === resolvedWarmupRest &&
      after.section === slot.section &&
      after.notes === slot.notes
    )
  })
}

// ---------------------------------------------------------------------------
// apply-template-update (write side; §4 separate route)
// ---------------------------------------------------------------------------

/**
 * Apply the workout's deviation back onto its template (replace-all in a
 * transaction, preserving surviving exercises' progression policies AND exact
 * ordered set prescriptions). Returns false when the workout has no template
 * (nothing to apply) — the route 404s.
 */
export async function applyTemplateUpdateForWorkout(
  workoutId: string,
  mode: UpdateMode,
): Promise<boolean> {
  const [w] = (
    await db.execute(sql`SELECT template_id FROM workouts WHERE id = ${workoutId} LIMIT 1`)
  ).rows as unknown as { template_id: string | null }[]
  const templateId = w?.template_id ?? null
  if (!templateId) return false

  // Reload the session (completed) + template to build the update rows.
  const rows = (
    await db.execute(sql`
      SELECT e.id AS exercise_id, we.position AS we_position,
        we.superset_group AS we_superset,
        we.rest_seconds AS exercise_rest_seconds,
        we.rest_seconds_warmup AS exercise_rest_seconds_warmup,
        we.section, we.notes AS exercise_notes,
        ws.set_number, ws.set_type,
        COALESCE(ws.weight, ws.prescribed_weight)::text AS weight,
        CASE
          WHEN ws.weight IS NOT NULL THEN ws.weight_unit
          ELSE ws.prescribed_weight_unit
        END AS unit,
        COALESCE(ws.reps, ws.prescribed_reps) AS reps,
        COALESCE(ws.distance_m, ws.prescribed_distance_m)::text AS distance_m,
        COALESCE(ws.duration_s, ws.prescribed_duration_s) AS duration_s,
        COALESCE(ws.rpe, ws.prescribed_rpe)::text AS rpe,
        ws.rest_seconds, ws.side, ws.logical_set_id::text AS logical_set_id
      FROM workouts w
      JOIN workout_exercises we ON we.workout_id = w.id
      JOIN exercises e ON e.id = we.exercise_id
      LEFT JOIN workout_sets ws ON ws.workout_exercise_id = we.id
      WHERE w.id = ${workoutId}
      ORDER BY we.position, ws.set_number, ws.created_at
    `)
  ).rows as unknown as Array<{
    exercise_id: string
    we_position: number
    we_superset: number | null
    exercise_rest_seconds: number | null
    exercise_rest_seconds_warmup: number | null
    section: string
    exercise_notes: string | null
    set_number: number | null
    set_type: string | null
    weight: string | null
    unit: string | null
    reps: number | null
    distance_m: string | null
    duration_s: number | null
    rpe: string | null
    rest_seconds: number | null
    side: string | null
    logical_set_id: string | null
  }>

  const workout = buildWorkoutShapeFromApplyRows(rows)
  const workoutExact = buildTemplateFromWorkout(rows.map(applyRowToTemplateInput))
  const templateExact = await loadTemplateForApply(templateId)
  const updates = buildTemplateUpdate(templateExact, workout, mode)
  const oldMatches = matchExerciseSlots(updates, templateExact)
  const loggedMatches = matchExerciseSlots(updates, workoutExact)

  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM template_exercises WHERE template_id = ${templateId}`)
    for (let updateIndex = 0; updateIndex < updates.length; updateIndex += 1) {
      const u = updates[updateIndex]!
      const old = oldMatches[updateIndex]
      const logged = loggedMatches[updateIndex]
      const takeLoggedValues = mode === 'values' || mode === 'both'
      const prescription = takeLoggedValues ? (logged ?? old) : (old ?? logged)
      const restSeconds = exerciseRestForUpdate(mode, old, logged, false)
      const restSecondsWarmup = exerciseRestForUpdate(mode, old, logged, true)
      const [inserted] = (
        await tx.execute(sql`
        INSERT INTO template_exercises (
          template_id, exercise_id, position, superset_group, target_sets,
          target_reps, target_weight, target_weight_unit, target_duration_s,
          rest_seconds, rest_seconds_warmup, section, progression, notes
        ) VALUES (
          ${templateId}, ${u.exerciseId}, ${u.position}, ${u.supersetGroup},
          ${u.targetSets}, ${u.targetReps}, ${u.targetWeight}, ${u.targetWeightUnit},
          ${prescription?.targetDurationS ?? null},
          ${restSeconds},
          ${restSecondsWarmup},
          ${prescription?.section ?? 'main'},
          ${u.progression == null ? null : sql`${JSON.stringify(u.progression)}::jsonb`},
          ${prescription?.notes ?? null}
        )
        RETURNING id
      `)
      ).rows as unknown as Array<{ id: string }>
      if (!inserted || !prescription) continue
      for (const set of prescription.sets) {
        const targetWeightLb = convertWeight(set.targetWeight, set.targetWeightUnit, 'lb')
        await tx.execute(sql`
          INSERT INTO template_sets (
            template_exercise_id, set_number, set_type,
            target_weight, target_weight_unit, target_reps,
            target_distance_m, target_duration_s, target_rpe,
            rest_seconds, side
          ) VALUES (
            ${inserted.id}, ${set.setNumber}, ${set.setType},
            ${targetWeightLb}, 'lb', ${set.targetReps},
            ${set.targetDistanceM}, ${set.targetDurationS}, ${set.targetRpe},
            ${set.restSeconds}, ${set.side}
          )
        `)
      }
    }
  })
  return true
}

interface ApplyTemplateSlot extends TemplateExerciseShape {
  targetDurationS: number | null
  restSeconds: number | null
  restSecondsWarmup: number | null
  exerciseDefaultRestSeconds: number | null
  exerciseDefaultRestSecondsWarmup: number | null
  section: string
  notes: string | null
  sets: TemplateSetInput[]
}

/** Full template snapshot for the Finish-sheet update path. Legacy scalar-only
 * templates are expanded so updating structure never erases their set intent. */
async function loadTemplateForApply(templateId: string): Promise<ApplyTemplateSlot[]> {
  const rows = (
    await db.execute(sql`
      SELECT te.exercise_id, te.position, te.superset_group,
        te.target_sets, te.target_reps,
        te.target_weight::text AS target_weight, te.target_weight_unit,
        te.target_duration_s, te.rest_seconds, te.rest_seconds_warmup,
        e.default_rest_seconds AS exercise_default_rest_seconds,
        e.rest_seconds_warmup AS exercise_default_rest_seconds_warmup,
        te.section, te.progression, te.notes,
        ts.set_number, ts.set_type,
        ts.target_weight::text AS set_target_weight,
        ts.target_weight_unit AS set_target_weight_unit,
        ts.target_reps AS set_target_reps,
        ts.target_distance_m::text AS set_target_distance_m,
        ts.target_duration_s AS set_target_duration_s,
        ts.target_rpe::text AS set_target_rpe,
        ts.rest_seconds AS set_rest_seconds, ts.side AS set_side
      FROM template_exercises te
      JOIN exercises e ON e.id = te.exercise_id
      LEFT JOIN template_sets ts ON ts.template_exercise_id = te.id
      WHERE te.template_id = ${templateId}
      ORDER BY te.position, ts.set_number
    `)
  ).rows as unknown as Array<{
    exercise_id: string
    position: number
    superset_group: number | null
    target_sets: number | null
    target_reps: number | null
    target_weight: string | null
    target_weight_unit: string
    target_duration_s: number | null
    rest_seconds: number | null
    rest_seconds_warmup: number | null
    exercise_default_rest_seconds: number | null
    exercise_default_rest_seconds_warmup: number | null
    section: string
    progression: unknown
    notes: string | null
    set_number: number | null
    set_type: string | null
    set_target_weight: string | null
    set_target_weight_unit: string | null
    set_target_reps: number | null
    set_target_distance_m: string | null
    set_target_duration_s: number | null
    set_target_rpe: string | null
    set_rest_seconds: number | null
    set_side: string | null
  }>

  const byExercise = new Map<string, ApplyTemplateSlot>()
  for (const row of rows) {
    const slotKey = `${row.position}:${row.exercise_id}`
    let slot = byExercise.get(slotKey)
    if (!slot) {
      slot = {
        exerciseId: row.exercise_id,
        position: row.position,
        supersetGroup: row.superset_group,
        targetSets: row.target_sets,
        targetReps: row.target_reps,
        targetWeight: num(row.target_weight),
        targetWeightUnit: normalizeWeightUnit(row.target_weight_unit),
        targetDurationS: row.target_duration_s ?? null,
        restSeconds: row.rest_seconds ?? null,
        restSecondsWarmup: row.rest_seconds_warmup ?? null,
        exerciseDefaultRestSeconds: row.exercise_default_rest_seconds ?? null,
        exerciseDefaultRestSecondsWarmup:
          row.exercise_default_rest_seconds_warmup ?? null,
        section: row.section ?? 'main',
        progression: row.progression ?? null,
        notes: row.notes ?? null,
        sets: [],
      }
      byExercise.set(slotKey, slot)
    }
    if (row.set_number != null) {
      slot.sets.push({
        setNumber: row.set_number,
        setType: exactSetType(row.set_type),
        targetWeight: num(row.set_target_weight),
        targetWeightUnit: normalizeWeightUnit(row.set_target_weight_unit),
        targetReps: row.set_target_reps ?? null,
        targetDistanceM: num(row.set_target_distance_m),
        targetDurationS: row.set_target_duration_s ?? null,
        targetRpe: num(row.set_target_rpe),
        restSeconds: row.set_rest_seconds ?? null,
        side: exactSide(row.set_side),
      })
    }
  }

  for (const slot of byExercise.values()) {
    if (slot.sets.length > 0) continue
    const hasTarget = slot.targetReps != null || slot.targetWeight != null || slot.targetDurationS != null
    const count = slot.targetSets != null && slot.targetSets > 0 ? slot.targetSets : hasTarget ? 1 : 0
    for (let index = 0; index < count; index += 1) {
      slot.sets.push({
        setNumber: index + 1,
        setType: 'normal',
        targetWeight: slot.targetWeight,
        targetWeightUnit: slot.targetWeightUnit,
        targetReps: slot.targetReps,
        targetDistanceM: null,
        targetDurationS: slot.targetDurationS,
        targetRpe: null,
        // Legacy scalar templates inherited their exercise-level rest; they did
        // not carry an explicit override on every generated set.
        restSeconds: null,
        side: null,
      })
    }
  }
  return [...byExercise.values()].sort((a, b) => a.position - b.position)
}

type LoggedTemplateSlot = ReturnType<typeof buildTemplateFromWorkout>[number]

/** Pure rest-override merge used by the Finish-sheet template update. Undefined
 * previousExplicit means the exercise is new; null means the old template
 * intentionally inherited its exercise default. */
export function templateRestAfterUpdate(input: {
  mode: UpdateMode
  previousExplicit?: number | null
  previousDefault?: number | null
  logged?: number | null
}): number | null {
  const hasPrevious = input.previousExplicit !== undefined
  if (input.mode === 'structure' && hasPrevious) return input.previousExplicit ?? null
  if (input.logged === undefined) return input.previousExplicit ?? null
  if (!hasPrevious) return input.logged

  const inheritedWasUnchanged =
    input.previousExplicit == null && input.logged === (input.previousDefault ?? null)
  return inheritedWasUnchanged ? null : input.logged
}

/** Keep an inherited template rest value inherited when the workout merely
 * snapshotted the exercise default. If the live workout actually changed it,
 * values/both modes retain that explicit edit. */
function exerciseRestForUpdate(
  mode: UpdateMode,
  old: ApplyTemplateSlot | undefined,
  logged: LoggedTemplateSlot | undefined,
  warmup: boolean,
): number | null {
  const field = warmup ? 'restSecondsWarmup' : 'restSeconds'
  return templateRestAfterUpdate({
    mode,
    previousExplicit: old ? old[field] : undefined,
    previousDefault: old
      ? warmup
        ? old.exerciseDefaultRestSecondsWarmup
        : old.exerciseDefaultRestSeconds
      : undefined,
    logged: logged ? logged[field] : undefined,
  })
}

function applyRowToTemplateInput(row: {
  exercise_id: string
  we_position: number
  we_superset: number | null
  exercise_rest_seconds: number | null
  exercise_rest_seconds_warmup: number | null
  section: string
  exercise_notes: string | null
  set_number: number | null
  set_type: string | null
  weight: string | null
  unit: string | null
  reps: number | null
  distance_m: string | null
  duration_s: number | null
  rpe: string | null
  rest_seconds: number | null
  side: string | null
  logical_set_id: string | null
}): WorkoutSetForTemplate {
  return {
    exerciseId: row.exercise_id,
    position: row.we_position,
    supersetGroup: row.we_superset,
    exerciseRestSeconds: row.exercise_rest_seconds,
    exerciseRestSecondsWarmup: row.exercise_rest_seconds_warmup,
    section: row.section,
    exerciseNotes: row.exercise_notes,
    setNumber: row.set_number,
    setType: row.set_type ?? 'normal',
    weight: num(row.weight),
    weightUnit: normalizeWeightUnit(row.unit),
    reps: row.reps,
    distanceM: num(row.distance_m),
    durationS: row.duration_s,
    rpe: num(row.rpe),
    restSeconds: row.rest_seconds,
    side: exactSide(row.side),
    logicalSetId: row.logical_set_id,
  }
}

function exactSetType(value: string | null): TemplateSetInput['setType'] {
  return value === 'warmup' || value === 'drop' || value === 'failure' ? value : 'normal'
}

function exactSide(value: string | null): 'left' | 'right' | null {
  return value === 'left' || value === 'right' ? value : null
}

function buildWorkoutShapeFromApplyRows(
  rows: Array<{
    exercise_id: string
    we_position: number
    we_superset: number | null
    set_number: number | null
    set_type: string | null
    weight: string | null
    unit: string | null
    reps: number | null
    logical_set_id: string | null
  }>,
): WorkoutExerciseShape[] {
  const byExercise = new Map<string, WorkoutExerciseShape>()
  for (const r of rows) {
    const slotKey = `${r.we_position}:${r.exercise_id}`
    let ex = byExercise.get(slotKey)
    if (!ex) {
      ex = {
        exerciseId: r.exercise_id,
        position: r.we_position,
        supersetGroup: r.we_superset,
        workingSets: [],
      }
      byExercise.set(slotKey, ex)
    }
    // Every non-warmup row in the completed session is part of the exact
    // prescription. Timed/distance sets legitimately have no reps or weight.
    if (r.set_number != null && r.set_type && r.set_type !== 'warmup') {
      ex.workingSets.push({
        reps: r.reps,
        weight: num(r.weight),
        weightUnit: normalizeWeightUnit(r.unit),
        logicalSetId: r.logical_set_id,
      })
    }
  }
  return [...byExercise.values()].sort((a, b) => a.position - b.position)
}
