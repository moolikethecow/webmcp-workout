/**
 * Versioned training plans — the layer above full-fidelity workout templates.
 *
 * A plan owns an ordered sequence of template-backed days plus explicit,
 * deterministic adaptation policy. Templates remain the workout definition;
 * progression.ts remains the arithmetic engine. This module schedules the next
 * due day, snapshots every edit, records which plan/day produced a workout, and
 * renders an auditable next-session preview ("+5 lb after 3×10", not vibes).
 */
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { dateInZoneSql, getAppTimezone, todayInZone } from '@/lib/today'
import {
  dominantUnit,
  evaluateProgression,
  parsePolicy,
  type HistorySet,
  type ProgressionPolicy,
  type SessionHistory,
  type TargetSet,
  type Unit,
} from '@/lib/gym/progression'
import {
  getActiveWorkoutById,
  materializeSetPrescriptions,
  startWorkout,
  type ActiveWorkout,
  type SetPrescriptionInput,
} from '@/lib/gym/active-workout'
import { getTemplateForEditor, type EditorExercise } from '@/lib/gym/templates-read'
import {
  inferProgrammingGoal,
  normalizeWorkoutProgrammingPolicy,
  programWorkout,
  type ProgrammableExercise,
  type ProgrammingMetadata,
  type WorkoutProgrammingPolicy,
} from '@/lib/gym/programming-policy'
import { readProgrammingHistory } from '@/lib/gym/programming-history'
import { movementPattern } from '@/lib/gym/novelty'
import { musclesForExerciseEnriched } from '@/lib/fitness/muscles'

export type TrainingPlanStatus = 'active' | 'paused' | 'archived'
export type TrainingScheduleMode = 'flexible' | 'fixed'

export interface PeriodizationBlock {
  name: string
  /** Whole plan cycles spent in this block. A four-day plan normally completes
   * one cycle per week, but flexible scheduling never forces weekdays. */
  weeks: number
  /** Optional block-wide policy for plan-managed exercises. */
  progression?: ProgressionPolicy
  /** Deterministic overlays applied after progression targets are calculated. */
  volumeMultiplier?: number
  loadMultiplier?: number
  repRange?: [number, number]
  targetRpe?: number
  deload?: boolean
}

export interface TrainingPlanPolicy {
  /** Default for template exercises with no bespoke progression rule. */
  progression: ProgressionPolicy
  /** Apply the plan/block default only where an exercise has no explicit rule. */
  applyToUnconfiguredExercises: boolean
  /** Targets change automatically; the base template is never silently rewritten. */
  autoAdjustTargets: boolean
  reviewEverySessions: number
  /** Shared order/rest/reps/superset/warm-up defaults for plan-backed days. */
  programming: WorkoutProgrammingPolicy
  blocks: PeriodizationBlock[]
  repeatBlocks: boolean
}

export interface TrainingPlanDayInput {
  /** Stable identity from a prior plan read. Include on update/reorder so
   * historical sessions continue to refer to the same semantic day. */
  dayId?: string | null
  name: string
  templateId: string
  weekday?: number | null
  notes?: string | null
}

export interface TrainingPlanInput {
  name: string
  goal?: string | null
  scheduleMode?: TrainingScheduleMode
  policy?: Partial<TrainingPlanPolicy> | null
  days: TrainingPlanDayInput[]
}

export interface TrainingPlanDay {
  id: string
  position: number
  name: string
  templateId: string
  templateName: string
  exerciseCount: number
  weekday: number | null
  notes: string | null
  /** False when the backing template was archived after the plan was saved. */
  available: boolean
}

export interface PlanSessionSummary {
  workoutId: string
  workoutName: string | null
  /** Null only when a later plan edit removed the historical day row. */
  dayId: string | null
  dayName: string
  status: string
  startedAt: string
  endedAt: string | null
  blockIndex: number | null
}

export interface PlanTargetPreview {
  exerciseId: string
  exerciseName: string
  unit: Unit
  /** True when this plan will write these targets into the next workout. */
  managed: boolean
  ruleText: string
  decision: string
  targets: PlanTargetSet[]
}

export interface PlanTargetSet extends TargetSet {
  rpe?: number
  side?: 'left' | 'right' | null
}

export interface TrainingPlan {
  id: string
  name: string
  goal: string | null
  status: TrainingPlanStatus
  scheduleMode: TrainingScheduleMode
  policy: TrainingPlanPolicy
  version: number
  createdAt: string
  updatedAt: string
  days: TrainingPlanDay[]
  completedSessions: number
  /** Cadence signal from reviewEverySessions; revisiting the plan is the
   * intended review surface, not an invisible automatic rewrite. */
  reviewDue: boolean
  sessionsUntilReview: number
  nextDay: TrainingPlanDay | null
  currentBlock: (PeriodizationBlock & { index: number; cycle: number }) | null
  recentSessions: PlanSessionSummary[]
  nextTargets?: PlanTargetPreview[]
}

export class TrainingPlanValidationError extends Error {}
export class TrainingPlanNotFoundError extends Error {}

