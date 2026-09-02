/**
 * agent-edit.ts — the op → active-workout mapping for the LIVE session editor.
 *
 * This module is the single place where an *agent's* vocabulary ("add this
 * exercise", "make it 4×8", "swap that for something my shoulder allows") is
 * translated into the exact same `lib/gym/active-workout.ts` calls the in-app
 * logger uses. The UI and the agent therefore cannot drift: there is one
 * writer, one revision counter, one set of invariants.
 *
 * Invariants enforced here (all of them are also stated in the tool
 * descriptions, because they travel with the tool):
 *
 *  - Canonical state is re-read from the database before every op. Nothing is
 *    trusted from the caller except the ops themselves and `expected_revision`.
 *  - `expected_revision`, when supplied, is checked against the live revision
 *    BEFORE anything is written. A mismatch returns `stale_revision` with the
 *    current workout so the caller can re-read and retry. It never throws.
 *  - Completed performance is preserved by default. A programming change writes
 *    `prescribed_*` columns; the performed values a human entered are only ever
 *    touched when `apply_to_completed` is explicitly true (an acknowledged
 *    correction of logged data).
 *  - Warm-up sets are never counted as working sets, and a set-count change
 *    resizes the WORKING sets only.
 *  - Exercise additions and replacements must satisfy the active training
 *    constraints (`exerciseAllowedWithInjuries`), the same gate the drafting
 *    engine and the template-start path use.
 *
 * HTTP lives in `app/api/gym/workouts/active/edit/route.ts`; this file has no
 * knowledge of requests, responses or status codes.
 */
import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { z } from 'zod'

import { moveRow } from '@/components/gym/templates/editor-state'
import { db } from '@/lib/db/client'
import {
  editExercises,
  getActiveWorkout,
  patchWorkoutMeta,
  restoreTemplateWeights,
  upsertExerciseSetsIfUnchanged,
  upsertSets,
  ActiveWorkoutPerformedSetsConflictError,
  ActiveWorkoutRevisionConflictError,
  type ActiveExercise,
  type ActiveSet,
  type ActiveWorkout,
  type PrescriptionSource,
  type SetUpsertInput,
} from '@/lib/gym/active-workout'
import { listInjuries } from '@/lib/gym/injuries-gyms'
import {
  exerciseAllowedWithInjuries,
  parseExerciseInjuryProfile,
  type InjuryConstraint,
} from '@/lib/gym/injury-profile'
import { convertWeight, type WeightUnit } from '@/lib/units/weight'

// ---------------------------------------------------------------------------
// Request schema — the op vocabulary
// ---------------------------------------------------------------------------

/**
 * Exact ordered warm-up target. Array order IS workout order; `set_type` is
 * implicit and always `warmup`.
 */
export const WarmupSetInput = z.object({
  weight: z.number().min(0).nullish(),
  weight_unit: z.enum(['lb', 'kg']).nullish(),
  reps: z.number().int().min(0).max(1000).nullish(),
  duration_s: z.number().int().min(0).max(86_400).nullish(),
  rpe: z.number().min(0).max(10).nullish(),
  rest_seconds: z.number().int().min(0).max(3600).nullish(),
  side: z.enum(['left', 'right']).nullish(),
})
export type WarmupSetInputType = z.infer<typeof WarmupSetInput>

export const ACTIVE_EDIT_OPS = [
  'add_exercise',
  'remove_exercise',
  'replace_exercise',
  'reorder',
  'set_scheme',
  'set_weight',
  'set_warmup_sets',
  'set_rest',
  'set_superset',
  'clear_superset',
  'set_notes',
  'rename',
  'restore_template_weights',
] as const

export type ActiveEditOpName = (typeof ACTIVE_EDIT_OPS)[number]

/**
 * One edit. Field names mirror the private tool layer's schema exactly so this
 * module is a drop-in replacement for that layer's body upstream.
 */
export const ActiveEditOp = z.object({
  op: z.enum(ACTIVE_EDIT_OPS),
  /** Current active-workout exercise to edit (case-insensitive, partial ok). */
  exercise_name: z.string().min(1).nullish(),
  /** replace_exercise: the replacement, which must satisfy active constraints. */
  replacement_exercise_name: z.string().min(1).nullish(),
  /** set_superset: every open-workout exercise to put in one group. */
  exercise_names: z.array(z.string().min(1)).min(2).max(10).nullish(),
  /** reorder: destination shortcut. */
  to: z.enum(['top', 'bottom']).nullish(),
  /** add_exercise/reorder: 1-based destination in the current workout. */
  to_position: z.number().int().min(1).nullish(),
  /** set_scheme: absolute WORKING-set count; warmups preserved and excluded. */
  sets: z.number().int().min(1).max(20).nullish(),
  /** set_scheme: reps for working planned/incomplete sets only. */
  reps: z.number().int().min(0).max(1000).nullish(),
  /** set_scheme: relative WORKING-set change; warmups preserved. */
  sets_delta: z.number().int().min(-10).max(10).nullish(),
  /** set_weight: load for the selected set, or all working sets when omitted. */
  weight: z.number().min(0).nullish(),
  weight_unit: z.enum(['lb', 'kg']).nullish(),
  /** set_warmup_sets: exact ordered warm-up ramp; [] removes incomplete warmups. */
  warmup_sets: z.array(WarmupSetInput).max(12).nullish(),
  /** set_weight/set_rest: optional one-based set number. */
  set_number: z.number().int().min(1).max(50).nullish(),
  /** Programming edits preserve completed performance unless this is true. */
  apply_to_completed: z.boolean().nullish(),
  /** set_rest: rest after each set of this exercise. */
  rest_seconds: z.number().int().min(0).max(1200).nullish(),
  /** set_notes: this session's per-exercise cue. null clears it. */
  notes: z.string().max(2000).nullish(),
  /** rename: new live-workout name. */
  workout_name: z.string().min(1).max(120).nullish(),
})
export type ActiveEditOpInput = z.infer<typeof ActiveEditOp>

