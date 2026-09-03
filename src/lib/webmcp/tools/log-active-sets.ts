import { agentFetch } from '../fetch'
import type { WebMcpTool } from '../types'
import { afterMutation, fail, failFrom, num, ok, str } from './shared'

type Track = 'weight_reps' | 'weighted_bodyweight' | 'assisted_bodyweight' | 'reps' | 'time' | 'distance_time'

interface ActiveSetRow {
  clientSetId: string
  logicalSetId?: string
  setNumber: number
  setType?: string
  weight: number | null
  weightUnit?: 'lb' | 'kg'
  reps: number | null
  distanceM: number | null
  durationS: number | null
  rpe: number | null
  restSeconds: number | null
  side?: 'left' | 'right' | null
  completed: boolean
}

interface ActiveExerciseRow {
  workoutExerciseId: string
  name: string
  tracks: Track
  sets: ActiveSetRow[]
}

interface ActiveWorkoutRow {
  id: string
  revision: number
  weightUnit?: 'lb' | 'kg'
  exercises: ActiveExerciseRow[]
}

const SET_LOG = {
  type: 'object',
  properties: {
    exercise_name: { type: 'string', description: 'Exact exercise name from get_active_workout.' },
    set_number: { type: 'integer', description: '1-based set number from get_active_workout.' },
    side: { type: 'string', enum: ['left', 'right'], description: 'Required only when that set has separate left/right rows.' },
    weight: { type: 'number', description: 'Actual load used. Required for weighted and timed sets.' },
    weight_unit: { type: 'string', enum: ['lb', 'kg'], description: 'Unit for weight; defaults to the workout unit.' },
    reps: { type: 'integer', description: 'Actual repetitions. Required for rep-based sets.' },
    duration_seconds: { type: 'number', description: 'Actual duration in seconds. Required for timed sets.' },
    distance_m: { type: 'number', description: 'Actual distance in metres. Required for distance-and-time sets.' },
    rpe: { type: 'number', description: 'Optional actual RPE.' },
  },
  required: ['exercise_name', 'set_number'],
  additionalProperties: false,
} as const

