/**
 * Templates read layer (GYM_PLAN §4 "Tab: Train" start surface, P2a — THIN).
 *
 * P2a needs exactly two things from templates:
 *   1. The Train tab's start surface — a quick-start list of templates plus the
 *      "repeat last workout" hero — powered by ONE GET (`listTemplatesForStart`).
 *   2. "Save as template" from the finish sheet — turn a just-logged workout into
 *      a reusable template (`buildTemplateFromWorkout` is the PURE mapping fn,
 *      tested against a fixture; `createTemplateFromWorkout` is the DB wrapper).
 *
 * Full template CRUD (folders, the builder, edit/archive) is P2b — deliberately
 * NOT here. This module stays small on purpose.
 *
 * §3b filter-sweep discipline: `lastPerformed` + `lastWorkout` count only
 * `status = 'completed'` workouts, so an in-progress session never shows up as
 * "last performed" or as the repeat-last hero.
 */
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { parsePolicy } from '@/lib/gym/progression'
import {
  convertWeight,
  normalizeWeightUnit,
  type WeightUnit,
} from '@/lib/units/weight'
import { getGymWeightUnit } from '@/lib/gym/unit-preferences'
import { logicalSetKey } from './load-semantics'
import {
  normalizeWorkoutProgrammingPolicy,
  type WorkoutProgrammingPolicy,
} from './programming-policy'

// ---------------------------------------------------------------------------
// GET /api/gym/templates — the Train start surface
// ---------------------------------------------------------------------------

/** One template row in the quick-start list. */
export interface TemplateStartItem {
  id: string
  name: string
  folder: string | null
  exerciseCount: number
  /** ISO timestamp (max started_at of completed workouts on this template), or null. */
  lastPerformed: string | null
  /** All-timed template (≥1 exercise, every one tracks='time') — the Train tab's
   *  Mobility quick-start group + the §10b.6 routine player key off this. */
  isMobility: boolean
}

/** The most-recent completed workout — powers the "Repeat last" hero card. */
export interface LastWorkoutSummary {
  id: string
  name: string | null
  /** ISO started_at. */
  date: string
  exerciseCount: number
  durationSeconds: number | null
}

export interface TemplatesStartResponse {
  templates: TemplateStartItem[]
  lastWorkout: LastWorkoutSummary | null
}

/**
 * The Train start surface in ONE call: every non-archived template (with its
 * exercise count + last-performed stamp) plus the most-recent completed workout.
 * One fetch powers the whole "no active workout" screen.
 */
export async function listTemplatesForStart(): Promise<TemplatesStartResponse> {
  const templateRows = (
    await db.execute(sql`
      SELECT t.id, t.name, t.folder,
        (SELECT count(*)::int FROM template_exercises te WHERE te.template_id = t.id) AS exercise_count,
        (
          SELECT max(w.started_at)::text FROM workouts w
          WHERE w.template_id = t.id AND w.status = 'completed'
        ) AS last_performed,
        -- All-timed template (§10b.6): every exercise logs as a hold. Drives the
        -- Mobility quick-start group + the routine player.
        (
          NOT EXISTS (
            SELECT 1 FROM template_exercises te
            JOIN exercises e ON e.id = te.exercise_id
            WHERE te.template_id = t.id AND e.tracks <> 'time'
          )
          AND EXISTS (SELECT 1 FROM template_exercises te WHERE te.template_id = t.id)
        ) AS is_mobility
      FROM workout_templates t
      WHERE t.archived_at IS NULL
      ORDER BY t.position, t.created_at
    `)
  ).rows as unknown as Array<{
    id: string
    name: string
    folder: string | null
    exercise_count: number
    last_performed: string | null
    is_mobility: boolean
  }>

  const [last] = (
    await db.execute(sql`
      SELECT w.id, w.name, w.started_at::text AS started_at, w.duration_seconds,
        (SELECT count(*)::int FROM workout_exercises we WHERE we.workout_id = w.id) AS exercise_count
      FROM workouts w
      WHERE w.status = 'completed'
      ORDER BY w.started_at DESC
      LIMIT 1
    `)
  ).rows as unknown as Array<{
    id: string
    name: string | null
    started_at: string
    duration_seconds: number | null
    exercise_count: number
  }>

  return {
    templates: templateRows.map((r) => ({
      id: r.id,
      name: r.name,
      folder: r.folder,
      exerciseCount: r.exercise_count,
      lastPerformed: r.last_performed,
      isMobility: r.is_mobility,
    })),
    lastWorkout: last
      ? {
          id: last.id,
          name: last.name,
          date: last.started_at,
          exerciseCount: last.exercise_count,
          durationSeconds: last.duration_seconds,
        }
      : null,
  }
}

// ---------------------------------------------------------------------------
// POST /api/gym/templates — save a workout as a template (PURE mapping + wrapper)
// ---------------------------------------------------------------------------

/** One completed working set of a workout, as read for the save-as-template map. */
export interface WorkoutSetForTemplate {
  exerciseId: string
  position: number
  supersetGroup: number | null
  exerciseRestSeconds: number | null
  exerciseRestSecondsWarmup: number | null
  section: string
  exerciseNotes: string | null
  /** Null is the LEFT JOIN sentinel for an exercise with no completed sets. */
  setNumber: number | null
  setType: string
  weight: number | null
  weightUnit: WeightUnit
  reps: number | null
  distanceM: number | null
  durationS: number | null
  rpe: number | null
  restSeconds: number | null
  side: 'left' | 'right' | null
  /** Stable workout-round identity. Split L/R rows share one id. Optional only
   * for legacy/tests; missing ids deliberately fall back to one round per row. */
  logicalSetId?: string | null
}

/** Exact ordered set prescription stored under one template exercise. */
export interface TemplateSetInput {
  setNumber: number
  setType: 'warmup' | 'normal' | 'drop' | 'failure'
  targetWeight: number | null
  targetWeightUnit: WeightUnit
  targetReps: number | null
  targetDistanceM: number | null
  targetDurationS: number | null
  targetRpe: number | null
  restSeconds: number | null
  side: 'left' | 'right' | null
}

/** One template_exercises row to write when saving a workout as a template. */
export interface TemplateExerciseRow {
  exerciseId: string
  position: number
  supersetGroup: number | null
  targetSets: number | null
  targetReps: number | null
  /** Canonical storage unit for every newly-built template target. */
  targetWeight: number | null
  targetWeightUnit: 'lb'
  targetDurationS: number | null
  restSeconds: number | null
  restSecondsWarmup: number | null
  section: string
  notes: string | null
  sets: TemplateSetInput[]
}