const DEFAULT_POLICY: TrainingPlanPolicy = {
  progression: {
    type: 'double_progression',
    repRange: [8, 10],
    increment: 5,
    requiredSets: 3,
    deloadAfterMisses: 2,
    deloadPct: 10,
  },
  applyToUnconfiguredExercises: true,
  autoAdjustTargets: true,
  reviewEverySessions: 4,
  programming: normalizeWorkoutProgrammingPolicy(null),
  blocks: [],
  repeatBlocks: false,
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function boundedInt(value: unknown, fallback: number, lo: number, hi: number): number {
  return finite(value) ? Math.max(lo, Math.min(hi, Math.round(value))) : fallback
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text.slice(0, max) : null
}

function normalizeBlock(value: unknown, index: number): PeriodizationBlock {
  const row = record(value)
  if (!row) throw new TrainingPlanValidationError(`Block ${index + 1} must be an object`)
  const name = cleanText(row.name, 80) ?? `Block ${index + 1}`
  const weeks = boundedInt(row.weeks, 1, 1, 52)
  const progression = row.progression === undefined ? undefined : parsePolicy(row.progression)
  if (row.progression !== undefined && !progression) {
    throw new TrainingPlanValidationError(`Block ${index + 1} has an invalid progression policy`)
  }
  let repRange: [number, number] | undefined
  if (row.repRange !== undefined) {
    if (
      !Array.isArray(row.repRange) ||
      row.repRange.length !== 2 ||
      !finite(row.repRange[0]) ||
      !finite(row.repRange[1]) ||
      row.repRange[0] <= 0 ||
      row.repRange[0] > row.repRange[1]
    ) {
      throw new TrainingPlanValidationError(`Block ${index + 1} has an invalid repRange`)
    }
    repRange = [Math.round(row.repRange[0]), Math.round(row.repRange[1])]
  }
  const volumeMultiplier = finite(row.volumeMultiplier)
    ? Math.max(0.25, Math.min(2, row.volumeMultiplier))
    : undefined
  const loadMultiplier = finite(row.loadMultiplier)
    ? Math.max(0.5, Math.min(1.25, row.loadMultiplier))
    : undefined
  const targetRpe = finite(row.targetRpe) ? Math.max(1, Math.min(10, row.targetRpe)) : undefined
  return {
    name,
    weeks,
    ...(progression ? { progression } : {}),
    ...(volumeMultiplier !== undefined ? { volumeMultiplier } : {}),
    ...(loadMultiplier !== undefined ? { loadMultiplier } : {}),
    ...(repRange ? { repRange } : {}),
    ...(targetRpe !== undefined ? { targetRpe } : {}),
    ...(row.deload === true ? { deload: true } : {}),
  }
}

export function normalizeTrainingPlanPolicy(raw: unknown): TrainingPlanPolicy {
  const row = record(raw) ?? {}
  const parsed = row.progression === undefined
    ? DEFAULT_POLICY.progression
    : parsePolicy(row.progression)
  if (!parsed) throw new TrainingPlanValidationError('Invalid default progression policy')
  const blocksRaw = Array.isArray(row.blocks) ? row.blocks : []
  if (blocksRaw.length > 12) throw new TrainingPlanValidationError('A plan supports at most 12 blocks')
  return {
    progression: parsed,
    applyToUnconfiguredExercises: row.applyToUnconfiguredExercises !== false,
    autoAdjustTargets: row.autoAdjustTargets !== false,
    reviewEverySessions: boundedInt(row.reviewEverySessions, 4, 1, 24),
    programming: normalizeWorkoutProgrammingPolicy(row.programming),
    blocks: blocksRaw.map(normalizeBlock),
    repeatBlocks: row.repeatBlocks === true,
  }
}

export function normalizeTrainingPlanInput(raw: unknown): TrainingPlanInput & { policy: TrainingPlanPolicy } {
  const row = record(raw)
  if (!row) throw new TrainingPlanValidationError('Plan must be an object')
  const name = cleanText(row.name, 120)
  if (!name) throw new TrainingPlanValidationError('Plan name is required')
  if (!Array.isArray(row.days) || row.days.length < 1 || row.days.length > 7) {
    throw new TrainingPlanValidationError('A plan needs 1–7 workout days')
  }
  const days = row.days.map((value, index) => {
    const day = record(value)
    if (!day) throw new TrainingPlanValidationError(`Day ${index + 1} must be an object`)
    const templateId = cleanText(day.templateId, 80)
    if (!templateId) throw new TrainingPlanValidationError(`Day ${index + 1} needs a templateId`)
    const weekday = day.weekday == null ? null : boundedInt(day.weekday, -1, 0, 6)
    if (weekday === -1) throw new TrainingPlanValidationError(`Day ${index + 1} weekday must be 0–6`)
    return {
      dayId: cleanText(day.dayId, 80),
      name: cleanText(day.name, 100) ?? `Day ${index + 1}`,
      templateId,
      weekday,
      notes: cleanText(day.notes, 1000),
    }
  })
  const scheduleMode: TrainingScheduleMode = row.scheduleMode === 'fixed' ? 'fixed' : 'flexible'
  if (scheduleMode === 'fixed' && days.some((day) => day.weekday == null)) {
    throw new TrainingPlanValidationError('Fixed plans need a weekday for every day')
  }
  const goal = cleanText(row.goal, 1000)
  const policyRow = record(row.policy) ?? {}
  const programmingRow = record(policyRow.programming) ?? {}
  const policy = normalizeTrainingPlanPolicy({
    ...policyRow,
    programming: {
      goal: inferProgrammingGoal([goal]),
      ...programmingRow,
    },
  })
  return {
    name,
    goal,
    scheduleMode,
    policy,
    days,
  }
}

export interface ResolvedTrainingPlanDayInput {
  day: TrainingPlanDayInput
  existingId: string | null
}

/** Preserve semantic day identity across reorder/rename. Explicit IDs win;
 * legacy clients that omit them are matched by unchanged name+template, then
 * by an unambiguous template. A true replacement receives a new ID. */
export function resolvePlanDayIdentities(
  existing: TrainingPlanDay[],
  incoming: TrainingPlanDayInput[],
): ResolvedTrainingPlanDayInput[] {
  const available = new Map(existing.map((day) => [day.id, day]))
  const used = new Set<string>()
  return incoming.map((day, index) => {
    if (day.dayId) {
      if (!available.has(day.dayId)) {
        throw new TrainingPlanValidationError(`Day ${index + 1} has an unknown dayId`)
      }
      if (used.has(day.dayId)) {
        throw new TrainingPlanValidationError(`Day ${index + 1} repeats dayId ${day.dayId}`)
      }
      used.add(day.dayId)
      return { day, existingId: day.dayId }
    }
    const unused = existing.filter((candidate) => !used.has(candidate.id))
    const exact = unused.filter(
      (candidate) => candidate.templateId === day.templateId && candidate.name === day.name,
    )
    const byTemplate = unused.filter((candidate) => candidate.templateId === day.templateId)
    const match = exact.length === 1
      ? exact[0]
      : byTemplate.length === 1
        ? byTemplate[0]
        : null
    if (match) used.add(match.id)
    return { day, existingId: match?.id ?? null }
  })
}

/** Resolve the active periodization block from completed plan cycles. Pure. */
export function resolveCurrentBlock(
  blocks: PeriodizationBlock[],
  completedSessions: number,
  daysPerCycle: number,
  repeat: boolean,
): (PeriodizationBlock & { index: number; cycle: number }) | null {
  if (blocks.length === 0 || daysPerCycle <= 0) return null
  const cycle = Math.floor(completedSessions / daysPerCycle)
  const total = blocks.reduce((sum, block) => sum + block.weeks, 0)
  if (total <= 0) return null
  const blockCycle = repeat ? cycle % total : Math.min(cycle, total - 1)
  let cursor = 0
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    cursor += block.weeks
    if (blockCycle < cursor) return { ...block, index, cycle }
  }
  const index = blocks.length - 1
  return { ...blocks[index]!, index, cycle }
}

/** Stable identifier for one occurrence of a block sequence. It stays the same
 * across every week/cycle inside a multi-week block, but changes when a repeating
 * periodization sequence returns to the same block later. */
export function resolveBlockOccurrence(
  blocks: PeriodizationBlock[],
  block: (PeriodizationBlock & { index: number; cycle: number }) | null,
  repeat: boolean,
): number | null {
  if (!block || blocks.length === 0) return null
  const total = blocks.reduce((sum, candidate) => sum + candidate.weeks, 0)
  const startWithinSequence = blocks
    .slice(0, block.index)
    .reduce((sum, candidate) => sum + candidate.weeks, 0)
  const sequence = repeat && total > 0 ? Math.floor(block.cycle / total) : 0
  return sequence * total + startWithinSequence
}