export const ActiveEditRequest = z.object({
  /**
   * The revision the caller believes is current (from get_active_workout).
   * Omit only for a blind edit; supplying it is what makes concurrent human +
   * agent editing safe.
   */
  expected_revision: z.number().int().min(0).nullish(),
  ops: z.array(ActiveEditOp).min(1).max(20),
})
export type ActiveEditRequestInput = z.infer<typeof ActiveEditRequest>

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface AppliedEdit {
  op: ActiveEditOpName
  change: string
}

export interface RejectedEdit {
  op: ActiveEditOpName
  error: string
}

export type ActiveEditResult =
  | {
      ok: true
      workout: ActiveWorkout
      revision: number
      applied: AppliedEdit[]
      rejected: RejectedEdit[]
    }
  | { ok: false; code: 'no_active_workout' }
  | {
      ok: false
      code: 'stale_revision'
      current_revision: number
      workout: ActiveWorkout
      applied: AppliedEdit[]
      rejected: RejectedEdit[]
    }

const STALE_MESSAGE =
  'The logger or another editor changed this workout. Re-read it with get_active_workout and retry the change.'

// ---------------------------------------------------------------------------
// Catalog resolution + the eligibility gate
// ---------------------------------------------------------------------------

interface CatalogRow {
  id: string
  name: string
  injury_profile: unknown
  injury_override: boolean | null
}

/**
 * Active training constraints in the shape the eligibility gate expects.
 * Mirrors `active-workout.ts`'s template-start path exactly (same reader, same
 * projection) so the agent and the app can never disagree about eligibility.
 */
async function activeConstraints(): Promise<InjuryConstraint[]> {
  return (await listInjuries(true)).map((injury) => ({
    region: injury.region,
    severity: injury.severity,
  })) as InjuryConstraint[]
}

/** Case-insensitive exact match, then a unique partial. Archived rows excluded. */
async function catalogCandidates(name: string): Promise<CatalogRow[]> {
  const wanted = name.trim().toLowerCase()
  return (
    await db.execute(sql`
      SELECT id, name, injury_profile, injury_override
      FROM exercises
      WHERE archived_at IS NULL
        AND (lower(name) = ${wanted} OR lower(name) LIKE ${'%' + wanted + '%'})
      ORDER BY (lower(name) = ${wanted}) DESC, length(name), name
      LIMIT 25
    `)
  ).rows as unknown as CatalogRow[]
}

export type CatalogResolve =
  | { ok: true; id: string; name: string }
  | { ok: false; error: string }

/**
 * Resolve a catalog exercise by name AND check it against the live training
 * constraints. This is the same gate `plan.ts` and the template-start path use;
 * an agent must never be able to route around it.
 */
export async function resolveEligibleExercise(name: string): Promise<CatalogResolve> {
  const rows = await catalogCandidates(name)
  if (rows.length === 0) {
    return { ok: false, error: `"${name}" isn't in the exercise catalog. Use search_exercises to find the exact name.` }
  }
  const wanted = name.trim().toLowerCase()
  const exact = rows.filter((row) => row.name.trim().toLowerCase() === wanted)
  const pool = exact.length > 0 ? exact : rows
  if (pool.length > 1) {
    return {
      ok: false,
      error: `"${name}" matches more than one exercise: ${pool.slice(0, 5).map((row) => row.name).join(', ')}. Name the exact one.`,
    }
  }
  const row = pool[0]!
  const injuries = await activeConstraints()
  if (!row.injury_override) {
    const verdict = exerciseAllowedWithInjuries(
      parseExerciseInjuryProfile(row.injury_profile),
      injuries,
    )
    if (!verdict.allowed) {
      return {
        ok: false,
        error:
          `"${row.name}" conflicts with an active training constraint ` +
          `(${verdict.blockingSites.join(', ') || 'unspecified region'}). ` +
          'Use search_exercises with eligible=1 and pick from what it returns.',
      }
    }
  }
  return { ok: true, id: row.id, name: row.name }
}

// ---------------------------------------------------------------------------
// Live-workout helpers (ported verbatim in behaviour from the tool layer)
// ---------------------------------------------------------------------------

type ActiveResolve = { ok: true; index: number } | { ok: false; error: string }