/** The dominant (modal) rep count across a slot's working sets. Ties → first-seen max count. */
function modalReps(reps: Array<number | null>): number | null {
  const counts = new Map<number, number>()
  for (const r of reps) {
    if (r == null) continue
    counts.set(r, (counts.get(r) ?? 0) + 1)
  }
  let best: number | null = null
  let bestN = 0
  for (const [rep, n] of counts) {
    if (n > bestN) {
      best = rep
      bestN = n
    }
  }
  return best
}

/** The top (heaviest) working-set weight, or null if none carried weight. */
function topWeight(weights: Array<number | null>): number | null {
  let top: number | null = null
  for (const w of weights) {
    if (w != null && (top == null || w > top)) top = w
  }
  return top
}

/** Count stable workout rounds while preserving row-wise behavior for callers
 * that predate logical ids. */
function logicalWorkoutSetCount(
  sets: Array<Pick<WorkoutSetForTemplate, 'logicalSetId'>>,
): number {
  return new Set(
    sets.map((set, index) => logicalSetKey(set.logicalSetId, index)),
  ).size
}

/** Exact template rows do not persist workout logical ids. Their authored side
 * sequence is enough to recover Split rounds: adjacent opposite sides of the
 * same set type are one round; every other physical row remains independent. */
function exactTemplateRoundCount(sets: TemplateSetInput[]): number {
  let rounds = 0
  for (let index = 0; index < sets.length; index += 1) {
    rounds += 1
    const current = sets[index]!
    const next = sets[index + 1]
    if (
      next &&
      current.side != null &&
      next.side != null &&
      current.side !== next.side &&
      current.setType === next.setType
    ) {
      index += 1
    }
  }
  return rounds
}

/** Template targets use a stable two-decimal canonical-pound boundary. */
function templateWeightLb(value: number | null, unit: WeightUnit): number | null {
  const pounds = convertWeight(value, unit, 'lb')
  return pounds == null ? null : Math.round(pounds * 100) / 100
}

/**
 * PURE: map every set visible in a completed workout → template_exercises rows.
 *
 * One row per workout exercise slot, ordered by position (preserving repeated
 * exercise occurrences and superset_group). Targets come from the WORKING
 * (non-warmup) sets:
 *   - target_sets   = count of working sets logged for that exercise
 *   - target_reps   = the modal (most-common) rep count across those sets
 *   - target_weight = the top (heaviest) working-set weight
 *
 * An exercise with zero working sets (e.g. all warmups, or nothing logged) still
 * becomes a slot with null targets — the skeleton is worth keeping. Exercises are
 * emitted in `position` order; positions are RE-INDEXED to 0..n-1 so the saved
 * template is dense even if the source workout had gaps.
 */
export function buildTemplateFromWorkout(sets: WorkoutSetForTemplate[]): TemplateExerciseRow[] {
  interface Slot {
    exerciseId: string
    position: number
    supersetGroup: number | null
    restSeconds: number | null
    restSecondsWarmup: number | null
    section: string
    notes: string | null
    workingWeights: Array<number | null>
    workingReps: Array<number | null>
    workingDurations: Array<number | null>
    workingSets: Array<Pick<WorkoutSetForTemplate, 'logicalSetId'>>
    sets: TemplateSetInput[]
  }
  // The same exercise may intentionally appear more than once in one workout.
  // Position is the slot identity; grouping by exercise id alone would merge those
  // occurrences and silently flatten the template.
  const byExercise = new Map<string, Slot>()
  for (const s of sets) {
    const slotKey = `${s.position}:${s.exerciseId}`
    let slot = byExercise.get(slotKey)
    if (!slot) {
      slot = {
        exerciseId: s.exerciseId,
        position: s.position,
        supersetGroup: s.supersetGroup,
        restSeconds: s.exerciseRestSeconds,
        restSecondsWarmup: s.exerciseRestSecondsWarmup,
        section: s.section,
        notes: s.exerciseNotes,
        workingWeights: [],
        workingReps: [],
        workingDurations: [],
        workingSets: [],
        sets: [],
      }
      byExercise.set(slotKey, slot)
    }
    if (s.setNumber != null) {
      const targetWeight = templateWeightLb(s.weight, s.weightUnit)
      slot.sets.push({
        setNumber: s.setNumber,
        setType: normalizeSetType(s.setType),
        targetWeight,
        targetWeightUnit: 'lb',
        targetReps: s.reps,
        targetDistanceM: s.distanceM,
        targetDurationS: s.durationS,
        targetRpe: s.rpe,
        restSeconds: s.restSeconds,
        side: s.side,
      })
      // Only working sets seed the legacy summary (warmups don't define it).
      if (s.setType !== 'warmup') {
        slot.workingWeights.push(targetWeight)
        slot.workingReps.push(s.reps)
        slot.workingDurations.push(s.durationS)
        slot.workingSets.push({ logicalSetId: s.logicalSetId })
      }
    }
  }

  return [...byExercise.values()]
    .sort((a, b) => a.position - b.position)
    .map((slot, i) => ({
      exerciseId: slot.exerciseId,
      position: i,
      supersetGroup: slot.supersetGroup,
      targetSets:
        slot.workingSets.length > 0 ? logicalWorkoutSetCount(slot.workingSets) : null,
      targetReps: modalReps(slot.workingReps),
      targetWeight: topWeight(slot.workingWeights),
      targetWeightUnit: 'lb',
      targetDurationS: modalReps(slot.workingDurations),
      restSeconds: slot.restSeconds,
      restSecondsWarmup: slot.restSecondsWarmup,
      section: slot.section,
      notes: slot.notes,
      sets: slot.sets
        .sort((a, b) => a.setNumber - b.setNumber)
        .map((set, setIndex) => ({ ...set, setNumber: setIndex + 1 })),
    }))
}

function normalizeSetType(value: string): TemplateSetInput['setType'] {
  return value === 'warmup' || value === 'drop' || value === 'failure' ? value : 'normal'
}

export interface CreatedTemplate {
  id: string
  name: string
  folder: string | null
  exerciseCount: number
}

