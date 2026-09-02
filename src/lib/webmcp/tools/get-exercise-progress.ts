import { agentFetch, query } from '../fetch'
import type { WebMcpTool } from '../types'
import { fail, failFrom, ok, str } from './shared'

export const getExerciseProgress: WebMcpTool = {
  name: 'get_exercise_progress',
  description:
    'Everything known about one movement: personal records, the last eight sessions summarised by ' +
    'working volume, best set and top estimated 1RM, the per-day trend series, and the explicit ' +
    'progression rule that applies plus the target it produces for the next session. Use it before ' +
    'suggesting a load, and to answer "how am I doing on X". Progression is deterministic arithmetic ' +
    'over logged sets, not an opinion — quote the rule rather than inventing one. If the name does not ' +
    'resolve, the response lists close matches; retry with one of those. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      exercise: {
        type: 'string',
        description: 'Exercise name. Use search_exercises if you are unsure of the exact catalog name.',
      },
    },
    required: ['exercise'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async execute(args) {
    const exercise = str(args, 'exercise')
    if (!exercise) return fail('exercise is required.')
    const result = await agentFetch('/api/gym/agent/progress' + query({ exercise }))
    if (!result.ok) return failFrom(result, `Could not load progress for "${exercise}"`)
    return ok(result.json)
  },
}
