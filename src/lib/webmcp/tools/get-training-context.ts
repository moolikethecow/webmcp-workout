import { agentFetch } from '../fetch'
import type { WebMcpTool } from '../types'
import { failFrom, ok } from './shared'

/**
 * Orientation. Cheap, read-only, and it carries the operating rules — an agent
 * that calls this first will not have to guess at any of the invariants the
 * other tools enforce.
 */
export const getTrainingContext: WebMcpTool = {
  name: 'get_training_context',
  description:
    'Start here. Returns what this app can do, the few facts that decide what to call next ' +
    '(whether a workout is in progress and its revision, whether a draft is waiting, units, how many ' +
    'training constraints are active, available gym equipment), and the operating rules for editing ' +
    "someone's training. Call it once at the start of a conversation about training, and again after " +
    'anything that could have changed state. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  async execute() {
    const result = await agentFetch('/api/gym/agent/context')
    if (!result.ok) return failFrom(result, 'Could not load the training context')
    return ok(result.json)
  },
}