function resolveActiveExercise(exercises: ActiveExercise[], requested: string): ActiveResolve {
  const wanted = requested.trim().toLowerCase()
  const exact = exercises.findIndex((exercise) => exercise.name.trim().toLowerCase() === wanted)
  if (exact >= 0) return { ok: true, index: exact }
  const partial = exercises
    .map((exercise, index) => ({ exercise, index }))
    .filter(({ exercise }) => exercise.name.trim().toLowerCase().includes(wanted))
  if (partial.length === 1) return { ok: true, index: partial[0]!.index }
  if (partial.length > 1) {
    return {
      ok: false,
      error: `"${requested}" matches more than one active exercise: ${partial.map(({ exercise }) => exercise.name).join(', ')}. Name the exact one.`,
    }
  }
  return {
    ok: false,
    error: `"${requested}" isn't in the active workout. It has: ${exercises.map((exercise) => exercise.name).join(', ')}.`,
  }
}

function maxPlannedSetNumber(exercise: ActiveExercise): number {
  return Math.max(
    0,
    ...exercise.targets.map((target, index) => target.setNumber ?? index + 1),
    ...exercise.sets.map((set) => set.setNumber),
  )
}

interface ActivePlannedRow {
  existing: ActiveSet | null
  setNumber: number
  setType: string
  weight: number | null
  weightUnit: string
  reps: number | null
  distanceM: number | null
  durationS: number | null
  rpe: number | null
  restSeconds: number | null
  side: 'left' | 'right' | null
  completed: boolean
  prescribedWeight: number | null
  prescribedWeightUnit: string | null
  prescribedReps: number | null
  prescribedDistanceM: number | null
  prescribedDurationS: number | null
  prescribedRpe: number | null
  prescriptionSource: PrescriptionSource | null
}

/**
 * The exercise's rows as "planned + performed", merged by set number. Existing
 * rows are performed data: every null is preserved verbatim, because a target
 * must never back-fill an unreported actual.
 */
function activePlannedRows(exercise: ActiveExercise): ActivePlannedRow[] {
  const targets = new Map<number, ActiveExercise['targets'][number]>()
  exercise.targets.forEach((target, index) => targets.set(target.setNumber ?? index + 1, target))
  const actuals = new Map(exercise.sets.map((set) => [set.setNumber, set]))
  const numbers = [...new Set([...targets.keys(), ...actuals.keys()])].sort((a, b) => a - b)
  return numbers.map((setNumber) => {
    const existing = actuals.get(setNumber) ?? null
    const target = targets.get(setNumber)
    return {
      existing,
      setNumber,
      setType: existing?.setType ?? target?.setType ?? 'normal',
      weight: existing ? existing.weight : null,
      weightUnit: existing?.weightUnit ?? target?.weightUnit ?? exercise.preferredUnit,
      reps: existing ? existing.reps : null,
      distanceM: existing ? existing.distanceM : null,
      durationS: existing ? existing.durationS : null,
      rpe: existing ? existing.rpe : null,
      restSeconds: existing ? (existing.restSeconds ?? null) : (target?.restSeconds ?? null),
      side: existing ? existing.side : (target?.side ?? null),
      completed: existing?.completed ?? false,
      prescribedWeight: target?.weight ?? null,
      prescribedWeightUnit: target?.weightUnit ?? null,
      prescribedReps: target?.reps ?? null,
      prescribedDistanceM: target?.distanceM ?? null,
      prescribedDurationS: target?.durationS ?? null,
      prescribedRpe: target?.rpe ?? null,
      prescriptionSource: target?.source ?? null,
    }
  })
}

/** WORKING set numbers only — warm-ups are never working volume. */
function activeWorkingSetNumbers(exercise: ActiveExercise): number[] {
  return activePlannedRows(exercise)
    .filter((set) => set.setType !== 'warmup')
    .map((set) => set.setNumber)
}

interface NormalizedWarmupSet {
  weight: number | null
  weightUnit: WeightUnit
  reps: number | null
  durationS: number | null
  rpe: number | null
  restSeconds: number | null
  side: 'left' | 'right' | null
}

function normalizeWarmupSet(set: WarmupSetInputType, defaultUnit: WeightUnit): NormalizedWarmupSet {
  return {
    weight: set.weight ?? null,
    weightUnit: set.weight_unit ?? defaultUnit,
    reps: set.reps ?? null,
    durationS: set.duration_s ?? null,
    rpe: set.rpe ?? null,
    restSeconds: set.rest_seconds ?? null,
    side: set.side ?? null,
  }
}

function sameNullableNumber(left: number | null, right: number | null): boolean {
  return left == null || right == null
    ? left == null && right == null
    : Math.abs(left - right) < 0.001
}

function completedWarmupMatches(row: ActivePlannedRow, desired: NormalizedWarmupSet): boolean {
  const rowUnit: WeightUnit = row.weightUnit === 'kg' ? 'kg' : 'lb'
  const rowWeightLb = convertWeight(row.weight, rowUnit, 'lb', 3)
  const desiredWeightLb = convertWeight(desired.weight, desired.weightUnit, 'lb', 3)
  return (
    sameNullableNumber(rowWeightLb, desiredWeightLb) &&
    row.reps === desired.reps &&
    row.durationS === desired.durationS &&
    sameNullableNumber(row.rpe, desired.rpe) &&
    row.restSeconds === desired.restSeconds &&
    row.side === desired.side
  )
}

