/**
 * Routine-playlist builder (GYM_PLAN §10b.6, M3) — the PURE core of the routine
 * player. Turns an active workout's exercises into the ordered list of timed
 * holds the full-screen player steps through: exercises in position order, sets
 * in setNumber order, only incomplete `tracks==='time'` sets with a clientSetId
 * (a set the store can't address can't be auto-completed).
 *
 * No React, no store instance, no network — unit-tested in isolation. The one
 * import from the store module is `committedValue`, the same ghost-resolution a
 * ✓ tap uses, so a hold counts down exactly what completing it will log.
 */
import type { ActiveExercise } from '@/lib/gym-client/active-types'
import { committedValue } from '@/lib/gym-client/active-workout-store'

/** Seconds between holds — the get-into-position window (§10b.6). */
export const TRANSITION_SECONDS = 5

/** Hold length when nothing resolves (no entered value, no ghost). */
export const FALLBACK_HOLD_SECONDS = 30

/** One playable hold in the routine. */
export interface PlaylistStep {
  workoutExerciseId: string
  clientSetId: string
  exerciseName: string
  /** Seconds this hold counts down: committedValue('durationS') else 30. */
  durationS: number
  side: 'left' | 'right' | null
  /** 1-based position among THIS exercise's playable holds ("hold i of n"). */
  indexInExercise: number
  totalInExercise: number
}

/**
 * Build the routine playlist from the active workout's exercises. Exercises are
 * ordered by `position`, sets by `setNumber`; completed sets, non-timed
 * exercises, and sets without a clientSetId are excluded.
 */
export function buildPlaylist(exercises: ActiveExercise[]): PlaylistStep[] {
  const ordered = [...exercises].sort((a, b) => a.position - b.position)
  const steps: PlaylistStep[] = []
  for (const ex of ordered) {
    if (ex.tracks !== 'time') continue
    const playable = ex.sets
      .filter((s) => !s.completed && s.clientSetId != null)
      .sort((a, b) => a.setNumber - b.setNumber)
    playable.forEach((set, i) => {
      steps.push({
        workoutExerciseId: ex.workoutExerciseId,
        clientSetId: set.clientSetId!, // non-null — filtered above
        exerciseName: ex.name,
        durationS: committedValue(ex, set, 'durationS') ?? FALLBACK_HOLD_SECONDS,
        side: set.side,
        indexInExercise: i + 1,
        totalInExercise: playable.length,
      })
    })
  }
  return steps
}

/**
 * Whether the active workout qualifies for the routine player (§10b.6): at
 * least one exercise, EVERY exercise is timed, and at least one playable
 * (incomplete, addressable) hold remains.
 */
export function isTimedRoutine(exercises: ActiveExercise[]): boolean {
  if (exercises.length === 0) return false
  if (!exercises.every((ex) => ex.tracks === 'time')) return false
  return exercises.some((ex) =>
    ex.sets.some((s) => !s.completed && s.clientSetId != null),
  )
}