/**
 * DB wrapper: create a workout_template + its template_exercises from a completed
 * workout's exercises. Returns the new template summary, or null when the source
 * workout has no exercises (nothing to save — the route 422s).
 *
 * Reads the workout's exercises + every History-visible set, maps them with the
 * pure fn, and inserts in a transaction. A completed workout can retain unchecked
 * planned rows, so individual-set completion is intentionally not a filter. Actual
 * values win and untouched rows fall back to their immutable prescription. `source`
 * stays 'user' (this is a manual save, not an AI draft).
 */
/** Bind a policy for the jsonb column the same way the builder's create does. */
function policyParam(policy: unknown) {
  return policy == null ? null : sql`${JSON.stringify(policy)}::jsonb`
}

/** The source template's progression policies, keyed by exercise. Empty when the
 *  workout was freestyle (no template) or nothing carried a policy. */
async function sourceTemplateProgression(workoutId: string): Promise<Map<string, unknown>> {
  const rows = (
    await db.execute(sql`
      SELECT te.exercise_id, te.progression
      FROM workouts w
      JOIN template_exercises te ON te.template_id = w.template_id
      WHERE w.id = ${workoutId} AND te.progression IS NOT NULL
    `)
  ).rows as unknown as Array<{ exercise_id: string; progression: unknown }>
  const out = new Map<string, unknown>()
  // A policy that no longer parses is dropped rather than propagated — carrying a
  // rule the engine reads as "unreadable — repeating last session" is worse than
  // carrying none, because it looks configured.
  for (const row of rows) {
    if (parsePolicy(row.progression)) out.set(row.exercise_id, row.progression)
  }
  return out
}

/** How many of a completed workout's exercises would carry a progression policy
 *  if it were saved as a new template — drives the finish sheet's offer. */
export async function carryableProgressionCount(workoutId: string): Promise<number> {
  const policies = await sourceTemplateProgression(workoutId)
  if (policies.size === 0) return 0
  const rows = (
    await db.execute(sql`
      SELECT DISTINCT exercise_id FROM workout_exercises WHERE workout_id = ${workoutId}
    `)
  ).rows as unknown as Array<{ exercise_id: string }>
  return rows.filter((row) => policies.has(row.exercise_id)).length
}

export async function createTemplateFromWorkout(
  fromWorkoutId: string,
  name: string,
  opts: { carryProgression?: boolean } = {},
): Promise<CreatedTemplate | null> {
  const rows = (
    await db.execute(sql`
      SELECT we.exercise_id, we.position, we.superset_group,
        we.rest_seconds AS exercise_rest_seconds,
        we.rest_seconds_warmup AS exercise_rest_seconds_warmup,
        we.section, we.notes AS exercise_notes,
        ws.set_number, ws.set_type,
        COALESCE(ws.weight, ws.prescribed_weight)::text AS weight,
        CASE
          WHEN ws.weight IS NOT NULL THEN ws.weight_unit
          ELSE ws.prescribed_weight_unit
        END AS weight_unit,
        COALESCE(ws.reps, ws.prescribed_reps) AS reps,
        COALESCE(ws.distance_m, ws.prescribed_distance_m)::text AS distance_m,
        COALESCE(ws.duration_s, ws.prescribed_duration_s) AS duration_s,
        COALESCE(ws.rpe, ws.prescribed_rpe)::text AS rpe,
        ws.rest_seconds, ws.side, ws.logical_set_id::text AS logical_set_id
      FROM workout_exercises we
      JOIN workouts w ON w.id = we.workout_id AND w.status = 'completed'
      LEFT JOIN workout_sets ws ON ws.workout_exercise_id = we.id
      WHERE we.workout_id = ${fromWorkoutId}
      ORDER BY we.position, we.id, ws.set_number
    `)
  ).rows as unknown as Array<{
    exercise_id: string
    position: number
    superset_group: number | null
    exercise_rest_seconds: number | null
    exercise_rest_seconds_warmup: number | null
    section: string
    exercise_notes: string | null
    set_number: number | null
    set_type: string | null
    weight: string | null
    weight_unit: string | null
    reps: number | null
    distance_m: string | null
    duration_s: number | null
    rpe: string | null
    rest_seconds: number | null
    side: string | null
    logical_set_id: string | null
  }>

  if (rows.length === 0) return null

  const sets: WorkoutSetForTemplate[] = rows.map((r) => ({
    exerciseId: r.exercise_id,
    position: r.position,
    supersetGroup: r.superset_group,
    exerciseRestSeconds: r.exercise_rest_seconds,
    exerciseRestSecondsWarmup: r.exercise_rest_seconds_warmup,
    section: r.section,
    exerciseNotes: r.exercise_notes,
    setNumber: r.set_number,
    setType: r.set_type ?? 'normal',
    weight: r.weight == null ? null : Number(r.weight),
    weightUnit: normalizeWeightUnit(r.weight_unit),
    reps: r.reps,
    distanceM: r.distance_m == null ? null : Number(r.distance_m),
    durationS: r.duration_s,
    rpe: r.rpe == null ? null : Number(r.rpe),
    restSeconds: r.rest_seconds,
    side: r.side === 'left' || r.side === 'right' ? r.side : null,
    logicalSetId: r.logical_set_id,
  }))
  const templateExercises = buildTemplateFromWorkout(sets)

  const trimmedName = name.trim() || 'New Template'
  // A workout branched off a template keeps its progression RULES when asked —
  // the new template is usually the same programme with the session's edits, and
  // silently dropping the policies would quietly demote every exercise to
  // `last_time`. Matched by exercise, so a swapped movement simply has none.
  const progression = opts.carryProgression
    ? await sourceTemplateProgression(fromWorkoutId)
    : new Map<string, unknown>()

  const created = await db.transaction(async (tx) => {
    const [tpl] = (
      await tx.execute(sql`
        INSERT INTO workout_templates (name, source)
        VALUES (${trimmedName}, 'user')
        RETURNING id
      `)
    ).rows as unknown as { id: string }[]
    const templateId = tpl!.id

    for (const te of templateExercises) {
      const [inserted] = (
        await tx.execute(sql`
        INSERT INTO template_exercises (
          template_id, exercise_id, position, superset_group,
          target_sets, target_reps, target_weight, target_weight_unit,
          target_duration_s, rest_seconds, rest_seconds_warmup, section, notes,
          progression
        ) VALUES (
          ${templateId}, ${te.exerciseId}, ${te.position}, ${te.supersetGroup},
          ${te.targetSets}, ${te.targetReps}, ${te.targetWeight}, ${te.targetWeightUnit},
          ${te.targetDurationS}, ${te.restSeconds}, ${te.restSecondsWarmup},
          ${te.section}, ${te.notes},
          ${policyParam(progression.get(te.exerciseId))}
        )
        RETURNING id
      `)
      ).rows as unknown as Array<{ id: string }>
      if (inserted) await insertTemplateSets(tx, inserted.id, te.sets)
    }
    return { id: templateId, exerciseCount: templateExercises.length }
  })

  return {
    id: created.id,
    name: trimmedName,
    folder: null,
    exerciseCount: created.exerciseCount,
  }
}