/** Apply block volume/load/reps/RPE overlays to already-computed targets. Pure. */
export function applyBlockOverlay(
  targets: PlanTargetSet[],
  block: PeriodizationBlock | null,
  volumeBaseCount = targets.length,
): PlanTargetSet[] {
  if (!block) return targets.map((target) => ({ ...target }))
  // Volume is anchored to the saved template prescription. Using the prior
  // overlaid session count here would make a 0.7 block shrink 3→2→1 over time.
  const countBase = block.volumeMultiplier == null ? targets.length : volumeBaseCount
  const rawCount = Math.max(1, Math.round(countBase * (block.volumeMultiplier ?? 1)))
  // Unilateral prescriptions are authored as L/R pairs. Periodization may
  // change the number of rounds, but it must never leave an orphan side.
  const paired = targets.length > 0 && targets.every((target) => target.side != null)
  const count = paired ? Math.max(2, Math.round(rawCount / 2) * 2) : rawCount
  const source = targets.length > 0 ? targets : [{}]
  const out = Array.from({ length: count }, (_, index) => ({ ...source[index % source.length]! }))
  return out.map((target) => {
    if (target.weight != null && block.loadMultiplier != null) {
      target.weight = Math.round(target.weight * block.loadMultiplier * 4) / 4
    }
    if (block.repRange) target.reps = block.repRange[0]
    if (block.targetRpe != null) target.rpe = block.targetRpe
    return target
  })
}

/** Seed the first plan-managed session from the explicit plan policy rather
 * than silently inheriting an arbitrary template volume/rep scheme. */
export function seedManagedTargets(
  exact: PlanTargetSet[],
  policy: ProgressionPolicy,
): PlanTargetSet[] {
  if (policy.type !== 'double_progression' || exact.length === 0) {
    return exact.map((target) => ({ ...target }))
  }
  const requiredSets = policy.requiredSets ?? 3
  const perSide = exact.every((target) => target.side === 'left' || target.side === 'right')
  const logical = perSide
    ? exact.filter((target) => target.side === 'left')
    : exact
  const source = logical.length > 0 ? logical : exact
  const seedWeight = source.find((target) => target.weight != null)?.weight
  const rounds = Array.from({ length: requiredSets }, (_, index): PlanTargetSet => {
    const target = { ...source[index % source.length]! }
    if (seedWeight != null) target.weight = seedWeight
    target.reps = policy.repRange[0]
    target.side = null
    return target
  })
  return perSide
    ? rounds.flatMap((target) => [
        { ...target, side: 'left' as const },
        { ...target, side: 'right' as const },
      ])
    : rounds
}

function topWeight(sets: Array<HistorySet | TargetSet>): number | null {
  const values = sets.map((set) => set.weight).filter((value): value is number => finite(value))
  return values.length > 0 ? Math.max(...values) : null
}

function minReps(sets: Array<HistorySet | TargetSet>): number | null {
  const values = sets.map((set) => set.reps).filter((value): value is number => finite(value))
  return values.length > 0 ? Math.min(...values) : null
}

export function explainTargetChange(
  previous: HistorySet[],
  targets: TargetSet[],
  unit: Unit,
): string {
  if (previous.length === 0) return 'Starting targets from the template.'
  const beforeWeight = topWeight(previous)
  const nextWeight = topWeight(targets)
  if (beforeWeight != null && nextWeight != null && nextWeight > beforeWeight + 0.01) {
    return `Bump +${Math.round((nextWeight - beforeWeight) * 100) / 100} ${unit} — the progression rule cleared.`
  }
  if (beforeWeight != null && nextWeight != null && nextWeight < beforeWeight - 0.01) {
    return `Deload ${Math.round((beforeWeight - nextWeight) * 100) / 100} ${unit} — the miss threshold fired.`
  }
  const beforeReps = minReps(previous)
  const nextReps = minReps(targets)
  if (beforeReps != null && nextReps != null && nextReps > beforeReps) {
    return `Add ${nextReps - beforeReps} rep${nextReps - beforeReps === 1 ? '' : 's'} per set; load stays put.`
  }
  const changedRepSets = targets
    .map((target, index) => ({
      index,
      delta:
        target.reps != null && previous[index]?.reps != null
          ? target.reps - previous[index]!.reps!
          : 0,
    }))
    .filter((change) => change.delta > 0)
  if (changedRepSets.length === 1) {
    const change = changedRepSets[0]!
    return `Add ${change.delta} rep${change.delta === 1 ? '' : 's'} to set ${change.index + 1}; load stays put.`
  }
  if (changedRepSets.length > 1) {
    const total = changedRepSets.reduce((sum, change) => sum + change.delta, 0)
    return `Add ${total} total reps across ${changedRepSets.length} sets; load stays put.`
  }
  return 'Repeat the target — the progression rule has not cleared yet.'
}

export function explainPlanDecision(
  previous: HistorySet[],
  targets: PlanTargetSet[],
  unit: Unit,
  block: PeriodizationBlock | null,
): string {
  if (!block) return explainTargetChange(previous, targets, unit)
  const overlays: string[] = []
  if (block.volumeMultiplier != null) {
    const paired = targets.length > 0 && targets.every((target) => target.side != null)
    const sets = paired ? targets.length / 2 : targets.length
    overlays.push(`${sets} work set${sets === 1 ? '' : 's'}`)
  }
  if (block.loadMultiplier != null) {
    overlays.push(`${Math.round(block.loadMultiplier * 100)}% baseline load`)
  }
  if (block.repRange) overlays.push(`${block.repRange[0]}–${block.repRange[1]} reps`)
  if (block.targetRpe != null) overlays.push(`target RPE ${block.targetRpe}`)
  if (overlays.length === 0) return explainTargetChange(previous, targets, unit)
  return `${block.name} block — ${overlays.join(', ')}.`
}

interface PlanRow {
  id: string
  name: string
  goal: string | null
  status: TrainingPlanStatus
  schedule_mode: TrainingScheduleMode
  policy: unknown
  version: number
  created_at: string
  updated_at: string
}

async function assertTemplates(ids: string[]): Promise<void> {
  const unique = [...new Set(ids)]
  const rows = (
    await db.execute(sql`
      SELECT id FROM workout_templates
      WHERE id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
        AND archived_at IS NULL
    `)
  ).rows as unknown as Array<{ id: string }>
  const found = new Set(rows.map((row) => row.id))
  const missing = unique.find((id) => !found.has(id))
  if (missing) throw new TrainingPlanValidationError(`Template ${missing} does not exist`)
}

