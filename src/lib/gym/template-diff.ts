/**
 * Template diff (GYM_PLAN §4 "Template-update prompt") — PURE + tested.
 *
 * After a workout that came from a template, the finish flow asks whether the
 * template should absorb what actually happened. This module classifies the delta
 * (unchanged / values_changed / structure_changed) and builds the update payload.
 *
 *   - STRUCTURE changed = the exercise set / order / superset grouping differs
 *     (an exercise added, removed, reordered, or re-grouped).
 *   - VALUES changed    = same structure, but the completed working-set count or
 *     the target reps/weight differ from the template's targets.
 *   - unchanged         = neither.
 *
 * `applyTemplateUpdate` (the write side) lives in the route/lib layer; this file
 * owns the deterministic classification + the new template-exercise rows to write,
 * preserving each surviving exercise's progression policy by exercise_id.
 */

import { convertWeight, type WeightUnit } from '@/lib/units/weight'
import { logicalSetKey } from './load-semantics'

export type DiffVerdict = 'unchanged' | 'values_changed' | 'structure_changed'

/** One template exercise as stored (the "before"). */
export interface TemplateExerciseShape {
  exerciseId: string
  position: number
  supersetGroup: number | null
  targetSets: number | null
  targetReps: number | null
  targetWeight: number | null
  targetWeightUnit: WeightUnit
  /** Opaque progression policy JSON — preserved across a values-only update. */
  progression?: unknown
}

/** One exercise as it was actually logged in the workout (the "after"). */
export interface WorkoutExerciseShape {
  exerciseId: string
  position: number
  supersetGroup: number | null
  /** Working (non-warmup) rows visible in the finished session, with untouched
   * rows projected from their saved prescription. */
  workingSets: Array<{
    reps: number | null
    weight: number | null
    weightUnit: WeightUnit
    /** Split L/R physical rows share this stable logical-round id. Legacy/test
     * callers may omit it; those rows intentionally remain distinct. */
    logicalSetId?: string | null
  }>
}

/** Full set prescription used to detect changes that the legacy scalar summary
 * (set count / modal reps / top weight) cannot see. */
