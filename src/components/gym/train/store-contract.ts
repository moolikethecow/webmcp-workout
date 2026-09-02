/**
 * Train-tab type seam (GYM_PLAN §2.4, §4). A2 owns the optimistic store + its
 * types; this file simply RE-EXPORTS A2's real contract so the Train-tab surfaces
 * import their types from one place. (It began as a standalone mirror while A2 was
 * in flight; now that A2's `active-workout-store` + `active-types` have landed, it
 * re-exports the real shapes verbatim — no drift possible.)
 */
export type {
  ActiveSet,
  PreviousSet,
  TargetSet,
  ActiveExercise,
  ActiveWorkout,
  FinishSummary,
  SyncState,
} from '@/lib/gym-client/active-types'

export type { ActiveWorkoutStore } from '@/lib/gym-client/active-workout-store'

export type { PrKind, WorkoutPr } from '@/lib/gym/finish'
export type { DiffVerdict } from '@/lib/gym/template-diff'

/** Where a start came from (mirrors lib/gym/active-workout.ts StartFrom). */
export type StartFrom = 'template' | 'empty' | 'repeat_last'