export async function createTrainingPlan(raw: unknown, actor = 'web'): Promise<TrainingPlan> {
  await ensureGymSchema()
  const input = normalizeTrainingPlanInput(raw)
  await assertTemplates(input.days.map((day) => day.templateId))
  const id = await db.transaction(async (tx) => {
    const [created] = (
      await tx.execute(sql`
        INSERT INTO training_plans (name, goal, status, schedule_mode, policy, version)
        VALUES (${input.name}, ${input.goal ?? null}, 'active', ${input.scheduleMode}, ${JSON.stringify(input.policy)}::jsonb, 1)
        RETURNING id
      `)
    ).rows as unknown as Array<{ id: string }>
    const planId = created!.id
    for (let position = 0; position < input.days.length; position += 1) {
      const day = input.days[position]!
      await tx.execute(sql`
        INSERT INTO training_plan_days (plan_id, position, name, template_id, weekday, notes)
        VALUES (${planId}, ${position}, ${day.name}, ${day.templateId}, ${day.weekday ?? null}, ${day.notes ?? null})
      `)
    }
    await tx.execute(sql`
      INSERT INTO training_plan_versions (plan_id, version, snapshot, actor, reason)
      VALUES (${planId}, 1, ${JSON.stringify(input)}::jsonb, ${actor}, 'created')
    `)
    return planId
  })
  return (await getTrainingPlan(id, true))!
}

