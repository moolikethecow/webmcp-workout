import { agentFetch } from '../fetch'
import type { WebMcpTool } from '../types'
import { failFrom, ok } from './shared'

export const getMuscleReadiness: WebMcpTool = {
  name: 'get_muscle_readiness',
  description:
    'Per-muscle-region readiness, freshest first: status (fresh, ready, recovering, undertrained, ' +
    'untrained), days since the region was last worked, and its weighted working sets over the last ' +
    'seven days. Use it to choose what to train and to justify a choice. This is a TRAINING-HISTORY ' +
    'signal derived from logged sets only — it is not a recovery score, not a physiological ' +
    'measurement, and no wearable data enters it. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  async execute() {
    const result = await agentFetch('/api/gym/agent/readiness')
    if (!result.ok) return failFrom(result, 'Could not compute readiness')
    return ok(result.json)
  },
}