// ===========================================================================
// P2b: full template CRUD (the builder — GYM_PLAN §4 "Tab: Templates")
// ===========================================================================
//
// The Templates tab is folder-grouped cards + a builder that owns the whole
// editor payload: name/folder/notes + an ordered exercise list, each slot with
// targets, rest, superset grouping, and a per-exercise progression policy (§2.5).
// PATCH is replace-all in a transaction (the applyTemplateUpdateForWorkout idiom);
// DELETE is a soft archive (honest rowcount).
//
// The `uq_template_exercise_slot` UNIQUE(template_id, position) index means every
// write must produce DENSE, unique positions — validateEditorPayload enforces that
// BEFORE the DB sees it, so a bad client body 400s instead of hitting a pg 23505.

// ── The card list (folder-grouped) ──────────────────────────────────────────

/** One template card on the Templates tab. */
export interface TemplateCard {
  id: string
  name: string
  folder: string | null
  notes: string | null
  source: string
  exerciseCount: number
  /** ISO timestamp of the most-recent completed session on this template, or null. */
  lastPerformed: string | null
  /** Up to a handful of exercise names, in position order — the card's muscle-ish preview. */
  exercisePreview: string[]
  archived: boolean
}

/** One folder group of cards (null folder → the "Ungrouped" bucket, rendered last). */
export interface TemplateFolderGroup {
  folder: string | null
  templates: TemplateCard[]
}

export interface TemplateCardsResponse {
  folders: TemplateFolderGroup[]
  /** Every distinct non-null folder name — powers the editor's folder datalist. */
  allFolders: string[]
}

/** Group cards by folder for the tab; null-folder bucket sorts last. Pure + tested. */
export function groupTemplatesByFolder(cards: TemplateCard[]): TemplateFolderGroup[] {
  const byFolder = new Map<string | null, TemplateCard[]>()
  for (const c of cards) {
    const key = c.folder ?? null
    const arr = byFolder.get(key)
    if (arr) arr.push(c)
    else byFolder.set(key, [c])
  }
  const named = [...byFolder.entries()]
    .filter(([f]) => f != null)
    .sort((a, b) => (a[0] as string).localeCompare(b[0] as string))
    .map(([folder, templates]) => ({ folder, templates }))
  const ungrouped = byFolder.get(null)
  return ungrouped && ungrouped.length > 0
    ? [...named, { folder: null, templates: ungrouped }]
    : named
}

/**
 * Every template (grouped by folder) for the Templates tab. `archived` filters:
 * false (default) hides archived; true returns ONLY archived (the restore view).
 * lastPerformed + the exercise preview come along in one round-trip.
 */
export async function listTemplateCards(archived = false): Promise<TemplateCardsResponse> {
  const archiveCond = archived
    ? sql`t.archived_at IS NOT NULL`
    : sql`t.archived_at IS NULL`

  const rows = (
    await db.execute(sql`
      SELECT t.id, t.name, t.folder, t.notes, t.source,
        t.archived_at IS NOT NULL AS archived,
        (SELECT count(*)::int FROM template_exercises te WHERE te.template_id = t.id) AS exercise_count,
        (
          SELECT max(w.started_at)::text FROM workouts w
          WHERE w.template_id = t.id AND w.status = 'completed'
        ) AS last_performed,
        (
          SELECT coalesce(jsonb_agg(x.name ORDER BY x.position), '[]'::jsonb)
          FROM (
            SELECT e.name, te.position
            FROM template_exercises te
            JOIN exercises e ON e.id = te.exercise_id
            WHERE te.template_id = t.id
            ORDER BY te.position
            LIMIT 6
          ) x
        ) AS exercise_preview
      FROM workout_templates t
      WHERE ${archiveCond}
      ORDER BY t.folder NULLS LAST, t.position, t.created_at
    `)
  ).rows as unknown as Array<{
    id: string
    name: string
    folder: string | null
    notes: string | null
    source: string
    archived: boolean
    exercise_count: number
    last_performed: string | null
    exercise_preview: unknown
  }>

  const cards: TemplateCard[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    folder: r.folder,
    notes: r.notes,
    source: r.source,
    exerciseCount: r.exercise_count,
    lastPerformed: r.last_performed,
    exercisePreview: Array.isArray(r.exercise_preview)
      ? (r.exercise_preview.filter((n): n is string => typeof n === 'string'))
      : [],
    archived: r.archived,
  }))

  const allFolders = [
    ...new Set(cards.map((c) => c.folder).filter((f): f is string => f != null)),
  ].sort((a, b) => a.localeCompare(b))

  return { folders: groupTemplatesByFolder(cards), allFolders }
}

// ── The editor shape (GET one template for the builder) ──────────────────────

/** One exercise slot as the builder edits it. */
export interface EditorExercise {
  exerciseId: string
  /** Denormalized for display (the builder shows the name, not the id). */
  name: string
  tracks: string
  /** The exercise's preferred display unit — drives the ruleText preview. */
  preferredUnit: 'lb' | 'kg' | null
  position: number
  targetSets: number | null
  targetReps: number | null
  targetWeight: number | null
  /** Unit of targetWeight in this read model (always the app-wide display unit). */
  targetWeightUnit: WeightUnit
  targetDurationS: number | null
  restSeconds: number | null
  restSecondsWarmup: number | null
  supersetGroup: number | null
  section: 'warmup' | 'main' | 'cooldown'
  /** Exact ordered set prescription. Empty only for truly target-less legacy slots. */
  sets: TemplateSetInput[]
  /** The stored §2.5 policy JSON (null ⇒ exact saved set prescription). */
  progression: unknown
  notes: string | null
}

/** The full template as the builder loads it (GET /api/gym/templates/[id]). */
export interface TemplateEditorData {
  id: string
  name: string
  folder: string | null
  notes: string | null
  source: string
  programmingPolicy: WorkoutProgrammingPolicy | null
  /** Template-level DEFAULT progression policy (#1790); null = none. */
  progression: unknown
  /** When the template was last edited, ISO. */
  updatedAt: string | null
  archived: boolean
  exercises: EditorExercise[]
}

