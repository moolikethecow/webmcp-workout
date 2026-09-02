/**
 * Tune-for-today diff (GYM_PLAN §2.7 "applies coach adjustments to a template-
 * started workout in place"). PURE — computes the add/remove/replace ops that
 * reshape a live workout to match a tuned proposal, keyed by exerciseId.
 *
 * The apply logic is deliberately simple (§ instructions): diff the proposal's
 * exercises against the current workout's exercises BY exerciseId.
 *   - kept     : an exerciseId present in BOTH (no store op — shown for context).
 *   - added    : in the proposal but not the workout → store.addExercise.
 *   - removed  : in the workout but not the proposal → store.removeExercise.
 *
 * "replace" is intentionally NOT modeled as a paired swap here: a template tune
 * that swaps A→B reads cleanly as {removed: A, added: B}, and the store's
 * add/remove ops are the reliable primitives (replaceExercise needs a specific
 * workoutExerciseId slot; add+remove avoids guessing the pairing). The UI renders
 * removed+added rows in the diff sheet; Apply runs removes then adds.
 */
import type { ProposalPayload, ProposalExercise } from '@/lib/gym/plan'

/** The minimal current-workout shape the diff needs (a subset of ActiveWorkout). */
export interface CurrentExercise {
  workoutExerciseId: string
  exerciseId: string
  name: string
}

/** One diff row for the sheet's display. */
export interface TuneDiffRow {
  exerciseId: string
  name: string
  /** The proposal's one-line "why" (added rows only; kept/removed carry context). */
  why?: string
}

export interface TuneDiff {
  /** In the proposal AND the workout — untouched (context only). */
  kept: TuneDiffRow[]
  /** In the proposal, not the workout — will be added. */
  added: TuneDiffRow[]
  /** In the workout, not the proposal — will be removed (carries workoutExerciseId). */
  removed: Array<TuneDiffRow & { workoutExerciseId: string }>
}

/**
 * Compute the tune diff between a tuned proposal and the current live workout.
 * Pure + deterministic. Dedupes by exerciseId within each side (a workout can't
 * hold the same exerciseId twice — the add path ON CONFLICT DO NOTHINGs — so the
 * proposal side is deduped defensively too).
 */
export function computeTuneDiff(
  proposal: ProposalPayload,
  current: CurrentExercise[],
): TuneDiff {
  const proposalExercises = dedupeById(proposal.exercises)
  const currentById = new Map(current.map((c) => [c.exerciseId, c]))
  const proposalIds = new Set(proposalExercises.map((e) => e.exerciseId))

  const kept: TuneDiffRow[] = []
  const added: TuneDiffRow[] = []
  for (const ex of proposalExercises) {
    if (currentById.has(ex.exerciseId)) {
      kept.push({ exerciseId: ex.exerciseId, name: ex.name })
    } else {
      added.push({ exerciseId: ex.exerciseId, name: ex.name, why: ex.why || undefined })
    }
  }

  const removed: TuneDiff['removed'] = []
  for (const c of current) {
    if (!proposalIds.has(c.exerciseId)) {
      removed.push({ exerciseId: c.exerciseId, name: c.name, workoutExerciseId: c.workoutExerciseId })
    }
  }

  return { kept, added, removed }
}

/** True when a diff would actually change the workout (something to apply). */
export function tuneDiffHasChanges(diff: TuneDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0
}

/** Dedupe proposal exercises by exerciseId (first occurrence wins). */
function dedupeById(exercises: ProposalExercise[]): ProposalExercise[] {
  const seen = new Set<string>()
  const out: ProposalExercise[] = []
  for (const e of exercises) {
    if (seen.has(e.exerciseId)) continue
    seen.add(e.exerciseId)
    out.push(e)
  }
  return out
}
