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
    'Start a session. from "plan" begins the active training plan\'s NEXT day — the right choice ' +
    'whenever a plan is running, because the plan decides the order (check get_training_plan first). ' +
    "from \"draft\" begins today's draft; \"template\" begins a saved template; " +
    '"repeat_last" repeats the previous session; "empty" starts a blank one to fill in. From here on, ' +
    'the workout is live and edits go through edit_active_workout. If a workout is already in progress ' +
    'this refuses and tells you so — read it with get_active_workout rather than starting another. ' +
    'Confirm with the person before starting; a started session is what the logger records against.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', enum: ['plan', 'draft', 'template', 'repeat_last', 'empty'] },
      dayId: {
        type: 'string',
        description:
          'from "plan": start a specific day instead of the plan\'s next one. Omit to take the next day, which is almost always what is wanted.',
      },
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

    if (from === 'plan') {
      const plans = await agentFetch('/api/gym/plans')
      if (!plans.ok) return failFrom(plans, 'Could not load the training plan')
      const rows = Array.isArray(plans.json.plans)
        ? (plans.json.plans as Array<{ id: string; name: string; status: string; nextDay?: { name?: string } | null }>)
        : []
      const active = rows.find((plan) => plan.status === 'active')
      if (!active) {
        return fail(
          'No training plan is active, so there is no "next day" to start. Use draft_workout to build today, or start from a template.',
        )
      }

      const dayId = str(args, 'dayId')
      const result = await agentFetch(`/api/gym/plans/${encodeURIComponent(active.id)}/start`, {
        method: 'POST',
        body: JSON.stringify(dayId ? { dayId } : {}),
      })
      // The route answers a already-running session with 409 + the id rather
      // than starting a second one. Say which, so the agent reads that workout
      // instead of retrying into the same wall.
      if (result.status === 409) {
        return fail(
          'A workout is already in progress — read it with get_active_workout rather than starting another.',
        )
      }
      if (!result.ok) return failFrom(result, `Could not start the next day of ${active.name}`)
      const started = active.nextDay?.name ?? 'the next day'
      afterMutation('start_workout', `Started ${started} from ${active.name}.`, [ALL_EXERCISES])
      return ok(result.json)
    }

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
