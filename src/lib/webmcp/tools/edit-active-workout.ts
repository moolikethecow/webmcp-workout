import { agentFetch } from '../fetch'
import type { WebMcpTool } from '../types'
import { afterMutation, failFrom, ok } from './shared'

const WARMUP_SET = {
  type: 'object',
  properties: {
    weight: { type: 'number', description: 'Exact warm-up load.' },
    weight_unit: { type: 'string', enum: ['lb', 'kg'] },
    reps: { type: 'integer', description: 'Exact warm-up reps.' },
    duration_s: { type: 'integer', description: 'Exact warm-up hold in seconds.' },
    rpe: { type: 'number' },
    rest_seconds: { type: 'integer', description: 'Rest after this exact warm-up set.' },
    side: { type: 'string', enum: ['left', 'right'] },
  },
  additionalProperties: false,
} as const

const OP = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [
        'add_exercise',
        'remove_exercise',
        'replace_exercise',
        'reorder',
        'set_scheme',
        'set_weight',
        'set_warmup_sets',
        'set_rest',
        'set_superset',
        'clear_superset',
        'set_notes',
        'rename',
        'restore_template_weights',
      ],
      description: 'Which change to make.',
    },
    exercise_name: {
      type: 'string',
      description: 'The exercise in the CURRENT workout this op acts on (case-insensitive).',
    },
    replacement_exercise_name: {
      type: 'string',
      description: 'replace_exercise: the movement to swap in. Must satisfy current constraints and equipment.',
    },
    exercise_names: {
      type: 'array',
      items: { type: 'string' },
      description: 'set_superset: every current exercise to put in one group (at least two).',
    },
    to: { type: 'string', enum: ['top', 'bottom'], description: 'reorder: destination shortcut.' },
    to_position: { type: 'integer', description: 'add_exercise/reorder: 1-based destination slot.' },
    sets: { type: 'integer', description: 'set_scheme: absolute WORKING-set count. Warm-ups are excluded and preserved.' },
    reps: { type: 'integer', description: 'set_scheme: reps for incomplete working sets.' },
    sets_delta: { type: 'integer', description: 'set_scheme: relative working-set change, e.g. -1.' },
    weight: { type: 'number', description: 'set_weight: load for the target set(s).' },
    weight_unit: { type: 'string', enum: ['lb', 'kg'] },
    warmup_sets: {
      type: 'array',
      items: WARMUP_SET,
      description:
        'set_warmup_sets: the exact ordered warm-up ramp. Pass [] to clear incomplete warm-ups. Completed warm-ups must be repeated unchanged.',
    },
    set_number: { type: 'integer', description: 'set_weight/set_rest: 1-based set. Omit to apply to all incomplete working sets.' },
    apply_to_completed: {
      type: 'boolean',
      description:
        'Default false. True ONLY when explicitly correcting data that was already logged — it rewrites performed values.',
    },
    rest_seconds: { type: 'integer', description: 'set_rest: rest after each set of this exercise.' },
    notes: { type: 'string', description: "set_notes: this session's cue for the exercise. Empty clears it." },
    workout_name: { type: 'string', description: 'rename: the new session name.' },
  },
  required: ['op'],
  additionalProperties: false,
} as const

/**
 * The one mutating tool for the live session. Everything about it is designed
 * around the fact that a person is standing in a gym with the app open while
 * the agent writes.
 */
export const editActiveWorkout: WebMcpTool = {
  name: 'edit_active_workout',
  description:
    'Modify the workout currently being performed. Reads canonical live state before mutation; pass ' +
    '`expected_revision` from get_active_workout. Completed sets are preserved unless explicitly ' +
    'correcting logged data. Exercise additions and replacements must satisfy current equipment and ' +
    'training constraints; use search_exercises first. Ops apply in order and each is accepted or ' +
    'rejected on its own — the response lists both. A stale_revision answer means someone logged a set ' +
    'while you were thinking: re-read with get_active_workout and retry. Not for finished sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      expected_revision: {
        type: 'integer',
        description: 'The `revision` from your most recent get_active_workout. Always pass it.',
      },
      ops: { type: 'array', items: OP, description: 'Ordered edits to apply.' },
    },
    required: ['ops'],
    additionalProperties: false,
  },
  async execute(args) {
    const result = await agentFetch('/api/gym/workouts/active/edit', {
      method: 'POST',
      body: JSON.stringify(args),
    })
    if (!result.ok) return failFrom(result, 'Could not edit the active workout')
    const applied = Array.isArray(result.json.applied) ? (result.json.applied as Array<{ change?: string }>) : []
    if (applied.length > 0) {
      afterMutation(
        'edit_active_workout',
        applied.map((entry) => entry.change ?? '').filter(Boolean).join(' '),
      )
    }
    return ok(result.json)
  },
}