export async function updateTrainingPlan(
  id: string,
  raw: unknown,
  actor = 'web',
): Promise<TrainingPlan> {
  await ensureGymSchema()
  const existing = await getTrainingPlan(id)
  if (!existing) throw new TrainingPlanNotFoundError('Training plan not found')
  const row = record(raw)
  if (!row) throw new TrainingPlanValidationError('Plan update must be an object')
  const merged = normalizeTrainingPlanInput({
    name: row.name ?? existing.name,
    goal: row.goal === undefined ? existing.goal : row.goal,
    scheduleMode: row.scheduleMode ?? existing.scheduleMode,
    policy: row.policy ?? existing.policy,
    days: row.days ?? existing.days.map((day) => ({
      dayId: day.id,
      name: day.name,
      templateId: day.templateId,
      weekday: day.weekday,
      notes: day.notes,
    })),
  })
  await assertTemplates(merged.days.map((day) => day.templateId))
  const resolvedDays = resolvePlanDayIdentities(existing.days, merged.days)
  const nextVersion = existing.version + 1
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE training_plans
      SET name = ${merged.name}, goal = ${merged.goal ?? null},
          schedule_mode = ${merged.scheduleMode}, policy = ${JSON.stringify(merged.policy)}::jsonb,
          version = ${nextVersion}, updated_at = now()
      WHERE id = ${id}
    `)
    // Stage existing rows out of the unique (plan_id, position) range before
    // reordering. Updating 0→1 while 1 still exists would otherwise violate the
    // constraint even though the final ordered list is valid.
    await tx.execute(sql`
      UPDATE training_plan_days
      SET position = position + 1000
      WHERE plan_id = ${id}
    `)
    const keptIds = new Set(
      resolvedDays.map((resolved) => resolved.existingId).filter((value): value is string => value != null),
    )
    for (const current of existing.days) {
      if (!keptIds.has(current.id)) {
        await tx.execute(sql`DELETE FROM training_plan_days WHERE id = ${current.id} AND plan_id = ${id}`)
      }
    }
    for (let position = 0; position < resolvedDays.length; position += 1) {
      const { day, existingId } = resolvedDays[position]!
      if (existingId) {
        await tx.execute(sql`
          UPDATE training_plan_days
          SET name = ${day.name}, template_id = ${day.templateId},
              weekday = ${day.weekday ?? null}, notes = ${day.notes ?? null},
              position = ${position}
          WHERE id = ${existingId} AND plan_id = ${id}
        `)
      } else {
        await tx.execute(sql`
          INSERT INTO training_plan_days (plan_id, position, name, template_id, weekday, notes)
          VALUES (${id}, ${position}, ${day.name}, ${day.templateId}, ${day.weekday ?? null}, ${day.notes ?? null})
        `)
      }
    }
    await tx.execute(sql`
      INSERT INTO training_plan_versions (plan_id, version, snapshot, actor, reason)
      VALUES (${id}, ${nextVersion}, ${JSON.stringify(merged)}::jsonb, ${actor}, 'updated')
    `)
  })
  return (await getTrainingPlan(id, true))!
}

export async function setTrainingPlanStatus(
  id: string,
  status: TrainingPlanStatus,
): Promise<TrainingPlan> {
  await ensureGymSchema()
  const rows = (
    await db.execute(sql`
      UPDATE training_plans SET status = ${status}, updated_at = now()
      WHERE id = ${id}
      RETURNING id
    `)
  ).rows as unknown as Array<{ id: string }>
  if (!rows[0]) throw new TrainingPlanNotFoundError('Training plan not found')
  return (await getTrainingPlan(id, true))!
}

async function planDays(planId: string): Promise<TrainingPlanDay[]> {
  const rows = (
    await db.execute(sql`
      SELECT d.id, d.position, d.name, d.template_id, t.name AS template_name,
        t.archived_at IS NULL AS available,
        d.weekday, d.notes,
        (SELECT count(*)::int FROM template_exercises te WHERE te.template_id = d.template_id) AS exercise_count
      FROM training_plan_days d
      JOIN workout_templates t ON t.id = d.template_id
      WHERE d.plan_id = ${planId}
      ORDER BY d.position
    `)
  ).rows as unknown as Array<{
    id: string
    position: number
    name: string
    template_id: string
    template_name: string
    exercise_count: number
    weekday: number | null
    notes: string | null
    available: boolean
  }>
  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    name: row.name,
    templateId: row.template_id,
    templateName: row.template_name,
    exerciseCount: row.exercise_count,
    weekday: row.weekday,
    notes: row.notes,
    available: row.available,
  }))
}

async function planSessionState(planId: string): Promise<{
  completed: number
  recent: PlanSessionSummary[]
  completedTodayDayIds: Set<string>
}> {
  const timezone = await getAppTimezone()
  const today = todayInZone(timezone)
  const [countRow] = (
    await db.execute(sql`
      SELECT count(*)::int AS count
      FROM training_plan_sessions ps
      JOIN workouts w ON w.id = ps.workout_id AND w.status = 'completed'
      WHERE ps.plan_id = ${planId}
    `)
  ).rows as unknown as Array<{ count: number }>
  const rows = (
    await db.execute(sql`
      SELECT w.id AS workout_id, w.name AS workout_name,
        ps.plan_day_id AS day_id,
        COALESCE(ps.day_name, d.name, 'Removed plan day') AS day_name,
        w.status, w.started_at::text AS started_at, w.ended_at::text AS ended_at,
        ${dateInZoneSql(sql`w.ended_at`, timezone)}::text AS ended_day,
        ps.block_index
      FROM training_plan_sessions ps
      JOIN workouts w ON w.id = ps.workout_id
      LEFT JOIN training_plan_days d ON d.id = ps.plan_day_id
      WHERE ps.plan_id = ${planId}
      ORDER BY ps.sequence_index DESC
      LIMIT 12
    `)
  ).rows as unknown as Array<{
    workout_id: string
    workout_name: string | null
    day_id: string | null
    day_name: string
    status: string
    started_at: string
    ended_at: string | null
    ended_day: string | null
    block_index: number | null
  }>
  return {
    completed: countRow?.count ?? 0,
    completedTodayDayIds: new Set(
      rows
        .filter((row) => row.status === 'completed' && row.ended_day === today && row.day_id)
        .map((row) => row.day_id!),
    ),
    recent: rows.map((row) => ({
      workoutId: row.workout_id,
      workoutName: row.workout_name,
      dayId: row.day_id,
      dayName: row.day_name,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      blockIndex: row.block_index,
    })),
  }
}

/** Pick today's fixed day when it is still due; otherwise the nearest upcoming
 * configured weekday. A completed day cannot immediately repeat on the same
 * date, while an explicit day_id start remains available for intentional swaps. */
export function resolveFixedNextDay(
  days: TrainingPlanDay[],
  todayWeekday: number,
  completedTodayDayIds: Set<string>,
): TrainingPlanDay | null {
  if (days.length === 0) return null
  const remaining = days.filter((day) => !completedTodayDayIds.has(day.id))
  const source = remaining.length > 0 ? remaining : days
  return [...source].sort((a, b) => {
    const aDay = a.weekday ?? a.position % 7
    const bDay = b.weekday ?? b.position % 7
    let aDelta = (aDay - todayWeekday + 7) % 7
    let bDelta = (bDay - todayWeekday + 7) % 7
    if (completedTodayDayIds.has(a.id) && aDelta === 0) aDelta = 7
    if (completedTodayDayIds.has(b.id) && bDelta === 0) bDelta = 7
    return aDelta - bDelta || a.position - b.position
  })[0] ?? null
}

/** Flexible plans follow the day that was actually completed, not a blind
 * session counter. Starting Lower A out of order therefore advances to the day
 * after Lower A instead of accidentally offering Lower A twice. */
export function resolveFlexibleNextDay(
  days: TrainingPlanDay[],
  recentSessions: PlanSessionSummary[],
  completedSessions: number,
): TrainingPlanDay | null {
  if (days.length === 0) return null
  const latestCompleted = recentSessions.find((session) => session.status === 'completed')
  const lastIndex = latestCompleted?.dayId
    ? days.findIndex((day) => day.id === latestCompleted.dayId)
    : -1
  return lastIndex >= 0
    ? days[(lastIndex + 1) % days.length]!
    : days[completedSessions % days.length]!
}

async function hydratePlan(row: PlanRow, withPreview: boolean): Promise<TrainingPlan> {
  const [days, sessions] = await Promise.all([planDays(row.id), planSessionState(row.id)])
  const policy = normalizeTrainingPlanPolicy(row.policy)
  const today = todayInZone(await getAppTimezone())
  const todayWeekday = new Date(`${today}T00:00:00Z`).getUTCDay()
  const nextDay = row.schedule_mode === 'fixed'
    ? resolveFixedNextDay(days, todayWeekday, sessions.completedTodayDayIds)
    : resolveFlexibleNextDay(days, sessions.recent, sessions.completed)
  const currentBlock = resolveCurrentBlock(
    policy.blocks,
    sessions.completed,
    days.length,
    policy.repeatBlocks,
  )
  const reviewRemainder = sessions.completed % policy.reviewEverySessions
  const reviewDue = sessions.completed > 0 && reviewRemainder === 0
  const plan: TrainingPlan = {
    id: row.id,
    name: row.name,
    goal: row.goal,
    status: row.status,
    scheduleMode: row.schedule_mode,
    policy,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    days,
    completedSessions: sessions.completed,
    reviewDue,
    sessionsUntilReview: reviewDue
      ? 0
      : policy.reviewEverySessions - reviewRemainder,
    nextDay,
    currentBlock,
    recentSessions: sessions.recent,
  }
  if (withPreview && nextDay?.available) {
    plan.nextTargets = await previewPlanDay(nextDay, policy, currentBlock, row.id)
  }
  return plan
}

export async function listTrainingPlans(includeArchived = false): Promise<TrainingPlan[]> {
  await ensureGymSchema()
  const rows = (
    await db.execute(sql`
      SELECT id, name, goal, status, schedule_mode, policy, version,
        created_at::text AS created_at, updated_at::text AS updated_at
      FROM training_plans
      WHERE ${includeArchived ? sql`true` : sql`status <> 'archived'`}
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, updated_at DESC
    `)
  ).rows as unknown as PlanRow[]
  return Promise.all(rows.map((row) => hydratePlan(row, row.status === 'active')))
}

export async function getTrainingPlan(id: string, withPreview = false): Promise<TrainingPlan | null> {
  await ensureGymSchema()
  const [row] = (
    await db.execute(sql`
      SELECT id, name, goal, status, schedule_mode, policy, version,
        created_at::text AS created_at, updated_at::text AS updated_at
      FROM training_plans WHERE id = ${id} LIMIT 1
    `)
  ).rows as unknown as PlanRow[]
  return row ? hydratePlan(row, withPreview) : null
}

interface HistoryRow {
  exercise_id: string
  workout_id: string
  started_at: string
  set_number: number
  weight: number | null
  weight_unit: string | null
  reps: number | null
  duration_s: number | null
  side: string | null
  plan_id: string | null
  block_index: number | null
  block_occurrence: number | null
  block_load_multiplier: number | null
}

export function removeBlockLoadOverlay(
  weight: number | null,
  multiplier: number | null | undefined,
): number | null {
  if (weight == null) return null
  const applied = multiplier ?? 1
  return applied > 0
    ? Math.round((weight / applied) * 1_000_000) / 1_000_000
    : weight
}

function historyByExercise(
  rows: HistoryRow[],
  planId: string,
  currentBlockIndex: number | null,
  currentBlockOccurrence: number | null,
): Map<string, SessionHistory> {
  interface GroupedSession {
    sets: HistorySet[]
    planId: string | null
    blockIndex: number | null
    blockOccurrence: number | null
  }
  const grouped = new Map<string, Map<string, GroupedSession>>()
  for (const row of rows) {
    let sessions = grouped.get(row.exercise_id)
    if (!sessions) {
      sessions = new Map()
      grouped.set(row.exercise_id, sessions)
    }
    let session = sessions.get(row.workout_id)
    if (!session) {
      session = {
        sets: [],
        planId: row.plan_id,
        blockIndex: row.block_index,
        blockOccurrence: row.block_occurrence,
      }
      sessions.set(row.workout_id, session)
    }
    session.sets.push({
      // Plan block load is a presentation/programming overlay on the stable
      // progression baseline. Remove the prior overlay before evaluating the
      // next target, then reapply the current block exactly once.
      weight: removeBlockLoadOverlay(
        row.weight,
        row.plan_id === planId ? row.block_load_multiplier : null,
      ),
      unit: row.weight_unit === 'kg' ? 'kg' : 'lb',
      reps: row.reps,
      durationS: row.duration_s,
      side: row.side === 'left' || row.side === 'right' ? row.side : null,
    })
  }
  return new Map([...grouped].map(([exerciseId, sessionMap]) => {
    const sessions = [...sessionMap.values()]
    if (currentBlockIndex == null) return [exerciseId, sessions.map((session) => session.sets)]
    const inBlock = sessions.filter(
      (session) =>
        session.planId === planId &&
        session.blockIndex === currentBlockIndex &&
        session.blockOccurrence === currentBlockOccurrence,
    )
    // A block starts from one prior session as a load seed, then its own history
    // governs misses/bumps. This resets miss streaks across rep-range phases.
    const selected = inBlock.length > 0 ? inBlock : sessions.slice(-1)
    return [exerciseId, selected.map((session) => session.sets)]
  }))
}

/** Full-fidelity working targets. Warm-up rows remain in the template/workout,
 * but progression and periodization never silently turn them into work sets. */
function templateTargets(row: EditorExercise): PlanTargetSet[] {
  const working = row.sets.filter((set) => set.setType !== 'warmup')
  const source = working.length > 0 ? working : row.sets
  return source.map((set) => ({
    ...(set.targetWeight != null ? { weight: set.targetWeight } : {}),
    ...(set.targetReps != null ? { reps: set.targetReps } : {}),
    ...(set.targetDurationS != null ? { durationS: set.targetDurationS } : {}),
    ...(set.targetRpe != null ? { rpe: set.targetRpe } : {}),
    side: set.side,
  }))
}

async function previewPlanDay(
  day: TrainingPlanDay,
  policy: TrainingPlanPolicy,
  block: (PeriodizationBlock & { index: number; cycle: number }) | null,
  planId: string,
): Promise<PlanTargetPreview[]> {
  const template = await getTemplateForEditor(day.templateId)
  const rows = template?.exercises ?? []
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.exerciseId)
  const historyRows = (
    await db.execute(sql`
      SELECT we.exercise_id, w.id AS workout_id, w.started_at::text AS started_at,
        ws.set_number, ws.weight::float8 AS weight, ws.weight_unit, ws.reps,
        ws.duration_s, ws.side, ps.plan_id, ps.block_index, ps.block_occurrence,
        ps.block_load_multiplier::float8 AS block_load_multiplier
      FROM workout_exercises we
      JOIN workouts w ON w.id = we.workout_id AND w.status = 'completed'
      JOIN workout_sets ws ON ws.workout_exercise_id = we.id
        AND ws.completed = true AND ws.set_type <> 'warmup'
      LEFT JOIN training_plan_sessions ps ON ps.workout_id = w.id
      WHERE we.exercise_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        AND w.id IN (
          SELECT w2.id FROM workouts w2
          JOIN workout_exercises we2 ON we2.workout_id = w2.id
          WHERE w2.status = 'completed' AND we2.exercise_id = we.exercise_id
          ORDER BY w2.started_at DESC LIMIT 8
        )
      ORDER BY we.exercise_id, w.started_at, ws.set_number
    `)
  ).rows as unknown as HistoryRow[]
  const blockOccurrence = resolveBlockOccurrence(policy.blocks, block, policy.repeatBlocks)
  const histories = historyByExercise(
    historyRows,
    planId,
    block?.index ?? null,
    blockOccurrence,
  )

  return rows.map((row) => {
    // Editor weights are already converted to its declared display unit. Never
    // relabel that numeric value with exercise.preferredUnit (20kg→44lb→44kg).
    const exactUnit: Unit = row.targetWeightUnit === 'kg' ? 'kg' : 'lb'
    const history = histories.get(row.exerciseId) ?? []
    const exact = templateTargets(row)
    const isWarmupOnly = row.section === 'warmup' || row.sets.every((set) => set.setType === 'warmup')
    const selectedPolicy =
      row.progression != null
        ? row.progression
        : policy.applyToUnconfiguredExercises && !isWarmupOnly && row.tracks === 'weight_reps'
          ? (block?.progression ?? policy.progression)
          : null
    const parsedSelected = selectedPolicy == null ? null : parsePolicy(selectedPolicy)
    const evaluationPolicy =
      parsedSelected?.type === 'double_progression' && block?.repRange
        ? { ...parsedSelected, repRange: block.repRange }
        : selectedPolicy
    const evaluated = selectedPolicy == null
      ? null
      : evaluateProgression(evaluationPolicy, history, exactUnit)
    const unit = evaluated && evaluated.sets.length > 0
      ? dominantUnit(history, exactUnit)
      : exactUnit
    const progressed = evaluated && evaluated.sets.length > 0
      ? evaluated.sets.map((target, index) => ({
          ...target,
          ...(exact[index]?.rpe != null ? { rpe: exact[index].rpe } : {}),
          side: target.side ?? exact[index]?.side ?? null,
        }))
      : parsedSelected
        ? seedManagedTargets(exact, parsedSelected)
        : exact
    const targets =
      policy.autoAdjustTargets && selectedPolicy != null
        ? applyBlockOverlay(progressed, block, exact.length || progressed.length)
        : exact
    return {
      exerciseId: row.exerciseId,
      exerciseName: row.name,
      unit,
      managed: policy.autoAdjustTargets && selectedPolicy != null,
      ruleText: evaluated?.ruleText ?? 'Follow the exact saved set prescription.',
      decision:
        policy.autoAdjustTargets && selectedPolicy != null
          ? explainPlanDecision(history.at(-1) ?? [], targets, unit, block)
          : 'Preview only — this plan will keep the exact saved set prescription.',
      targets,
    }
  })
}

/** Overlay a plan's working targets onto a just-started template prescription.
 * Warm-ups and set-level metadata survive; working-set count is allowed to grow
 * or shrink, which is what makes volume blocks real rather than display-only. */
export function mergePlanPrescription(
  base: SetPrescriptionInput[],
  targets: PlanTargetSet[],
  unit: Unit,
): SetPrescriptionInput[] {
  if (targets.length === 0) return base.map((set, index) => ({ ...set, setNumber: index + 1 }))
  const warmups = base.filter((set) => set.setType === 'warmup').map((set) => ({ ...set }))
  const working = base.filter((set) => set.setType !== 'warmup')
  const fallback: SetPrescriptionInput = {
    setNumber: 1,
    setType: 'normal',
    weightUnit: unit,
    source: 'progression',
  }
  const adjusted = targets.map((target, index): SetPrescriptionInput => {
    const current = working[index % Math.max(working.length, 1)] ?? fallback
    return {
      ...current,
      setNumber: 0,
      setType: current.setType ?? 'normal',
      weight: target.weight ?? current.weight ?? null,
      weightUnit: target.weight != null ? unit : (current.weightUnit ?? unit),
      reps: target.reps ?? current.reps ?? null,
      durationS: target.durationS ?? current.durationS ?? null,
      rpe: target.rpe ?? current.rpe ?? null,
      side: target.side ?? current.side ?? null,
      source: 'progression',
    }
  })
  return [...warmups, ...adjusted].map((set, index) => ({ ...set, setNumber: index + 1 }))
}

interface StartedPrescriptionRow {
  workout_exercise_id: string
  exercise_id: string
  position: number
  set_number: number | null
  set_type: string | null
  prescribed_weight: string | null
  prescribed_weight_unit: string | null
  prescribed_reps: number | null
  prescribed_distance_m: string | null
  prescribed_duration_s: number | null
  prescribed_rpe: string | null
  rest_seconds: number | null
  prescription_source: string | null
  side: string | null
}

function nullableNumber(value: string | null): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function storedSetType(value: string | null): 'warmup' | 'drop' | 'failure' | 'normal' {
  return value === 'warmup' || value === 'drop' || value === 'failure' ? value : 'normal'
}

function storedSide(value: string | null): 'left' | 'right' | null {
  return value === 'left' || value === 'right' ? value : null
}

function storedSource(value: string | null): SetPrescriptionInput['source'] {
  return value === 'template' || value === 'repeat' || value === 'proposal'
    ? value
    : 'progression'
}

async function applyPlanTargetsToWorkout(
  workoutId: string,
  previews: PlanTargetPreview[],
): Promise<void> {
  if (previews.length === 0) return
  const rows = (
    await db.execute(sql`
      SELECT we.id AS workout_exercise_id, we.exercise_id, we.position,
        ws.set_number, ws.set_type,
        ws.prescribed_weight::text AS prescribed_weight,
        ws.prescribed_weight_unit, ws.prescribed_reps,
        ws.prescribed_distance_m::text AS prescribed_distance_m,
        ws.prescribed_duration_s, ws.prescribed_rpe::text AS prescribed_rpe,
        ws.rest_seconds, ws.prescription_source, ws.side
      FROM workout_exercises we
      LEFT JOIN workout_sets ws ON ws.workout_exercise_id = we.id AND ws.completed = false
      WHERE we.workout_id = ${workoutId}
      ORDER BY we.position, ws.set_number, ws.created_at
    `)
  ).rows as unknown as StartedPrescriptionRow[]

  const grouped = new Map<string, StartedPrescriptionRow[]>()
  for (const row of rows) {
    const group = grouped.get(row.workout_exercise_id)
    if (group) group.push(row)
    else grouped.set(row.workout_exercise_id, [row])
  }
  const unused = [...previews]
  for (const group of grouped.values()) {
    const head = group[0]!
    const previewIndex = unused.findIndex((preview) => preview.exerciseId === head.exercise_id)
    if (previewIndex < 0) continue
    const [preview] = unused.splice(previewIndex, 1)
    if (!preview || !preview.managed) continue
    await db.execute(sql`
      UPDATE workout_exercises
      SET prescription_rule = ${preview.ruleText}
      WHERE id = ${head.workout_exercise_id} AND workout_id = ${workoutId}
    `)
    const base = group
      .filter((row) => row.set_number != null)
      .map((row): SetPrescriptionInput => ({
        setNumber: row.set_number!,
        setType: storedSetType(row.set_type),
        weight: nullableNumber(row.prescribed_weight),
        weightUnit: row.prescribed_weight_unit === 'kg' ? 'kg' : 'lb',
        reps: row.prescribed_reps,
        distanceM: nullableNumber(row.prescribed_distance_m),
        durationS: row.prescribed_duration_s,
        rpe: nullableNumber(row.prescribed_rpe),
        restSeconds: row.rest_seconds,
        side: storedSide(row.side),
        source: storedSource(row.prescription_source),
      }))
    await materializeSetPrescriptions(
      (query) => db.execute(query),
      head.workout_exercise_id,
      mergePlanPrescription(base, preview.targets, preview.unit),
    )
  }
}

interface StartedProgrammingRow extends StartedPrescriptionRow {
  exercise_name: string
  primary_muscle: string | null
  secondary_muscles: unknown
  force: string | null
  mechanic: string | null
  superset_group: number | null
  exercise_rest_seconds: number | null
  section: string | null
}

interface PlanProgrammingExercise extends ProgrammableExercise {
  workoutExerciseId: string
}

function secondaryMuscles(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Apply a plan's programming defaults to the just-created active shell. Exact
 * set values/rest survive as overrides; missing ramps/order/pair semantics are
 * materialized before the logger is returned to the user. */
export async function applyPlanProgrammingToWorkout(
  workoutId: string,
  policy: WorkoutProgrammingPolicy,
): Promise<void> {
  const rows = (
    await db.execute(sql`
      SELECT we.id AS workout_exercise_id, we.exercise_id, we.position,
        e.name AS exercise_name, e.primary_muscle, e.secondary_muscles,
        e.force, e.mechanic,
        we.superset_group, we.rest_seconds AS exercise_rest_seconds, we.section,
        ws.set_number, ws.set_type,
        ws.prescribed_weight::text AS prescribed_weight,
        ws.prescribed_weight_unit, ws.prescribed_reps,
        ws.prescribed_distance_m::text AS prescribed_distance_m,
        ws.prescribed_duration_s, ws.prescribed_rpe::text AS prescribed_rpe,
        ws.rest_seconds, ws.prescription_source, ws.side
      FROM workout_exercises we
      JOIN exercises e ON e.id = we.exercise_id
      LEFT JOIN workout_sets ws ON ws.workout_exercise_id = we.id AND ws.completed = false
      WHERE we.workout_id = ${workoutId}
      ORDER BY we.position, ws.set_number, ws.created_at
    `)
  ).rows as unknown as StartedProgrammingRow[]
  if (rows.length === 0) return

  const grouped = new Map<string, StartedProgrammingRow[]>()
  for (const row of rows) {
    const group = grouped.get(row.workout_exercise_id)
    if (group) group.push(row)
    else grouped.set(row.workout_exercise_id, [row])
  }
  const metadata = new Map<string, ProgrammingMetadata>()
  const exercises: PlanProgrammingExercise[] = []
  for (const [workoutExerciseId, group] of grouped) {
    const head = group[0]!
    const secondary = secondaryMuscles(head.secondary_muscles)
    const region = musclesForExerciseEnriched(
      head.exercise_name,
      head.primary_muscle,
      secondary,
    ).find((hit) => hit.weight === 1)?.region ?? null
    metadata.set(head.exercise_id, {
      region,
      pattern: movementPattern({
        name: head.exercise_name,
        primaryMuscle: head.primary_muscle,
        secondaryMuscles: secondary,
        force: head.force,
        mechanic: head.mechanic,
      }),
    })
    const prescriptions = group
      .filter((row) => row.set_number != null)
      .map((row) => ({
        setType: storedSetType(row.set_type),
        targetWeight: nullableNumber(row.prescribed_weight),
        reps: row.prescribed_reps,
        targetDurationS: row.prescribed_duration_s,
        targetRpe: nullableNumber(row.prescribed_rpe),
        restSeconds: row.rest_seconds,
        side: storedSide(row.side),
      }))
    const working = prescriptions.filter((set) => set.setType !== 'warmup')
    exercises.push({
      workoutExerciseId,
      exerciseId: head.exercise_id,
      name: head.exercise_name,
      sets: Math.max(1, working.length),
      reps: working.find((set) => set.reps != null)?.reps ?? null,
      targetWeight: working.find((set) => set.targetWeight != null)?.targetWeight ?? null,
      supersetGroup: head.superset_group,
      restSeconds: head.exercise_rest_seconds,
      region,
      section:
        head.section === 'warmup' || head.section === 'cooldown'
          ? head.section
          : 'main',
      targetDurationS: working.find((set) => set.targetDurationS != null)?.targetDurationS ?? null,
      setPrescriptions: prescriptions,
    })
  }
  let history
  try {
    history = await readProgrammingHistory()
  } catch {
    history = undefined
  }
  const programmed = programWorkout(exercises, {
    metadata,
    history,
    policy,
    preserveExplicitRest: true,
    redistributeWorkingSets: false,
  })

  // Avoid transient duplicate positions under the dense slot constraint.
  await db.execute(sql`
    UPDATE workout_exercises SET position = position + 1000
    WHERE workout_id = ${workoutId}
  `)
  for (let position = 0; position < programmed.length; position += 1) {
    const exercise = programmed[position]!
    await db.execute(sql`
      UPDATE workout_exercises
      SET position = ${position}, superset_group = ${exercise.supersetGroup},
        rest_seconds = ${exercise.restSeconds}
      WHERE id = ${exercise.workoutExerciseId} AND workout_id = ${workoutId}
    `)
    const sourceRows = grouped.get(exercise.workoutExerciseId) ?? []
    const sourceWarmups = sourceRows.filter((row) => row.set_type === 'warmup')
    const sourceWorking = sourceRows.filter((row) => row.set_type !== 'warmup')
    let warmupIndex = 0
    let workingIndex = 0
    const fallbackUnit = sourceWorking[0]?.prescribed_weight_unit === 'kg' ? 'kg' : 'lb'
    const prescriptions = (exercise.setPrescriptions ?? []).map((set, index): SetPrescriptionInput => {
      const source = set.setType === 'warmup'
        ? sourceWarmups[warmupIndex++]
        : sourceWorking[workingIndex++]
      return {
        setNumber: index + 1,
        setType: set.setType,
        weight: set.targetWeight,
        weightUnit: source?.prescribed_weight_unit === 'kg' ? 'kg' : fallbackUnit,
        reps: set.reps,
        distanceM: nullableNumber(source?.prescribed_distance_m ?? null),
        durationS: set.targetDurationS,
        rpe: set.targetRpe,
        restSeconds: set.restSeconds,
        side: set.side,
        source: storedSource(source?.prescription_source ?? null),
      }
    })
    await materializeSetPrescriptions(
      (query) => db.execute(query),
      exercise.workoutExerciseId,
      prescriptions,
    )
  }
}

export interface StartTrainingPlanResult {
  workout?: ActiveWorkout
  conflictActiveWorkoutId?: string
  planDay?: TrainingPlanDay
  block?: (PeriodizationBlock & { index: number; cycle: number }) | null
}

export async function startTrainingPlanDay(
  planId: string,
  requestedDayId?: string,
): Promise<StartTrainingPlanResult> {
  await ensureGymSchema()
  const plan = await getTrainingPlan(planId, true)
  if (!plan) throw new TrainingPlanNotFoundError('Training plan not found')
  if (plan.status !== 'active') throw new TrainingPlanValidationError('Resume the plan before starting it')
  const day = requestedDayId
    ? plan.days.find((candidate) => candidate.id === requestedDayId)
    : plan.nextDay
  if (!day) throw new TrainingPlanValidationError('Plan has no startable day')
  if (!day.available) {
    throw new TrainingPlanValidationError(
      `Restore or replace the archived “${day.templateName}” template before starting this day`,
    )
  }
  const result = await startWorkout('template', day.templateId)
  if (result.conflictActiveWorkoutId) return { conflictActiveWorkoutId: result.conflictActiveWorkoutId }
  if (!result.workout) throw new Error('Workout start returned no workout')
  try {
    const previews = day.id === plan.nextDay?.id
      ? (plan.nextTargets ?? [])
      : await previewPlanDay(day, plan.policy, plan.currentBlock, plan.id)
    await applyPlanTargetsToWorkout(result.workout.id, previews)
    await applyPlanProgrammingToWorkout(result.workout.id, plan.policy.programming)
    const blockOccurrence = resolveBlockOccurrence(
      plan.policy.blocks,
      plan.currentBlock,
      plan.policy.repeatBlocks,
    )
    await db.execute(sql`
      INSERT INTO training_plan_sessions (
        plan_id, plan_day_id, day_name, template_id,
        plan_version, workout_id, sequence_index, block_index,
        block_occurrence, block_load_multiplier
      )
      VALUES (
        ${plan.id}, ${day.id}, ${day.name}, ${day.templateId},
        ${plan.version}, ${result.workout.id},
        (SELECT COALESCE(max(sequence_index), -1) + 1 FROM training_plan_sessions WHERE plan_id = ${plan.id}),
        ${plan.currentBlock?.index ?? null}, ${blockOccurrence},
        ${plan.currentBlock?.loadMultiplier ?? null}
      )
    `)
    const workout = await getActiveWorkoutById(result.workout.id)
    if (!workout) throw new Error('Started plan workout could not be reloaded')
    return { workout, planDay: day, block: plan.currentBlock }
  } catch (error) {
    // Starting a plan is all-or-nothing from the user's perspective. If target
    // materialization or provenance fails, remove the still-active shell so it
    // cannot strand the logger behind a phantom workout.
    try {
      await db.execute(sql`DELETE FROM workouts WHERE id = ${result.workout.id} AND status = 'active'`)
    } catch {
      // Preserve the original failure; the singleton guard still prevents a
      // second active workout and diagnostics can surface the cleanup failure.
    }
    throw error
  }
}
