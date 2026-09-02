import { agentFetch } from '../fetch'
import type { WebMcpTool } from '../types'
import { ALL_EXERCISES } from '../agent-events'
import { afterMutation, fail, failFrom, ok, str } from './shared'

/**
 * The moment a plan becomes a session. Everything after this point is
 * performance, so the tool is deliberately explicit about where the session
 * comes from, and it surfaces the 409 (a workout is already running) as text
 * rather than silently starting a second one.
 */
export const startWorkout: WebMcpTool = {
  name: 'start_workout',
  description:
    "Start a session. from \"draft\" begins today's draft; \"template\" begins a saved template; " +
    '"repeat_last" repeats the previous session; "empty" starts a blank one to fill in. From here on, ' +
    'the workout is live and edits go through edit_active_workout. If a workout is already in progress ' +
    'this refuses and tells you so — read it with get_active_workout rather than starting another. ' +
    'Confirm with the person before starting; a started session is what the logger records against.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', enum: ['draft', 'template', 'repeat_last', 'empty'] },
      templateId: { type: 'string', description: 'from "template": which template.' },
      proposalId: { type: 'string', description: 'from "draft": which draft. Defaults to today\'s.' },
      workoutId: { type: 'string', description: 'Optional: repeat a specific past session by id.' },
    },
    required: ['from'],
    additionalProperties: false,
  },
  async execute(args) {
    const from = str(args, 'from')
    if (!from) return fail('from is required.')

    if (from === 'draft') {
      let proposalId = str(args, 'proposalId')
      if (!proposalId) {
        const current = await agentFetch('/api/gym/plan')
        const proposal = current.json.proposal as { id?: string } | null | undefined
        if (!current.ok || !proposal?.id) {
          return fail('There is no draft to start. Build one with draft_workout first.')
        }
        proposalId = proposal.id
      }
      const result = await agentFetch('/api/gym/plan', {
        method: 'POST',
        body: JSON.stringify({ action: 'start', proposalId }),
      })
      if (!result.ok) return failFrom(result, 'Could not start the draft')
      afterMutation('start_workout', 'Started the workout draft.', [ALL_EXERCISES])
      return ok(result.json)
    }

    const body = {
      from: from === 'repeat_last' && str(args, 'workoutId') ? 'workout' : from,
      ...(str(args, 'templateId') ? { templateId: str(args, 'templateId') } : {}),
      ...(str(args, 'workoutId') ? { workoutId: str(args, 'workoutId') } : {}),
    }
    const result = await agentFetch('/api/gym/workouts', { method: 'POST', body: JSON.stringify(body) })
    if (!result.ok) return failFrom(result, 'Could not start the workout')
    afterMutation('start_workout', 'Started a workout.', [ALL_EXERCISES])
    return ok(result.json)
  },
}
