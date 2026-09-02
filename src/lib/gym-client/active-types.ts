/**
 * Client-side type contract for the active-workout logger (GYM_PLAN §2.4, §4,
 * P2a). The server read/write model is `lib/gym/active-workout.ts` — these types
 * re-export the server shapes the store consumes verbatim (so the seam can never
 * drift) plus the store-only overlay/queue types the write-queue owns.
 *
 * A2 owns this file + active-workout-store.tsx + write-queue.ts. A3 (Train tab +
 * finish sheet) consumes the store API — it imports the ActiveWorkout shape from
 * here, never re-declares it.
 */

import type {
  ActiveExercise as ServerActiveExercise,
  ActiveSet as ServerActiveSet,
  ActiveWorkout as ServerActiveWorkout,
  PreviousSet as ServerPreviousSet,
  TargetSetOut as ServerTargetSet,
} from '@/lib/gym/active-workout'
import type { DisplayFinishSummary as ServerFinishSummary } from '@/lib/gym/finish'

// ── server shapes (verbatim; the store's single source of truth for the UI) ──
export type ActiveSet = ServerActiveSet
export type PreviousSet = ServerPreviousSet
export type TargetSet = ServerTargetSet
export type ActiveExercise = ServerActiveExercise
export type ActiveWorkout = ServerActiveWorkout
export type FinishSummary = ServerFinishSummary

/** The six measurement shapes (mirrors ExerciseTracks in types.ts / §3a). */
export type Tracks =
  | 'weight_reps'
  | 'weighted_bodyweight'
  | 'assisted_bodyweight'
  | 'reps'
  | 'time'
  | 'distance_time'

export type Unit = 'lb' | 'kg'
export type SetType = 'warmup' | 'normal' | 'drop' | 'failure'
export type StrengthSideMode = 'both' | 'split' | 'left' | 'right'

/** The editable numeric fields of a set (what the numeric pad + ghost-commit write). */
export type SetField = 'weight' | 'reps' | 'durationS' | 'distanceM' | 'rpe'

/** The sync-pill states (§2.4): queue empty / N queued / network retry / stale
 * optimistic generation awaiting a canonical rebase. */
export type SyncState = 'saved' | 'pending' | 'offline' | 'conflict'

// ── write-queue payload shapes (match PUT /api/gym/workouts/:id/sets) ─────────

/** One set in a PUT /sets body — mirrors the route's RawSet / SetUpsertInput. */
export interface SetUpsertPayload {
  clientSetId: string
  /** Present on every new write; optional only for a pre-deploy queue mirror. */
  logicalSetId?: string
  workoutExerciseId: string
  setNumber: number
  setType?: SetType
  weight?: number | null
  weightUnit?: Unit
  reps?: number | null
  distanceM?: number | null
  durationS?: number | null
  rpe?: number | null
  /** Rest after this exact set; null inherits the warmup/working fallback. */
  restSeconds?: number | null
  /** Per-side hold marker (§10b.2): 'left' | 'right' | null. */
  side?: 'left' | 'right' | null
  completed?: boolean
}

/** The full PUT /sets request body. */
export interface SetsPutBody {
  sets: SetUpsertPayload[]
  deleteClientSetIds: string[]
  expectedRevision: number
}

/** The PUT /sets response — canonical sets for every touched exercise. */
export interface SetsPutResponse {
  byExercise: Record<string, ActiveSet[]>
  revision: number
}

/**
 * The localStorage mirror (§2.4): ONLY the unflushed queue + the optimistic
 * set-values overlay, scoped to a workout id. The DB is the workout source of
 * truth — this is a crash-recovery mirror of in-flight edits, never the workout.
 */
export interface QueueMirror {
  workoutId: string
  /** Generation the pending payload was last based on. Optional so mirrors
   * written by the pre-revision client remain recoverable after deploy. */
  revision?: number
  /** Per-exercise current set arrays that have pending (un-acked) edits. */
  dirtyByExercise: Record<string, SetUpsertPayload[]>
  /** Canonical rows each pending array was edited from. New mirrors always
   * include this; absence identifies a pre-revision rollout mirror. */
  baseByExercise?: Record<string, SetUpsertPayload[]>
  /** Movement identity for each workout-exercise key, so a conflict rebase can
   * never attach old movement performance to an agent replacement. */
  exerciseIdByExercise?: Record<string, string>
  /** clientSetIds queued for deletion. */
  deletes: string[]
}

/** localStorage key for the mirror (single active workout at a time). */
export const QUEUE_MIRROR_KEY = 'gym-queue-v1'
