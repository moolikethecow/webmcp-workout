import { displayExerciseName } from './display-name'

export type ProposalSetType = 'warmup' | 'normal' | 'drop' | 'failure'

/** One exact proposal set in array order. Weights stay canonical lb; nullable
 * targets let the same row model represent bodyweight, timed, and unilateral
 * work without inventing sentinel values. */
export interface ProposalSetPrescription {
  setType: ProposalSetType
  targetWeight: number | null
  reps: number | null
  targetDurationS: number | null
  targetRpe: number | null
  restSeconds: number | null
  side: 'left' | 'right' | null
}

interface ProposalExerciseSetShape {
  sets: number
  reps: number | null
  targetWeight: number | null
  targetDurationS?: number | null
  restSeconds: number | null
  section?: 'warmup' | 'main' | 'cooldown'
  setPrescriptions?: ProposalSetPrescription[]
}

/** Resolve the proposal's ordered set rows. New proposals can carry an exact
 * heterogeneous prescription; legacy scalar payloads retain their prior
 * materialization semantics (including warm-up-only exercise sections). */
export function resolveProposalSetPrescriptions(
  exercise: ProposalExerciseSetShape,
): ProposalSetPrescription[] {
  if (exercise.setPrescriptions?.length) {
    return exercise.setPrescriptions.map((set) => ({ ...set }))
  }

  return Array.from(
    { length: Math.max(1, Math.min(12, Math.round(exercise.sets))) },
    () => ({
      setType: exercise.section === 'warmup' ? 'warmup' : 'normal',
      targetWeight: exercise.targetWeight,
      reps: exercise.reps,
      targetDurationS: exercise.targetDurationS ?? null,
      targetRpe: null,
      restSeconds: exercise.restSeconds,
      side: null,
    }),
  )
}

/** Stored animation-catalog names may be lowercase. Normalize a read/display
 * copy without mutating the persisted payload or exercise matching ids. */
export function normalizeProposalExerciseNames<T extends { name: string }>(
  payload: { name: string; exercises: T[] },
): { name: string; exercises: T[] } {
  return {
    ...payload,
    exercises: payload.exercises.map((exercise) => ({
      ...exercise,
      name: displayExerciseName(exercise.name),
    })),
  }
}
