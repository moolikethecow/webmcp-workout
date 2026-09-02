import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_PULSE_MS,
  ALL_EXERCISES,
  agentTouchedRecently,
  recordAgentEvent,
  useAgentEventStore,
} from '../agent-events'
import { changedExerciseNames } from '../tools/edit-active-workout'

beforeEach(() => {
  vi.useFakeTimers()
  useAgentEventStore.getState().clear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('agentTouchedRecently', () => {
  it('is true inside the pulse window and false after it', () => {
    recordAgentEvent('edit_active_workout', 'Replaced Chest Fly with Cable Press.', ['Chest Fly'])
    expect(agentTouchedRecently('Chest Fly')).toBe(true)

    vi.advanceTimersByTime(AGENT_PULSE_MS - 1)
    expect(agentTouchedRecently('Chest Fly')).toBe(true)

    vi.advanceTimersByTime(2)
    expect(agentTouchedRecently('Chest Fly')).toBe(false)
  })

  it('matches case-insensitively and ignores untouched exercises', () => {
    recordAgentEvent('edit_active_workout', 'Removed Leg Press.', ['Leg Press'])
    expect(agentTouchedRecently('leg press')).toBe(true)
    expect(agentTouchedRecently('Bench Press')).toBe(false)
  })

  it('a started session touches every exercise', () => {
    recordAgentEvent('start_workout', 'Started a workout.', [ALL_EXERCISES])
    expect(agentTouchedRecently('Anything At All')).toBe(true)
  })
})

describe('changedExerciseNames', () => {
  it('keeps only the names an applied change actually mentions', () => {
    const args = {
      ops: [
        { op: 'replace_exercise', exercise_name: 'Chest Fly', replacement_exercise_name: 'Cable Press' },
        { op: 'remove_exercise', exercise_name: 'Leg Press' },
      ],
    }
    const applied = [{ change: 'Replaced Chest Fly with Cable Press.' }]

    expect(changedExerciseNames(args, applied)).toEqual(['Chest Fly', 'Cable Press'])
  })

  it('returns nothing when no op applied', () => {
    expect(changedExerciseNames({ ops: [{ op: 'remove_exercise', exercise_name: 'Squat' }] }, [])).toEqual([])
  })
})
