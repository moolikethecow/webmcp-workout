import { agentFetch } from '../fetch'
import type { WebMcpTool } from '../types'
import { afterMutation, failFrom, ok, str } from './shared'

export const draftWorkout: WebMcpTool = {
  name: 'draft_workout',
  description:
    "Builds a deterministic starting draft from readiness, constraints and equipment. The adaptive " +
    'planner is not part of this repo. The draft is a proposal, not a session — nothing is logged until ' +
    'start_workout. mode "draft" deals a fresh one; "tune" anchors to a saved template — including the ' +
    "day an active plan says is next, which is what you should stage rather than dealing a fresh " +
    'rotation over the top of a running programme (get_training_plan returns that templateId); "shuffle" ' +
    'rotates the exercises of an existing draft. Follow it with edit_workout_draft to adjust, and tell ' +
    'the person what the draft actually contains rather than describing it in the abstract.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['draft', 'tune', 'shuffle'],
        description: 'Default "draft".',
      },
      focus: {
        type: 'string',
        description: 'Optional emphasis, e.g. "push", "legs", "upper". Constraints still override it.',
      },
      templateId: { type: 'string', description: 'tune: the template to anchor the draft to.' },
      proposalId: { type: 'string', description: 'shuffle: the draft to rotate.' },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const body = {
      mode: str(args, 'mode') ?? 'draft',
      ...(str(args, 'focus') ? { focus: str(args, 'focus') } : {}),
      ...(str(args, 'templateId') ? { templateId: str(args, 'templateId') } : {}),
      ...(str(args, 'proposalId') ? { proposalId: str(args, 'proposalId') } : {}),
    }
    const result = await agentFetch('/api/gym/plan', { method: 'POST', body: JSON.stringify(body) })
    if (!result.ok) return failFrom(result, 'Could not build a draft')
    afterMutation('draft_workout', 'Built a workout draft.')
    return ok(result.json)
  },
}
