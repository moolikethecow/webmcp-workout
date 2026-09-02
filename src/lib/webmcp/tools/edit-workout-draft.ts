import { agentFetch } from '../fetch'
import type { WebMcpTool } from '../types'
import { afterMutation, failFrom, ok } from './shared'

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
        'set_rest',
        'set_superset',
        'clear_superset',
        'rename',
      ],
    },
    exercise_name: { type: 'string', description: 'The draft exercise this op acts on.' },
    replacement_exercise_name: { type: 'string', description: 'replace_exercise: the movement to swap in.' },
    exercise_names: {
      type: 'array',
      items: { type: 'string' },
      description: 'set_superset: at least two draft exercises to group.',
    },
    to: { type: 'string', enum: ['top', 'bottom'] },
    to_position: { type: 'integer', description: '1-based destination slot.' },
    sets: { type: 'integer', description: 'Working sets for this slot.' },
    reps: { type: 'integer' },
    weight: { type: 'number', description: 'Target load for the slot.' },
    rest_seconds: { type: 'integer' },
    workout_name: { type: 'string', description: 'rename: the draft name.' },
  },
  required: ['op'],
  additionalProperties: false,
} as const

export const editWorkoutDraft: WebMcpTool = {
  name: 'edit_workout_draft',
  description:
    "Adjust today's workout draft before it is started — add, remove, swap, reorder, change sets/reps, " +
    'target load, rest, or supersets. Additions and replacements go through the same eligibility gate ' +
    'as the live editor, so a movement excluded by a training constraint is refused here too; use ' +
    'search_exercises to find a legal alternative. This edits the PLAN. Once a session has started, use ' +
    'edit_active_workout instead — that is the one that touches performance.',
  inputSchema: {
    type: 'object',
    properties: { ops: { type: 'array', items: OP, description: 'Ordered edits to apply to the draft.' } },
    required: ['ops'],
    additionalProperties: false,
  },
  async execute(args) {
    const result = await agentFetch('/api/gym/agent/draft/edit', {
      method: 'POST',
      body: JSON.stringify(args),
    })
    if (!result.ok) return failFrom(result, 'Could not edit the draft')
    const applied = Array.isArray(result.json.applied) ? (result.json.applied as Array<{ change?: string }>) : []
    if (applied.length > 0) {
      afterMutation(
        'edit_workout_draft',
        applied.map((entry) => entry.change ?? '').filter(Boolean).join(' '),
      )
    }
    return ok(result.json)
  },
}