function activePlannedUpsert(
  exercise: ActiveExercise,
  row: ActivePlannedRow,
  setNumber: number,
): SetUpsertInput {
  return {
    clientSetId: row.existing?.clientSetId ?? randomUUID(),
    workoutExerciseId: exercise.workoutExerciseId,
    setNumber,
    setType: row.setType,
    weight: row.weight,
    weightUnit: row.weightUnit,
    reps: row.reps,
    distanceM: row.distanceM,
    durationS: row.durationS,
    rpe: row.rpe,
    prescribedWeight: row.prescribedWeight,
    prescribedWeightUnit: row.prescribedWeightUnit,
    prescribedReps: row.prescribedReps,
    prescribedDistanceM: row.prescribedDistanceM,
    prescribedDurationS: row.prescribedDurationS,
    prescribedRpe: row.prescribedRpe,
    prescriptionSource: row.prescriptionSource,
    restSeconds: row.restSeconds,
    side: row.side,
    completed: row.completed,
  }
}

/**
 * Build one set upsert for a programming change.
 *
 * Returns `null` when the set is completed and the caller did not ask for a
 * correction (the set is simply skipped — completed performance is preserved),
 * and a string when the row predates live-edit ids and cannot be touched safely.
 */
function setUpsertFor(
  exercise: ActiveExercise,
  setNumber: number,
  patch: { reps?: number; weight?: number; weightUnit?: string; restSeconds?: number | null },
  applyToCompleted: boolean,
): SetUpsertInput | string | null {
  const existing = exercise.sets.find((set) => set.setNumber === setNumber)
  if (existing?.completed && !applyToCompleted) return null
  if (existing && !existing.clientSetId) {
    return `Set ${setNumber} of ${exercise.name} predates live-edit ids and can't be changed safely by an agent; edit that recorded set in the logger.`
  }
  const target = exercise.targets.find(
    (candidate, index) => (candidate.setNumber ?? index + 1) === setNumber,
  )
  const correctsCompletedActual = existing?.completed === true && applyToCompleted
  const programsIncomplete = !correctsCompletedActual
  const hasProgrammingChange = patch.weight !== undefined || patch.reps !== undefined || target != null
  return {
    clientSetId: existing?.clientSetId ?? randomUUID(),
    workoutExerciseId: exercise.workoutExerciseId,
    setNumber,
    setType: existing?.setType ?? target?.setType ?? 'normal',
    // Programming changes live in prescribed_*; actual performance stays what
    // the human entered (including null). Only apply_to_completed corrects it.
    weight: correctsCompletedActual && patch.weight !== undefined ? patch.weight : (existing?.weight ?? null),
    weightUnit:
      correctsCompletedActual && patch.weightUnit !== undefined
        ? patch.weightUnit
        : (existing?.weightUnit ?? exercise.preferredUnit),
    reps: correctsCompletedActual && patch.reps !== undefined ? patch.reps : (existing?.reps ?? null),
    distanceM: existing?.distanceM ?? null,
    durationS: existing?.durationS ?? null,
    rpe: existing?.rpe ?? null,
    ...(programsIncomplete && hasProgrammingChange
      ? {
          prescribedWeight: patch.weight ?? target?.weight ?? undefined,
          prescribedWeightUnit: patch.weightUnit ?? target?.weightUnit ?? undefined,
          prescribedReps: patch.reps ?? target?.reps ?? undefined,
          prescribedDistanceM: target?.distanceM ?? undefined,
          prescribedDurationS: target?.durationS ?? undefined,
          prescribedRpe: target?.rpe ?? undefined,
          prescriptionSource: target?.source ?? 'agent',
        }
      : {}),
    ...(patch.restSeconds !== undefined
      ? { restSeconds: patch.restSeconds }
      : existing?.restSeconds !== undefined
        ? { restSeconds: existing.restSeconds }
        : target?.restSeconds !== undefined
          ? { restSeconds: target.restSeconds }
          : {}),
    side: existing ? existing.side : (target?.side ?? null),
    completed: existing?.completed ?? false,
  }
}

type PersistResult = { ok: true; workout: ActiveWorkout } | { ok: false; error: string }

async function persistActiveSets(
  workout: ActiveWorkout,
  exercise: ActiveExercise,
  inputs: Array<SetUpsertInput | string | null>,
  deleteIds: string[] = [],
): Promise<PersistResult> {
  const failure = inputs.find((input): input is string => typeof input === 'string')
  if (failure) return { ok: false, error: failure }
  const upserts = inputs.filter((input): input is SetUpsertInput => input != null)
  if (upserts.length === 0 && deleteIds.length === 0) {
    return {
      ok: false,
      error: `No incomplete sets of ${exercise.name} matched that edit. Completed performance is preserved by default — pass apply_to_completed only for an explicit correction of logged data.`,
    }
  }
  let result: Awaited<ReturnType<typeof upsertSets>>
  try {
    result = await upsertSets(workout.id, upserts, workout.revision, deleteIds)
  } catch (error) {
    if (error instanceof ActiveWorkoutRevisionConflictError) return { ok: false, error: STALE_MESSAGE }
    throw error
  }
  if (!result) return { ok: false, error: 'That workout is no longer active.' }
  const refreshed = await getActiveWorkout()
  if (!refreshed || refreshed.id !== workout.id) {
    return { ok: false, error: 'The active workout changed before the edit landed.' }
  }
  return { ok: true, workout: refreshed }
}