/** Load one template in the editor shape, or null if it doesn't exist. */
export async function getTemplateForEditor(id: string): Promise<TemplateEditorData | null> {
  const [tpl] = (
    await db.execute(sql`
      SELECT id, name, folder, notes, source, programming_policy, progression,
        updated_at::text AS updated_at,
        archived_at IS NOT NULL AS archived
      FROM workout_templates WHERE id = ${id} LIMIT 1
    `)
  ).rows as unknown as Array<{
    id: string
    name: string
    folder: string | null
    notes: string | null
    source: string
    programming_policy: unknown
    progression: unknown
    updated_at: string | null
    archived: boolean
  }>
  if (!tpl) return null

  const displayUnit = await getGymWeightUnit()

  const exRows = (
    await db.execute(sql`
      SELECT te.id AS template_exercise_id, te.exercise_id, e.name, e.tracks, e.preferred_unit,
        te.position, te.target_sets, te.target_reps,
        te.target_weight::text AS target_weight, te.target_weight_unit,
        te.target_duration_s,
        te.rest_seconds, te.rest_seconds_warmup, te.superset_group,
        te.section, te.progression, te.notes
      FROM template_exercises te
      JOIN exercises e ON e.id = te.exercise_id
      WHERE te.template_id = ${id}
      ORDER BY te.position
    `)
  ).rows as unknown as Array<{
    template_exercise_id: string
    exercise_id: string
    name: string
    tracks: string
    preferred_unit: string | null
    position: number
    target_sets: number | null
    target_reps: number | null
    target_weight: string | null
    target_weight_unit: string
    target_duration_s: number | null
    rest_seconds: number | null
    rest_seconds_warmup: number | null
    superset_group: number | null
    section: string
    progression: unknown
    notes: string | null
  }>

  const setRows = (
    await db.execute(sql`
      SELECT ts.template_exercise_id, ts.set_number, ts.set_type,
        ts.target_weight::text AS target_weight, ts.target_weight_unit,
        ts.target_reps, ts.target_distance_m::text AS target_distance_m,
        ts.target_duration_s, ts.target_rpe::text AS target_rpe,
        ts.rest_seconds, ts.side
      FROM template_sets ts
      JOIN template_exercises te ON te.id = ts.template_exercise_id
      WHERE te.template_id = ${id}
      ORDER BY te.position, ts.set_number
    `)
  ).rows as unknown as Array<{
    template_exercise_id: string
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
  }>

  const setsByExercise = new Map<string, TemplateSetInput[]>()
  for (const row of setRows) {
    const targetWeight = convertWeight(
      row.target_weight == null ? null : Number(row.target_weight),
      normalizeWeightUnit(row.target_weight_unit),
      displayUnit,
    )
    const item: TemplateSetInput = {
      setNumber: row.set_number,
      setType: normalizeSetType(row.set_type),
      targetWeight,
      targetWeightUnit: displayUnit,
      targetReps: row.target_reps,
      targetDistanceM: row.target_distance_m == null ? null : Number(row.target_distance_m),
      targetDurationS: row.target_duration_s,
      targetRpe: row.target_rpe == null ? null : Number(row.target_rpe),
      restSeconds: row.rest_seconds,
      side: row.side === 'left' || row.side === 'right' ? row.side : null,
    }
    const list = setsByExercise.get(row.template_exercise_id)
    if (list) list.push(item)
    else setsByExercise.set(row.template_exercise_id, [item])
  }

  return {
    id: tpl.id,
    name: tpl.name,
    folder: tpl.folder,
    notes: tpl.notes,
    source: tpl.source,
    programmingPolicy:
      tpl.programming_policy == null
        ? null
        : normalizeWorkoutProgrammingPolicy(tpl.programming_policy),
    progression: tpl.progression ?? null,
    updatedAt: tpl.updated_at ?? null,
    archived: tpl.archived,
    exercises: exRows.map((r) => {
      const targetWeight = convertWeight(
        r.target_weight == null ? null : Number(r.target_weight),
        normalizeWeightUnit(r.target_weight_unit),
        displayUnit,
      )
      const exactSets = setsByExercise.get(r.template_exercise_id)
      return {
      exerciseId: r.exercise_id,
      name: r.name,
      tracks: r.tracks,
      preferredUnit: r.preferred_unit === 'kg' ? 'kg' : r.preferred_unit === 'lb' ? 'lb' : null,
      position: r.position,
      targetSets: r.target_sets,
      targetReps: r.target_reps,
      targetWeight,
      targetWeightUnit: displayUnit,
      targetDurationS: r.target_duration_s,
      restSeconds: r.rest_seconds,
      restSecondsWarmup: r.rest_seconds_warmup,
      supersetGroup: r.superset_group,
      section:
        r.section === 'warmup' || r.section === 'cooldown' ? r.section : 'main',
      sets:
        exactSets ??
        legacyEditorSets({
          targetSets: r.target_sets,
          targetReps: r.target_reps,
          targetWeight,
          targetWeightUnit: displayUnit,
          targetDurationS: r.target_duration_s,
          restSeconds: r.rest_seconds,
        }),
      progression: r.progression ?? null,
      notes: r.notes,
    }}),
  }
}

function legacyEditorSets(input: {
  targetSets: number | null
  targetReps: number | null
  targetWeight: number | null
  targetWeightUnit: WeightUnit
  targetDurationS: number | null
  restSeconds: number | null
}): TemplateSetInput[] {
  const hasTarget =
    input.targetReps != null || input.targetWeight != null || input.targetDurationS != null
  const count = input.targetSets != null && input.targetSets > 0 ? input.targetSets : hasTarget ? 1 : 0
  return Array.from({ length: count }, (_, i) => ({
    setNumber: i + 1,
    setType: 'normal',
    targetWeight: input.targetWeight,
    targetWeightUnit: input.targetWeightUnit,
    targetReps: input.targetReps,
    targetDistanceM: null,
    targetDurationS: input.targetDurationS,
    targetRpe: null,
    restSeconds: null,
    side: null,
  }))
}

// ── The editor payload (create / replace) + validation ───────────────────────