function finiteEntryNumber(entry: Record<string, unknown>, key: string): number | undefined {
  const value = entry[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function requiredValue(entry: Record<string, unknown>, key: string, label: string): number | string {
  const value = finiteEntryNumber(entry, key)
  if (value === undefined) throw new Error(`${label} is required.`)
  return value
}

function activeWorkout(value: Record<string, unknown>): ActiveWorkoutRow | null {
  if (value.active === null) return null
  if (typeof value.id !== 'string' || !Number.isInteger(value.revision) || !Array.isArray(value.exercises)) return null
  return value as unknown as ActiveWorkoutRow
}

/**
 * Logs performance explicitly. Unlike the logger UI's one-tap convenience,
 * this agent surface never copies a previous value or a prescription: an agent
 * must receive the values the person actually performed before it can record a
 * completed set.
 */
export const logActiveSets: WebMcpTool = {
  name: 'log_active_sets',
  description:
    'Record completed sets in the workout currently being performed. Call get_active_workout immediately ' +
    'before this and pass its revision. Supply the actual result for every set: weight and reps for ' +
    'weighted work, reps for bodyweight work, duration for timed work, and distance plus duration for ' +
    'distance work. This tool never guesses from a target or a previous session. It refuses already ' +
    'completed sets; use edit_active_workout with apply_to_completed only for an explicit correction.',
  inputSchema: {
    type: 'object',
    properties: {
      expected_revision: {
        type: 'integer',
        description: 'Revision returned by the most recent get_active_workout call.',
      },
      sets: { type: 'array', items: SET_LOG, description: 'The actual completed sets to record.' },
    },
    required: ['expected_revision', 'sets'],
    additionalProperties: false,
  },
  async execute(args) {
    const expectedRevision = num(args, 'expected_revision')
    if (expectedRevision === undefined || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return fail('expected_revision must be the non-negative integer from get_active_workout.')
    }
    const requested = Array.isArray(args.sets) ? args.sets : []
    if (requested.length === 0 || requested.some((entry) => !entry || typeof entry !== 'object')) {
      return fail('sets must contain at least one set result.')
    }

    const current = await agentFetch('/api/gym/workouts/active')
    if (!current.ok) return failFrom(current, 'Could not load the active workout')
    const workout = activeWorkout(current.json)
    if (!workout) return fail('No workout is currently in progress.')
    if (workout.revision !== expectedRevision) {
      return fail('The workout changed since get_active_workout. Read it again and retry with its current revision.')
    }

    const writes: Array<Record<string, unknown>> = []
    const touched = new Set<string>()
    const writtenIds = new Set<string>()

    try {
      for (const raw of requested) {
        const entry = raw as Record<string, unknown>
        const exerciseName = str(entry, 'exercise_name')
        const setNumber = num(entry, 'set_number')
        if (!exerciseName || setNumber === undefined || !Number.isInteger(setNumber) || setNumber < 1) {
          throw new Error('Every set needs an exact exercise_name and a positive integer set_number.')
        }
        const exercise = workout.exercises.find((candidate) => candidate.name.toLowerCase() === exerciseName.toLowerCase())
        if (!exercise) throw new Error(`No active exercise matches "${exerciseName}".`)

        const requestedSide = str(entry, 'side')
        if (requestedSide && requestedSide !== 'left' && requestedSide !== 'right') {
          throw new Error(`side for ${exercise.name} must be "left" or "right".`)
        }
        const matches = exercise.sets.filter(
          (set) => set.setNumber === setNumber && (requestedSide ? set.side === requestedSide : true),
        )
        if (matches.length === 0) throw new Error(`${exercise.name} has no matching set ${setNumber}.`)
        if (matches.length > 1) throw new Error(`${exercise.name} set ${setNumber} has separate sides; include side.`)
        const set = matches[0]!
        if (set.completed) throw new Error(`${exercise.name} set ${setNumber} is already completed.`)
        if (writtenIds.has(set.clientSetId)) throw new Error(`${exercise.name} set ${setNumber} was supplied more than once.`)
        writtenIds.add(set.clientSetId)

        const weight = finiteEntryNumber(entry, 'weight')
        const reps = finiteEntryNumber(entry, 'reps')
        const durationS = finiteEntryNumber(entry, 'duration_seconds')
        const distanceM = finiteEntryNumber(entry, 'distance_m')
        const rpe = finiteEntryNumber(entry, 'rpe')

        if (exercise.tracks === 'weight_reps' || exercise.tracks === 'weighted_bodyweight' || exercise.tracks === 'assisted_bodyweight') {
          requiredValue(entry, 'weight', `${exercise.name} set ${setNumber} weight`)
          requiredValue(entry, 'reps', `${exercise.name} set ${setNumber} reps`)
        } else if (exercise.tracks === 'reps') {
          requiredValue(entry, 'reps', `${exercise.name} set ${setNumber} reps`)
        } else if (exercise.tracks === 'time') {
          requiredValue(entry, 'duration_seconds', `${exercise.name} set ${setNumber} duration_seconds`)
        } else if (exercise.tracks === 'distance_time') {
          requiredValue(entry, 'distance_m', `${exercise.name} set ${setNumber} distance_m`)
          requiredValue(entry, 'duration_seconds', `${exercise.name} set ${setNumber} duration_seconds`)
        }

        const requestedUnit = str(entry, 'weight_unit')
        if (requestedUnit && requestedUnit !== 'lb' && requestedUnit !== 'kg') {
          throw new Error(`weight_unit for ${exercise.name} must be "lb" or "kg".`)
        }
        writes.push({
          clientSetId: set.clientSetId,
          logicalSetId: set.logicalSetId,
          workoutExerciseId: exercise.workoutExerciseId,
          setNumber: set.setNumber,
          setType: set.setType ?? 'normal',
          weight: weight ?? set.weight ?? (exercise.tracks === 'time' ? 0 : null),
          weightUnit: requestedUnit ?? set.weightUnit ?? workout.weightUnit ?? 'lb',
          reps: reps ?? set.reps,
          distanceM: distanceM ?? set.distanceM,
          durationS: durationS ?? set.durationS,
          rpe: rpe ?? set.rpe,
          restSeconds: set.restSeconds,
          side: set.side ?? null,
          completed: true,
        })
        touched.add(exercise.name)
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'Could not validate the set results.')
    }

    const result = await agentFetch(`/api/gym/workouts/${encodeURIComponent(workout.id)}/sets`, {
      method: 'PUT',
      body: JSON.stringify({ sets: writes, deleteClientSetIds: [], expectedRevision }),
    })
    if (!result.ok) return failFrom(result, 'Could not record the completed sets')
    afterMutation(
      'log_active_sets',
      `Logged ${writes.length} completed set${writes.length === 1 ? '' : 's'} for ${[...touched].join(', ')}.`,
      [...touched],
    )
    return ok(result.json)
  },
}