async function persistActiveWarmupSets(
  workout: ActiveWorkout,
  exercise: ActiveExercise,
  inputs: SetUpsertInput[],
  deleteIds: string[],
): Promise<PersistResult> {
  const result = await upsertExerciseSetsIfUnchanged(
    workout.id,
    exercise.workoutExerciseId,
    exercise.sets,
    inputs,
    workout.revision,
    deleteIds,
  )
  if (!result.ok) {
    return result.reason === 'conflict'
      ? { ok: false, error: STALE_MESSAGE }
      : { ok: false, error: 'That workout is no longer active.' }
  }
  const refreshed = await getActiveWorkout()
  if (!refreshed || refreshed.id !== workout.id) {
    return { ok: false, error: 'The active workout changed before the warm-up edit landed.' }
  }
  return { ok: true, workout: refreshed }
}

/** Superset assignments for all rows, clearing singleton remnants. */
function activeSupersetEdits(
  exercises: ActiveExercise[],
  selectedIndexes: Set<number>,
): Array<{ workoutExerciseId: string; group: number | null }> {
  const nextGroup = Math.max(0, ...exercises.map((exercise) => exercise.supersetGroup ?? 0)) + 1
  const desired = exercises.map((exercise, index) =>
    selectedIndexes.has(index) ? nextGroup : exercise.supersetGroup,
  )
  const counts = new Map<number, number>()
  for (const group of desired) if (group != null) counts.set(group, (counts.get(group) ?? 0) + 1)
  return exercises.flatMap((exercise, index) => {
    const group = desired[index] != null && counts.get(desired[index]!) === 1 ? null : desired[index]!
    return group === exercise.supersetGroup ? [] : [{ workoutExerciseId: exercise.workoutExerciseId, group }]
  })
}

// ---------------------------------------------------------------------------
// One op
// ---------------------------------------------------------------------------

type OpOutcome = { ok: true; workout: ActiveWorkout; change: string } | { ok: false; error: string }