/** One exercise slot in the editor's save payload (client → server). */
export interface EditorExerciseInput {
  exerciseId: string
  position: number
  targetSets?: number | null
  targetReps?: number | null
  targetWeight?: number | null
  /** Unit targetWeight is expressed in; omitted callers use the supplied default. */
  targetWeightUnit?: WeightUnit | null
  targetDurationS?: number | null
  restSeconds?: number | null
  restSecondsWarmup?: number | null
  supersetGroup?: number | null
  section?: 'warmup' | 'main' | 'cooldown' | null
  sets?: Array<{
    setNumber?: number
    setType?: string
    targetWeight?: number | null
    targetWeightUnit?: WeightUnit | null
    targetReps?: number | null
    targetDistanceM?: number | null
    targetDurationS?: number | null
    targetRpe?: number | null
    restSeconds?: number | null
    side?: string | null
  }>
  progression?: unknown
  notes?: string | null
}

/** The full builder payload (POST full-create / PATCH replace). */
export interface TemplateEditorPayload {
  name: string
  folder?: string | null
  notes?: string | null
  programmingPolicy?: Partial<WorkoutProgrammingPolicy> | null
  progression?: unknown
  exercises: EditorExerciseInput[]
}

export type ValidationResult =
  | { ok: true; payload: NormalizedPayload }
  | { ok: false; error: string }

/** A validated + normalized payload (positions dense 0..n-1, targets coerced). */
export interface NormalizedPayload {
  name: string
  folder: string | null
  notes: string | null
  /** undefined preserves an existing template policy on replace-all update;
   * null explicitly clears it. */
  programmingPolicy?: WorkoutProgrammingPolicy | null
  progression?: unknown
  exercises: Array<{
    exerciseId: string
    position: number
    targetSets: number | null
    targetReps: number | null
    targetWeight: number | null
    targetWeightUnit: WeightUnit
    targetDurationS: number | null
    restSeconds: number | null
    restSecondsWarmup: number | null
    supersetGroup: number | null
    section: 'warmup' | 'main' | 'cooldown'
    sets: TemplateSetInput[]
    progression: unknown
    notes: string | null
  }>
}

function optInt(v: unknown): number | null {
  if (v == null) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.trunc(v)
}
function optNum(v: unknown): number | null {
  if (v == null) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v
}
function optStr(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

function sectionValue(value: unknown): 'warmup' | 'main' | 'cooldown' {
  return value === 'warmup' || value === 'cooldown' ? value : 'main'
}

function finiteInRange(value: unknown, min: number, max: number): boolean {
  return (
    value == null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)
  )
}

function normalizeSetPayload(
  raw: unknown,
  defaultWeightUnit: WeightUnit,
  exerciseIndex: number,
): { ok: true; sets: TemplateSetInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: `exercise ${exerciseIndex} sets must be an array` }
  if (raw.length > 30) return { ok: false, error: `exercise ${exerciseIndex} has too many sets` }

  const sorted = [...raw].sort((a, b) => {
    const left = optInt((a as Record<string, unknown>)?.setNumber) ?? 0
    const right = optInt((b as Record<string, unknown>)?.setNumber) ?? 0
    return left - right
  })
  const sets: TemplateSetInput[] = []
  for (let i = 0; i < sorted.length; i += 1) {
    const set = sorted[i] as Record<string, unknown>
    const setType = set.setType ?? 'normal'
    if (setType !== 'warmup' && setType !== 'normal' && setType !== 'drop' && setType !== 'failure') {
      return { ok: false, error: `exercise ${exerciseIndex} set ${i + 1} has an invalid setType` }
    }
    if (!finiteInRange(set.targetWeight, 0, 10000)) {
      return { ok: false, error: `exercise ${exerciseIndex} set ${i + 1} has an invalid weight` }
    }
    if (!finiteInRange(set.targetReps, 0, 1000)) {
      return { ok: false, error: `exercise ${exerciseIndex} set ${i + 1} has invalid reps` }
    }
    if (!finiteInRange(set.targetDistanceM, 0, 1_000_000)) {
      return { ok: false, error: `exercise ${exerciseIndex} set ${i + 1} has invalid distance` }
    }
    if (!finiteInRange(set.targetDurationS, 0, 86_400)) {
      return { ok: false, error: `exercise ${exerciseIndex} set ${i + 1} has invalid duration` }
    }
    if (!finiteInRange(set.targetRpe, 0, 10)) {
      return { ok: false, error: `exercise ${exerciseIndex} set ${i + 1} has invalid RPE` }
    }
    if (!finiteInRange(set.restSeconds, 0, 3600)) {
      return { ok: false, error: `exercise ${exerciseIndex} set ${i + 1} has invalid rest` }
    }
    if (set.side != null && set.side !== 'left' && set.side !== 'right') {
      return { ok: false, error: `exercise ${exerciseIndex} set ${i + 1} has an invalid side` }
    }
    if (
      set.targetWeightUnit != null &&
      set.targetWeightUnit !== 'lb' &&
      set.targetWeightUnit !== 'kg'
    ) {
      return { ok: false, error: `exercise ${exerciseIndex} set ${i + 1} has an invalid weight unit` }
    }
    sets.push({
      setNumber: i + 1,
      setType,
      targetWeight: optNum(set.targetWeight),
      targetWeightUnit: normalizeWeightUnit(set.targetWeightUnit, defaultWeightUnit),
      targetReps: optInt(set.targetReps),
      targetDistanceM: optNum(set.targetDistanceM),
      targetDurationS: optInt(set.targetDurationS),
      targetRpe: optNum(set.targetRpe),
      restSeconds: optInt(set.restSeconds),
      side: set.side === 'left' || set.side === 'right' ? set.side : null,
    })
  }
  return { ok: true, sets }
}

/**
 * PURE: validate + normalize an editor payload. Enforces the invariants the DB
 * (and the engine) rely on, so a bad body is a 400 not a 500:
 *   - name is non-empty;
 *   - at least one exercise, each with an exerciseId;
 *   - progression JSON parses to a valid §2.5 policy (via the engine's parser) —
 *     an unreadable policy is REJECTED here (the engine tolerates it at runtime,
 *     but the builder should never SAVE garbage);
 *   - positions are RE-INDEXED to a dense 0..n-1 in the given order (so the
 *     UNIQUE(template_id, position) index can never collide), preserving the
 *     caller's ordering.
 *
 * NOTE: exercise-id EXISTENCE is checked in the DB layer (needs a query); this
 * pure pass covers everything checkable without I/O.
 */