export interface ExactTemplateSetShape {
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

export interface ExactTemplateExerciseShape {
  exerciseId: string
  position: number
  sets: ExactTemplateSetShape[]
}

export interface TemplateDiff {
  verdict: DiffVerdict
  /** True when the diff is applicable (came from a template, not an empty start). */
  canUpdate: boolean
}

/** Structure key for one exercise slot: (exerciseId, position, group). */
function structureKey(e: { exerciseId: string; position: number; supersetGroup: number | null }): string {
  return `${e.exerciseId}@${e.position}#${e.supersetGroup ?? 'none'}`
}

interface ExerciseSlotIdentity {
  exerciseId: string
  position: number
}

/** Match target slots to source slots without collapsing duplicate exercise ids.
 * Occurrence order within each exercise id is the stable identity: the first A in
 * the target matches the first A in the source, the second matches the second, and
 * so on. Absolute positions cannot be trusted after another exercise is reordered
 * across repeated occurrences. */
export function matchExerciseSlots<Source extends ExerciseSlotIdentity>(
  targets: ExerciseSlotIdentity[],
  sources: Source[],
): Array<Source | undefined> {
  const sourcesByExercise = new Map<string, Source[]>()
  for (const source of [...sources].sort((a, b) => a.position - b.position)) {
    const group = sourcesByExercise.get(source.exerciseId)
    if (group) group.push(source)
    else sourcesByExercise.set(source.exerciseId, [source])
  }

  const ordinalByTargetIndex = new Map<number, number>()
  const seen = new Map<string, number>()
  for (const { target, index } of targets
    .map((target, index) => ({ target, index }))
    .sort((a, b) => a.target.position - b.target.position)) {
    const ordinal = seen.get(target.exerciseId) ?? 0
    ordinalByTargetIndex.set(index, ordinal)
    seen.set(target.exerciseId, ordinal + 1)
  }

  return targets.map((target, index) =>
    sourcesByExercise.get(target.exerciseId)?.[ordinalByTargetIndex.get(index) ?? 0],
  )
}

/** True when the two lists describe the same ordered/grouped exercise skeleton. */
function sameStructure(
  template: TemplateExerciseShape[],
  workout: WorkoutExerciseShape[],
): boolean {
  if (template.length !== workout.length) return false
  const t = [...template].sort((a, b) => a.position - b.position).map(structureKey)
  const w = [...workout].sort((a, b) => a.position - b.position).map(structureKey)
  return t.every((k, i) => k === w[i])
}

/** The dominant (modal) rep count across a workout exercise's working sets. */
function modalReps(sets: WorkoutExerciseShape['workingSets']): number | null {
  const counts = new Map<number, number>()
  for (const s of sets) {
    if (s.reps == null) continue
    counts.set(s.reps, (counts.get(s.reps) ?? 0) + 1)
  }
  let best: number | null = null
  let bestN = 0
  for (const [reps, n] of counts) {
    if (n > bestN) {
      best = reps
      bestN = n
    }
  }
  return best
}

/** The top (heaviest) working-set weight. */
function topWeight(sets: WorkoutExerciseShape['workingSets']): number | null {
  let top: number | null = null
  for (const s of sets) {
    const weightLb = canonicalLb(s.weight, s.weightUnit)
    if (weightLb != null && (top == null || weightLb > top)) top = weightLb
  }
  return top
}

/** Scalar template set counts describe user-visible rounds, not physical side
 * rows. Missing ids fall back to one round per row so legacy callers keep their
 * previous behavior rather than being guessed together. */
function logicalWorkingSetCount(sets: WorkoutExerciseShape['workingSets']): number {
  return new Set(
    sets.map((set, index) => logicalSetKey(set.logicalSetId, index)),
  ).size
}

/** Normalize a stored template target at the comparison/write boundary. */
function targetWeightLb(target: Pick<TemplateExerciseShape, 'targetWeight' | 'targetWeightUnit'>): number | null {
  return canonicalLb(target.targetWeight, target.targetWeightUnit)
}

function canonicalLb(value: number | null, unit: WeightUnit): number | null {
  const pounds = convertWeight(value, unit, 'lb')
  return pounds == null ? null : Math.round(pounds * 100) / 100
}

function sameNullableNumber(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a === b
  return Math.round(a * 1000) === Math.round(b * 1000)
}

function sameExactSet(a: ExactTemplateSetShape, b: ExactTemplateSetShape): boolean {
  return (
    a.setNumber === b.setNumber &&
    a.setType === b.setType &&
    sameNullableNumber(
      canonicalLb(a.targetWeight, a.targetWeightUnit),
      canonicalLb(b.targetWeight, b.targetWeightUnit),
    ) &&
    a.targetReps === b.targetReps &&
    sameNullableNumber(a.targetDistanceM, b.targetDistanceM) &&
    a.targetDurationS === b.targetDurationS &&
    sameNullableNumber(a.targetRpe, b.targetRpe) &&
    a.restSeconds === b.restSeconds &&
    a.side === b.side
  )
}

/** Compare the ordered, per-set prescription instead of only the scalar summary.
 * This catches heterogeneous reps, set type/order, timed/distance targets, RPE,
 * side, and per-set rest changes even when modal reps and top weight are unchanged. */
export function sameExactSetPrescription(
  template: ExactTemplateExerciseShape[],
  workout: ExactTemplateExerciseShape[],
): boolean {
  const before = [...template].sort((a, b) => a.position - b.position)
  const after = [...workout].sort((a, b) => a.position - b.position)
  if (before.length !== after.length) return false

  return before.every((exercise, index) => {
    const logged = after[index]
    if (!logged || exercise.exerciseId !== logged.exerciseId || exercise.position !== logged.position) {
      return false
    }
    const expectedSets = [...exercise.sets].sort((a, b) => a.setNumber - b.setNumber)
    const loggedSets = [...logged.sets].sort((a, b) => a.setNumber - b.setNumber)
    return (
      expectedSets.length === loggedSets.length &&
      expectedSets.every((set, setIndex) => {
        const loggedSet = loggedSets[setIndex]
        return loggedSet != null && sameExactSet(set, loggedSet)
      })
    )
  })
}

/**
 * Classify the delta between a template and the workout that ran it. When the
 * workout didn't come from a template (`fromTemplate=false`) the verdict is
 * unchanged + canUpdate:false (nothing to update against).
 */
export function diffWorkoutVsTemplate(
  template: TemplateExerciseShape[],
  workout: WorkoutExerciseShape[],
  fromTemplate: boolean,
): TemplateDiff {
  if (!fromTemplate) return { verdict: 'unchanged', canUpdate: false }

  if (!sameStructure(template, workout)) {
    return { verdict: 'structure_changed', canUpdate: true }
  }

  // Same structure → compare values per slot (matched by position).
  const byPos = new Map<number, WorkoutExerciseShape>()
  for (const w of workout) byPos.set(w.position, w)

  for (const t of template) {
    const w = byPos.get(t.position)
    if (!w) return { verdict: 'structure_changed', canUpdate: true } // defensive
    const completed = logicalWorkingSetCount(w.workingSets)
    if (t.targetSets != null && completed !== t.targetSets) {
      return { verdict: 'values_changed', canUpdate: true }
    }
    const reps = modalReps(w.workingSets)
    if (t.targetReps != null && reps != null && reps !== t.targetReps) {
      return { verdict: 'values_changed', canUpdate: true }
    }
    const weight = topWeight(w.workingSets)
    const targetWeight = targetWeightLb(t)
    if (targetWeight != null && weight != null && weight !== targetWeight) {
      return { verdict: 'values_changed', canUpdate: true }
    }
  }

  return { verdict: 'unchanged', canUpdate: true }
}

export type UpdateMode = 'structure' | 'values' | 'both'

/** A template-exercise row to WRITE when applying an update (replace-all). */
export interface TemplateExerciseUpdate {
  exerciseId: string
  position: number
  supersetGroup: number | null
  targetSets: number | null
  targetReps: number | null
  targetWeight: number | null
  targetWeightUnit: 'lb'
  /** Carried over from the matching pre-update exercise occurrence. */
  progression: unknown
}

/**
 * Build the new template_exercises rows for an update. Replace-all semantics: the
 * caller wipes the template's exercises and inserts these in a transaction.
 *
 *   - mode 'values'    → keep the template's structure (exercise ids/order/group)
 *     but refresh each slot's targets from what was logged.
 *   - mode 'structure' → adopt the workout's exercise set/order/group, keeping
 *     targets from the matching old slot where the exercise survived (else the
 *     logged values seed them).
 *   - mode 'both'      → adopt the workout's structure AND its logged values.
 *
 * Progression policies are preserved by matched exercise slot: a surviving
 * occurrence keeps its policy; a newly-added one gets null (last_time default).
 */
export function buildTemplateUpdate(
  template: TemplateExerciseShape[],
  workout: WorkoutExerciseShape[],
  mode: UpdateMode,
): TemplateExerciseUpdate[] {
  // The exercise skeleton we write: workout's for structure/both, template's for values.
  const skeleton =
    mode === 'values'
      ? template.map((t) => ({
          exerciseId: t.exerciseId,
          position: t.position,
          supersetGroup: t.supersetGroup,
        }))
      : [...workout]
          .sort((a, b) => a.position - b.position)
          .map((w) => ({
            exerciseId: w.exerciseId,
            position: w.position,
            supersetGroup: w.supersetGroup,
          }))

  const oldMatches = matchExerciseSlots(skeleton, template)
  const loggedMatches = matchExerciseSlots(skeleton, workout)

  return skeleton.map((slot, index) => {
    const logged = loggedMatches[index]
    const old = oldMatches[index]
    // Structure-only keeps old targets for surviving slots, but a newly-added
    // exercise has no old values to preserve and must seed from the workout.
    const takeLoggedValues = mode === 'values' || mode === 'both' || old == null

    const targetSets = takeLoggedValues && logged
      ? logicalWorkingSetCount(logged.workingSets)
      : old?.targetSets ?? null
    const targetReps =
      takeLoggedValues && logged ? modalReps(logged.workingSets) : old?.targetReps ?? null
    const targetWeight =
      takeLoggedValues && logged ? topWeight(logged.workingSets) : old ? targetWeightLb(old) : null

    return {
      exerciseId: slot.exerciseId,
      position: slot.position,
      supersetGroup: slot.supersetGroup,
      targetSets,
      targetReps,
      targetWeight,
      targetWeightUnit: 'lb',
      progression: old?.progression ?? null,
    }
  })
}