async function applyOne(current: ActiveWorkout, args: ActiveEditOpInput): Promise<OpOutcome> {
  const requireExercise = ():
    | { ok: true; exercise: ActiveExercise; index: number }
    | { ok: false; error: string } => {
    if (!args.exercise_name) return { ok: false, error: `exercise_name is required for op "${args.op}".` }
    const resolved = resolveActiveExercise(current.exercises, args.exercise_name)
    if (!resolved.ok) return resolved
    return { ok: true, exercise: current.exercises[resolved.index]!, index: resolved.index }
  }

  try {
    switch (args.op) {
      case 'add_exercise': {
        if (!args.exercise_name) return { ok: false, error: 'exercise_name is required for op "add_exercise".' }
        const match = await resolveEligibleExercise(args.exercise_name)
        if (!match.ok) return match
        // Duplicates are allowed on purpose: re-adding an exercise creates a
        // second instance (curls early and again late).
        const priorIds = new Set(current.exercises.map((exercise) => exercise.workoutExerciseId))
        let updated = await editExercises(current.id, { add: [{ exerciseId: match.id }] }, current.revision)
        if (!updated) return { ok: false, error: 'That workout is no longer active.' }
        if (args.to_position != null) {
          const from = updated.exercises.findIndex((exercise) => !priorIds.has(exercise.workoutExerciseId))
          const to = Math.max(0, Math.min(updated.exercises.length - 1, args.to_position - 1))
          const ordered = moveRow(updated.exercises, from, to)
          updated = await editExercises(
            current.id,
            { reorder: ordered.map((exercise, position) => ({ workoutExerciseId: exercise.workoutExerciseId, position })) },
            updated.revision,
          )
          if (!updated) return { ok: false, error: 'That workout is no longer active.' }
        }
        return {
          ok: true,
          workout: updated,
          change: `Added ${match.name}${args.to_position != null ? ` at slot ${Math.min(args.to_position, updated.exercises.length)}` : ''}.`,
        }
      }

      case 'remove_exercise': {
        const found = requireExercise()
        if (!found.ok) return found
        if (current.exercises.length <= 1) {
          return { ok: false, error: "Can't remove the last exercise; discard the workout instead if that is the intent." }
        }
        const updated = await editExercises(current.id, { remove: [found.exercise.workoutExerciseId] }, current.revision)
        if (!updated) return { ok: false, error: 'That workout is no longer active.' }
        return { ok: true, workout: updated, change: `Removed ${found.exercise.name}.` }
      }

      case 'replace_exercise': {
        const found = requireExercise()
        if (!found.ok) return found
        if (!args.replacement_exercise_name) {
          return { ok: false, error: 'replacement_exercise_name is required for op "replace_exercise".' }
        }
        const replacement = await resolveEligibleExercise(args.replacement_exercise_name)
        if (!replacement.ok) return replacement
        // Keep the prescribed load/reps as the new movement's ghost target:
        // strictly safer than wiping it and leaving the next set logged blind.
        const updated = await editExercises(
          current.id,
          {
            replace: [
              {
                workoutExerciseId: found.exercise.workoutExerciseId,
                newExerciseId: replacement.id,
                keepPrescription: true,
              },
            ],
          },
          current.revision,
        )
        if (!updated) return { ok: false, error: 'That workout is no longer active.' }
        return { ok: true, workout: updated, change: `Replaced ${found.exercise.name} with ${replacement.name}.` }
      }

      case 'reorder': {
        const found = requireExercise()
        if (!found.ok) return found
        let to: number
        if (args.to === 'top') to = 0
        else if (args.to === 'bottom') to = current.exercises.length - 1
        else if (args.to_position != null) to = Math.max(0, Math.min(current.exercises.length - 1, args.to_position - 1))
        else return { ok: false, error: 'Pass to (top/bottom) or to_position for op "reorder".' }
        const ordered = moveRow(current.exercises, found.index, to)
        const updated = await editExercises(
          current.id,
          { reorder: ordered.map((exercise, position) => ({ workoutExerciseId: exercise.workoutExerciseId, position })) },
          current.revision,
        )
        if (!updated) return { ok: false, error: 'That workout is no longer active.' }
        return { ok: true, workout: updated, change: `Moved ${found.exercise.name} to slot ${to + 1}.` }
      }

      case 'set_scheme': {
        const found = requireExercise()
        if (!found.ok) return found
        if (args.sets == null && args.sets_delta == null && args.reps == null) {
          return { ok: false, error: 'Pass sets, sets_delta, or reps for op "set_scheme".' }
        }
        const workingNumbers = activeWorkingSetNumbers(found.exercise)
        const baseline = workingNumbers.length
        const desired = args.sets ?? Math.max(1, Math.min(20, baseline + (args.sets_delta ?? 0)))
        const removedNumbers = new Set(workingNumbers.slice(desired))
        const completedPastEnd = found.exercise.sets.filter(
          (set) => set.completed && removedNumbers.has(set.setNumber),
        )
        if (completedPastEnd.length > 0) {
          return {
            ok: false,
            error: `Can't reduce ${found.exercise.name} to ${desired} working sets because set ${completedPastEnd[0]!.setNumber} is already completed.`,
          }
        }
        const deletable = found.exercise.sets.filter(
          (set) => !set.completed && removedNumbers.has(set.setNumber),
        )
        const legacyDelete = deletable.find((set) => !set.clientSetId)
        if (legacyDelete) {
          return { ok: false, error: `Set ${legacyDelete.setNumber} can't be removed safely by an agent; use the logger.` }
        }
        const desiredNumbers = workingNumbers.slice(0, desired)
        let nextSetNumber = maxPlannedSetNumber(found.exercise) + 1
        while (desiredNumbers.length < desired) {
          desiredNumbers.push(nextSetNumber)
          nextSetNumber += 1
        }
        const inputs = desiredNumbers.map((setNumber) =>
          setUpsertFor(
            found.exercise,
            setNumber,
            args.reps == null ? {} : { reps: args.reps },
            args.apply_to_completed === true,
          ),
        )
        const persisted = await persistActiveSets(
          current,
          found.exercise,
          inputs,
          deletable.map((set) => set.clientSetId!),
        )
        if (!persisted.ok) return persisted
        return {
          ok: true,
          workout: persisted.workout,
          change: `${found.exercise.name} is now ${args.reps != null ? `${desired} working sets × ${args.reps}` : `${desired} working sets`}; warm-ups and completed performance were preserved.`,
        }
      }

      case 'set_weight': {
        const found = requireExercise()
        if (!found.ok) return found
        if (args.weight == null) return { ok: false, error: 'weight is required for op "set_weight".' }
        const unit = args.weight_unit ?? (found.exercise.preferredUnit === 'kg' ? 'kg' : 'lb')
        const setNumbers =
          args.set_number != null ? [args.set_number] : activeWorkingSetNumbers(found.exercise)
        const inputs = setNumbers.map((setNumber) =>
          setUpsertFor(
            found.exercise,
            setNumber,
            { weight: args.weight!, weightUnit: unit },
            args.apply_to_completed === true,
          ),
        )
        const persisted = await persistActiveSets(current, found.exercise, inputs)
        if (!persisted.ok) return persisted
        return {
          ok: true,
          workout: persisted.workout,
          change: `${found.exercise.name}${args.set_number != null ? ` set ${args.set_number}` : ' incomplete/planned working sets'} set to ${args.weight} ${unit}; warm-up loads were preserved.`,
        }
      }

      case 'set_warmup_sets': {
        const found = requireExercise()
        if (!found.ok) return found
        if (args.warmup_sets == null) {
          return { ok: false, error: 'warmup_sets is required for op "set_warmup_sets"; pass [] to remove incomplete warm-ups.' }
        }
        const defaultUnit: WeightUnit = found.exercise.preferredUnit === 'kg' ? 'kg' : 'lb'
        const desiredWarmups = args.warmup_sets.map((set) => normalizeWarmupSet(set, defaultUnit))
        const planned = activePlannedRows(found.exercise)
        const currentWarmups = planned.filter((set) => set.setType === 'warmup')
        const working = planned.filter((set) => set.setType !== 'warmup')
        if (working.length === 0) {
          return {
            ok: false,
            error: `${found.exercise.name} has no working-set prescription to preserve; add working sets before attaching a warm-up ramp.`,
          }
        }

        for (let index = 0; index < currentWarmups.length; index += 1) {
          const row = currentWarmups[index]!
          if (!row.completed) continue
          const desired = desiredWarmups[index]
          if (!desired || !completedWarmupMatches(row, desired)) {
            return {
              ok: false,
              error: `Warm-up set ${row.setNumber} of ${found.exercise.name} is already completed. Keep it unchanged in warmup_sets; completed warm-ups cannot be removed or rewritten.`,
            }
          }
          if (row.setNumber !== index + 1) {
            return { ok: false, error: `Completed warm-up set ${row.setNumber} cannot be reindexed safely by an agent.` }
          }
        }

        const inputs: SetUpsertInput[] = []
        for (let index = 0; index < desiredWarmups.length; index += 1) {
          const desired = desiredWarmups[index]!
          const existing = currentWarmups[index]
          const setNumber = index + 1
          if (existing?.completed) continue
          if (existing?.existing && !existing.existing.clientSetId) {
            if (existing.setNumber === setNumber && completedWarmupMatches(existing, desired)) continue
            return { ok: false, error: `Warm-up set ${existing.setNumber} predates live-edit ids and cannot be replaced safely by an agent.` }
          }
          inputs.push({
            clientSetId: existing?.existing?.clientSetId ?? randomUUID(),
            workoutExerciseId: found.exercise.workoutExerciseId,
            setNumber,
            setType: 'warmup',
            weight: null,
            weightUnit: desired.weightUnit,
            reps: null,
            distanceM: null,
            durationS: null,
            rpe: null,
            prescribedWeight: desired.weight,
            prescribedWeightUnit: desired.weightUnit,
            prescribedReps: desired.reps,
            prescribedDistanceM: null,
            prescribedDurationS: desired.durationS,
            prescribedRpe: desired.rpe,
            prescriptionSource: 'agent',
            restSeconds: desired.restSeconds,
            side: desired.side,
            completed: false,
          })
        }

        const removedWarmups = currentWarmups.slice(desiredWarmups.length)
        const completedRemoval = removedWarmups.find((set) => set.completed)
        if (completedRemoval) {
          return { ok: false, error: `Warm-up set ${completedRemoval.setNumber} is completed and cannot be removed.` }
        }
        const legacyRemoval = removedWarmups.find((set) => set.existing && !set.existing.clientSetId)
        if (legacyRemoval) {
          return { ok: false, error: `Warm-up set ${legacyRemoval.setNumber} predates live-edit ids and cannot be removed safely by an agent.` }
        }
        const deleteIds = removedWarmups.flatMap((set) => (set.existing?.clientSetId ? [set.existing.clientSetId] : []))

        for (let index = 0; index < working.length; index += 1) {
          const row = working[index]!
          const desiredSetNumber = desiredWarmups.length + index + 1
          if (row.setNumber === desiredSetNumber) continue
          if (row.existing && !row.existing.clientSetId) {
            return { ok: false, error: `Working set ${row.setNumber} predates live-edit ids and cannot be reindexed safely by an agent.` }
          }
          inputs.push(activePlannedUpsert(found.exercise, row, desiredSetNumber))
        }

        let updated = current
        if (inputs.length > 0 || deleteIds.length > 0) {
          const persisted = await persistActiveWarmupSets(current, found.exercise, inputs, deleteIds)
          if (!persisted.ok) return persisted
          updated = persisted.workout
        }
        return {
          ok: true,
          workout: updated,
          change:
            desiredWarmups.length > 0
              ? `Set ${desiredWarmups.length} exact warm-up set${desiredWarmups.length === 1 ? '' : 's'} for ${found.exercise.name}; completed warm-ups and all ${working.length} working sets were preserved.`
              : `Removed ${found.exercise.name}'s incomplete warm-ups; all ${working.length} working sets were preserved.`,
        }
      }

      case 'set_rest': {
        const found = requireExercise()
        if (!found.ok) return found
        if (args.rest_seconds == null) return { ok: false, error: 'rest_seconds is required for op "set_rest".' }
        if (args.set_number != null) {
          const input = setUpsertFor(found.exercise, args.set_number, { restSeconds: args.rest_seconds }, true)
          const persisted = await persistActiveSets(current, found.exercise, [input])
          if (!persisted.ok) return persisted
          return {
            ok: true,
            workout: persisted.workout,
            change: `Rest after ${found.exercise.name} set ${args.set_number} set to ${args.rest_seconds}s.`,
          }
        }
        const updated = await editExercises(
          current.id,
          { rest: [{ workoutExerciseId: found.exercise.workoutExerciseId, seconds: args.rest_seconds }] },
          current.revision,
        )
        if (!updated) return { ok: false, error: 'That workout is no longer active.' }
        // Postcondition, so a stale deployment can never report a false success.
        const refreshed = updated.exercises.find(
          (exercise) => exercise.workoutExerciseId === found.exercise.workoutExerciseId,
        )
        if (refreshed?.restSeconds !== args.rest_seconds) {
          return { ok: false, error: 'Live rest editing is not available on this deployment; no rest value changed.' }
        }
        return { ok: true, workout: updated, change: `Rest after ${found.exercise.name} set to ${args.rest_seconds}s.` }
      }

      case 'set_superset': {
        if (!args.exercise_names) {
          return { ok: false, error: 'exercise_names (at least two) is required for op "set_superset".' }
        }
        const indexes = new Set<number>()
        const names: string[] = []
        for (const name of args.exercise_names) {
          const resolved = resolveActiveExercise(current.exercises, name)
          if (!resolved.ok) return resolved
          indexes.add(resolved.index)
          names.push(current.exercises[resolved.index]!.name)
        }
        if (indexes.size < 2) return { ok: false, error: 'A superset needs at least two different active exercises.' }
        const updated = await editExercises(
          current.id,
          { superset: activeSupersetEdits(current.exercises, indexes) },
          current.revision,
        )
        if (!updated) return { ok: false, error: 'That workout is no longer active.' }
        return { ok: true, workout: updated, change: `Supersetted ${names.join(' + ')}.` }
      }

      case 'clear_superset': {
        const found = requireExercise()
        if (!found.ok) return found
        const group = found.exercise.supersetGroup
        if (group == null) return { ok: false, error: `${found.exercise.name} is not in a superset.` }
        const members = current.exercises.filter((exercise) => exercise.supersetGroup === group)
        const edits = [{ workoutExerciseId: found.exercise.workoutExerciseId, group: null as number | null }]
        if (members.length === 2) {
          const other = members.find((exercise) => exercise.workoutExerciseId !== found.exercise.workoutExerciseId)
          if (other) edits.push({ workoutExerciseId: other.workoutExerciseId, group: null })
        }
        const updated = await editExercises(current.id, { superset: edits }, current.revision)
        if (!updated) return { ok: false, error: 'That workout is no longer active.' }
        return { ok: true, workout: updated, change: `Removed ${found.exercise.name} from its superset.` }
      }

      case 'set_notes': {
        const found = requireExercise()
        if (!found.ok) return found
        if (args.notes === undefined) {
          return { ok: false, error: 'notes is required for op "set_notes" (pass null to clear it).' }
        }
        const next = args.notes == null ? null : args.notes.trim() || null
        const updated = await editExercises(
          current.id,
          { notes: [{ workoutExerciseId: found.exercise.workoutExerciseId, notes: next }] },
          current.revision,
        )
        if (!updated) return { ok: false, error: 'That workout is no longer active.' }
        return {
          ok: true,
          workout: updated,
          change: next ? `Noted on ${found.exercise.name}: ${next}` : `Cleared ${found.exercise.name}'s session note.`,
        }
      }

      case 'rename': {
        if (!args.workout_name) return { ok: false, error: 'workout_name is required for op "rename".' }
        const updated = await patchWorkoutMeta(current.id, { name: args.workout_name.trim() })
        if (!updated) return { ok: false, error: 'That workout is no longer active.' }
        return { ok: true, workout: updated, change: `Renamed the active workout to ${args.workout_name.trim()}.` }
      }

      case 'restore_template_weights': {
        const restored = await restoreTemplateWeights(current.id)
        if (!restored.ok) return { ok: false, error: restored.error }
        const after = await getActiveWorkout()
        if (!after) return { ok: false, error: 'That workout ended before the restore landed.' }
        return {
          ok: true,
          workout: after,
          change:
            restored.restored === 0
              ? 'Nothing to restore — no uncompleted set carried an eased weight.'
              : `Put the template's own weights back on ${restored.restored} uncompleted set${restored.restored === 1 ? '' : 's'}. Completed sets are unchanged, and the template was never modified.`,
        }
      }

      default:
        return { ok: false, error: 'Unknown op.' }
    }
  } catch (error) {
    if (error instanceof ActiveWorkoutPerformedSetsConflictError) {
      return { ok: false, error: error.message }
    }
    if (error instanceof ActiveWorkoutRevisionConflictError) {
      return { ok: false, error: STALE_MESSAGE }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Apply an ordered list of ops to the workout currently being performed.
 *
 * Never throws for an expected condition: a missing workout, a stale revision
 * and a rejected op are all values. Ops are applied in order against freshly
 * re-read canonical state, so an op that depends on a previous one (add, then
 * reorder) sees the result of that previous one. A failing op is recorded in
 * `rejected` and the remaining ops still run.
 */
export async function applyActiveEdit(input: ActiveEditRequestInput): Promise<ActiveEditResult> {
  let current = await getActiveWorkout()
  if (!current) return { ok: false, code: 'no_active_workout' }

  if (input.expected_revision != null && input.expected_revision !== current.revision) {
    return {
      ok: false,
      code: 'stale_revision',
      current_revision: current.revision,
      workout: current,
      applied: [],
      rejected: [],
    }
  }

  const applied: AppliedEdit[] = []
  const rejected: RejectedEdit[] = []

  for (const op of input.ops) {
    const outcome = await applyOne(current, op)
    if (outcome.ok) {
      current = outcome.workout
      applied.push({ op: op.op, change: outcome.change })
      continue
    }
    rejected.push({ op: op.op, error: outcome.error })
    if (outcome.error === STALE_MESSAGE) {
      // Someone else wrote to this workout mid-sequence. Stop, and hand back
      // the true current state rather than guessing at a rebase.
      const latest = (await getActiveWorkout()) ?? current
      return {
        ok: false,
        code: 'stale_revision',
        current_revision: latest.revision,
        workout: latest,
        applied,
        rejected,
      }
    }
    // A rejected op must not leave the loop working from stale state.
    const refreshed = await getActiveWorkout()
    if (!refreshed) return { ok: false, code: 'no_active_workout' }
    current = refreshed
  }

  return { ok: true, workout: current, revision: current.revision, applied, rejected }
}
