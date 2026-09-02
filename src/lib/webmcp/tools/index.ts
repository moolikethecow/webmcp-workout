/**
 * The twelve tools, and which pages offer them.
 *
 * Registration is per page on purpose. A tool list is a prompt: offering
 * `edit_active_workout` on the history page would invite an agent to try it
 * where it makes no sense. The gym page gets everything that acts on the
 * session in front of you; the dashboard gets the planning set; history gets
 * reads only.
 */
import type { WebMcpTool } from '../types'

import { draftWorkout } from './draft-workout'
import { editActiveWorkout } from './edit-active-workout'
import { editWorkoutDraft } from './edit-workout-draft'
import { getActiveWorkout } from './get-active-workout'
import { getExerciseProgress } from './get-exercise-progress'
import { getMuscleReadiness } from './get-muscle-readiness'
import { getTrainingContext } from './get-training-context'
import { getWorkoutHistory } from './get-workout-history'
import { searchExercises } from './search-exercises'
import { startWorkout } from './start-workout'
import { getTrainingConstraints, setTrainingConstraint } from './training-constraints'

export type GymPage = 'gym' | 'dashboard' | 'history'

/** Available everywhere: orientation, reads, and constraint management. */
const EVERYWHERE: WebMcpTool[] = [
  getTrainingContext,
  getActiveWorkout,
  searchExercises,
  getMuscleReadiness,
  getTrainingConstraints,
  setTrainingConstraint,
  getExerciseProgress,
  getWorkoutHistory,
]

/** Planning: build a draft, shape it, commit to it. */
const PLANNING: WebMcpTool[] = [draftWorkout, startWorkout]

export const ALL_TOOLS: WebMcpTool[] = [...EVERYWHERE, ...PLANNING, editActiveWorkout, editWorkoutDraft]

export function toolsForPage(page: GymPage): WebMcpTool[] {
  switch (page) {
    case 'gym':
      // The session in front of you: everything.
      return [...EVERYWHERE, ...PLANNING, editActiveWorkout, editWorkoutDraft]
    case 'dashboard':
      // Planning happens here; live editing does not.
      return [...EVERYWHERE, ...PLANNING]
    case 'history':
      return EVERYWHERE
    default:
      return EVERYWHERE
  }
}

export {
  draftWorkout,
  editActiveWorkout,
  editWorkoutDraft,
  getActiveWorkout,
  getExerciseProgress,
  getMuscleReadiness,
  getTrainingConstraints,
  getTrainingContext,
  getWorkoutHistory,
  searchExercises,
  setTrainingConstraint,
  startWorkout,
}