export function validateEditorPayload(
  raw: unknown,
  defaultWeightUnit: WeightUnit = 'lb',
): ValidationResult {
  if (raw == null || typeof raw !== 'object') return { ok: false, error: 'Invalid payload' }
  const b = raw as Record<string, unknown>

  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return { ok: false, error: 'name is required' }
  if (name.length > 120) return { ok: false, error: 'name is too long' }

  if (!Array.isArray(b.exercises) || b.exercises.length === 0) {
    return { ok: false, error: 'at least one exercise is required' }
  }
  if (b.exercises.length > 60) return { ok: false, error: 'too many exercises' }

  const programmingPolicy = Object.prototype.hasOwnProperty.call(b, 'programmingPolicy')
    ? b.programmingPolicy == null
      ? null
      : normalizeWorkoutProgrammingPolicy(b.programmingPolicy)
    : undefined

  // Sort by the caller's position, then re-index densely so gaps/dupes are impossible.
  const sorted = [...b.exercises].sort((a, z) => {
    const pa = optInt((a as Record<string, unknown>)?.position) ?? 0
    const pz = optInt((z as Record<string, unknown>)?.position) ?? 0
    return pa - pz
  })

  const exercises: NormalizedPayload['exercises'] = []
  for (let i = 0; i < sorted.length; i += 1) {
    const e = sorted[i] as Record<string, unknown>
    const exerciseId = typeof e?.exerciseId === 'string' ? e.exerciseId.trim() : ''
    if (!exerciseId) return { ok: false, error: `exercise ${i + 1} is missing an exerciseId` }

    // Progression: null is fine (exact template); any non-null must parse.
    const rawPolicy = e.progression ?? null
    if (rawPolicy != null) {
      const parsed = parsePolicy(rawPolicy)
      if (!parsed) return { ok: false, error: `exercise ${i + 1} has an invalid progression policy` }
    }

    if (!finiteInRange(e.targetSets, 0, 30)) {
      return { ok: false, error: `exercise ${i + 1} has an invalid target set count` }
    }
    if (!finiteInRange(e.targetReps, 0, 1000)) {
      return { ok: false, error: `exercise ${i + 1} has invalid target reps` }
    }
    if (!finiteInRange(e.targetWeight, 0, 10000)) {
      return { ok: false, error: `exercise ${i + 1} has an invalid target weight` }
    }
    if (!finiteInRange(e.targetDurationS, 0, 86_400)) {
      return { ok: false, error: `exercise ${i + 1} has an invalid target duration` }
    }
    if (!finiteInRange(e.restSeconds, 0, 3600) || !finiteInRange(e.restSecondsWarmup, 0, 3600)) {
      return { ok: false, error: `exercise ${i + 1} has invalid rest seconds` }
    }

    const weightUnit = normalizeWeightUnit(e.targetWeightUnit, defaultWeightUnit)
    const scalarTargetSets = optInt(e.targetSets)
    const scalarTargetReps = optInt(e.targetReps)
    const scalarTargetWeight = optNum(e.targetWeight)
    const scalarTargetDuration = optInt(e.targetDurationS)
    let exactSets: TemplateSetInput[]
    if (e.sets !== undefined) {
      const normalizedSets = normalizeSetPayload(e.sets, weightUnit, i + 1)
      if (!normalizedSets.ok) return normalizedSets
      exactSets = normalizedSets.sets
    } else {
      exactSets = legacyEditorSets({
        targetSets: scalarTargetSets,
        targetReps: scalarTargetReps,
        targetWeight: scalarTargetWeight,
        targetWeightUnit: weightUnit,
        targetDurationS: scalarTargetDuration,
        restSeconds: optInt(e.restSeconds),
      })
    }

    const working = exactSets.filter((set) => set.setType !== 'warmup')
    const exactWeightLb = topWeight(
      working.map((set) => templateWeightLb(set.targetWeight, set.targetWeightUnit)),
    )

    exercises.push({
      exerciseId,
      position: i, // dense re-index
      targetSets:
        e.sets !== undefined
          ? (working.length > 0 ? exactTemplateRoundCount(working) : null)
          : scalarTargetSets,
      targetReps: e.sets !== undefined ? modalReps(working.map((set) => set.targetReps)) : scalarTargetReps,
      targetWeight: e.sets !== undefined ? exactWeightLb : scalarTargetWeight,
      targetWeightUnit: e.sets !== undefined ? 'lb' : weightUnit,
      targetDurationS:
        e.sets !== undefined
          ? modalReps(working.map((set) => set.targetDurationS))
          : scalarTargetDuration,
      restSeconds: optInt(e.restSeconds),
      restSecondsWarmup: optInt(e.restSecondsWarmup),
      supersetGroup: optInt(e.supersetGroup),
      section: sectionValue(e.section),
      sets: exactSets,
      progression: rawPolicy,
      notes: optStr(e.notes),
    })
  }

  return {
    ok: true,
    payload: {
      name,
      folder: optStr(b.folder),
      notes: optStr(b.notes),
      ...(programmingPolicy !== undefined ? { programmingPolicy } : {}),
      exercises,
    },
  }
}

/** Verify every exerciseId in the payload exists (and isn't archived). Returns the
 *  first missing id, or null when all resolve. */
export async function findMissingExerciseId(exerciseIds: string[]): Promise<string | null> {
  if (exerciseIds.length === 0) return null
  const unique = [...new Set(exerciseIds)]
  const rows = (
    await db.execute(sql`
      SELECT id FROM exercises
      WHERE id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
        AND archived_at IS NULL
    `)
  ).rows as unknown as Array<{ id: string }>
  const found = new Set(rows.map((r) => r.id))
  return unique.find((id) => !found.has(id)) ?? null
}

