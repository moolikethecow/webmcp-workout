/**
 * Catalog metadata inference for a freshly created custom exercise.
 *
 * The inference pipeline is not part of this repo; a new custom exercise is
 * created as a plain row and the user fills in the details from the exercise
 * sheet.
 */
export interface ExerciseFill {
  category: string | null
  equipment: string | null
  primaryMuscle: string | null
  secondaryMuscles: string[]
  tracks: string
  modality: string
  perSide: boolean
  instructions: string[]
  defaultRestSeconds: number
}

/** Infer catalog metadata from an exercise name. Null = nothing inferred. */
export async function fillExerciseMetadata(_name: string): Promise<ExerciseFill | null> {
  return null
}