/** The drizzle transaction handle type (inferred from db.transaction's callback). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function insertTemplateSets(
  tx: Tx,
  templateExerciseId: string,
  sets: TemplateSetInput[],
): Promise<void> {
  for (const set of sets) {
    const targetWeightLb = templateWeightLb(set.targetWeight, set.targetWeightUnit)
    await tx.execute(sql`
      INSERT INTO template_sets (
        template_exercise_id, set_number, set_type,
        target_weight, target_weight_unit, target_reps,
        target_distance_m, target_duration_s, target_rpe,
        rest_seconds, side
      ) VALUES (
        ${templateExerciseId}, ${set.setNumber}, ${set.setType},
        ${targetWeightLb}, 'lb', ${set.targetReps},
        ${set.targetDistanceM}, ${set.targetDurationS}, ${set.targetRpe},
        ${set.restSeconds}, ${set.side}
      )
    `)
  }
}

/** Insert the normalized exercise rows for a template inside an open transaction. */
async function insertTemplateExercises(
  tx: Tx,
  templateId: string,
  exercises: NormalizedPayload['exercises'],
): Promise<void> {
  for (const e of exercises) {
    const targetWeightLb = templateWeightLb(e.targetWeight, e.targetWeightUnit)
    const [inserted] = (
      await tx.execute(sql`
      INSERT INTO template_exercises (
        template_id, exercise_id, position, target_sets, target_reps,
        target_weight, target_weight_unit, target_duration_s,
        rest_seconds, rest_seconds_warmup, superset_group, section,
        progression, notes
      ) VALUES (
        ${templateId}, ${e.exerciseId}, ${e.position}, ${e.targetSets}, ${e.targetReps},
        ${targetWeightLb}, 'lb', ${e.targetDurationS},
        ${e.restSeconds}, ${e.restSecondsWarmup}, ${e.supersetGroup}, ${e.section},
        ${e.progression == null ? null : sql`${JSON.stringify(e.progression)}::jsonb`},
        ${e.notes}
      )
      RETURNING id
    `)
    ).rows as unknown as Array<{ id: string }>
    if (inserted) await insertTemplateSets(tx, inserted.id, e.sets)
  }
}

/**
 * Create a template from the full builder payload. Assumes the payload was already
 * validated (validateEditorPayload) and its exercise ids exist. `source` = 'user'.
 * Returns the new template id.
 */
export async function createTemplateFromEditor(payload: NormalizedPayload): Promise<string> {
  return db.transaction(async (tx) => {
    const [tpl] = (
      await tx.execute(sql`
        INSERT INTO workout_templates (name, folder, notes, source, programming_policy, progression, updated_at)
        VALUES (
          ${payload.name}, ${payload.folder}, ${payload.notes}, 'user',
          ${payload.programmingPolicy == null
            ? null
            : sql`${JSON.stringify(payload.programmingPolicy)}::jsonb`},
          ${payload.progression == null
            ? null
            : sql`${JSON.stringify(payload.progression)}::jsonb`},
          now()
        )
        RETURNING id
      `)
    ).rows as unknown as { id: string }[]
    const templateId = tpl!.id
    await insertTemplateExercises(tx, templateId, payload.exercises)
    return templateId
  })
}

/**
 * Replace-all update of a template from the builder payload. Wipes the template's
 * exercises and re-inserts the payload's, in ONE transaction (the
 * applyTemplateUpdateForWorkout idiom — dense positions avoid the unique-slot
 * collision). Meta (name/folder/notes) is updated too. Returns false when the
 * template doesn't exist (route 404s).
 */
export async function updateTemplateFromEditor(
  id: string,
  payload: NormalizedPayload,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const programmingPolicyUpdate = payload.programmingPolicy === undefined
      ? sql`programming_policy`
      : payload.programmingPolicy === null
        ? sql`NULL`
        : sql`${JSON.stringify(payload.programmingPolicy)}::jsonb`
    // undefined preserves, null clears — the same three-state contract
    // programming_policy uses, so "omit to keep" holds for both policies.
    const progressionUpdate = payload.progression === undefined
      ? sql`progression`
      : payload.progression === null
        ? sql`NULL`
        : sql`${JSON.stringify(payload.progression)}::jsonb`
    const meta = (
      await tx.execute(sql`
        UPDATE workout_templates
        SET name = ${payload.name}, folder = ${payload.folder}, notes = ${payload.notes},
          programming_policy = ${programmingPolicyUpdate},
          progression = ${progressionUpdate},
          updated_at = now()
        WHERE id = ${id}
        RETURNING id
      `)
    ).rows as unknown as Array<{ id: string }>
    if (meta.length === 0) return false

    await tx.execute(sql`DELETE FROM template_exercises WHERE template_id = ${id}`)
    await insertTemplateExercises(tx, id, payload.exercises)
    return true
  })
}

// ── archive / restore ────────────────────────────────────────────────────────

/** Soft-archive a template (archived_at = now). Returns false if already archived
 *  or missing (honest rowcount). */
export async function archiveTemplate(id: string): Promise<boolean> {
  const rows = (
    await db.execute(sql`
      UPDATE workout_templates SET archived_at = now()
      WHERE id = ${id} AND archived_at IS NULL
      RETURNING id
    `)
  ).rows as unknown as Array<{ id: string }>
  return rows.length > 0
}

/** Restore an archived template. Returns false if not archived / missing. */
export async function unarchiveTemplate(id: string): Promise<boolean> {
  const rows = (
    await db.execute(sql`
      UPDATE workout_templates SET archived_at = NULL
      WHERE id = ${id} AND archived_at IS NOT NULL
      RETURNING id
    `)
  ).rows as unknown as Array<{ id: string }>
  return rows.length > 0
}

// ── duplicate ────────────────────────────────────────────────────────────────

/**
 * Duplicate a template (name + " (copy)"), carrying every exercise slot verbatim
 * (targets, rest, superset grouping, progression policy). The copy is always a
 * fresh 'user' template (a duplicated AI draft becomes the user's to own). Returns the
 * new template summary, or null if the source is missing.
 */
export async function duplicateTemplate(id: string): Promise<CreatedTemplate | null> {
  const source = await getTemplateForEditor(id)
  if (!source) return null

  const copyName = `${source.name} (copy)`.slice(0, 120)
  const exercises: NormalizedPayload['exercises'] = source.exercises.map((e, i) => ({
    exerciseId: e.exerciseId,
    position: i,
    targetSets: e.targetSets,
    targetReps: e.targetReps,
    targetWeight: e.targetWeight,
    targetWeightUnit: e.targetWeightUnit,
    targetDurationS: e.targetDurationS,
    restSeconds: e.restSeconds,
    restSecondsWarmup: e.restSecondsWarmup,
    supersetGroup: e.supersetGroup,
    section: e.section,
    sets: e.sets.map((set) => ({ ...set })),
    progression: e.progression ?? null,
    notes: e.notes,
  }))

  const newId = await createTemplateFromEditor({
    name: copyName,
    folder: source.folder,
    notes: source.notes,
    exercises,
  })

  return { id: newId, name: copyName, folder: source.folder, exerciseCount: exercises.length }
}
