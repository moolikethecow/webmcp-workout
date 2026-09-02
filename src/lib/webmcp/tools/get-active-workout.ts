import { agentFetch } from '../fetch'
import type { WebMcpTool } from '../types'
import { failFrom, ok } from './shared'

/**
 * The canonical read of the live session. Every mutation of the live workout
 * begins here, because `revision` is what makes concurrent human + agent
 * editing safe.
 */
export const getActiveWorkout: WebMcpTool = {
  name: 'get_active_workout',
  description:
    'Read the workout currently being performed, exactly as the app has it: exercises in order, ' +
    'warm-up and working sets, which sets are already completed, prescribed targets, rest, superset ' +
    'groups, and the `revision`. Call this immediately before any edit and pass the `revision` you get ' +
    'back as `expected_revision`. Returns { active: null } when no workout is in progress. ' +
    'Never infer completed sets from conversation — this is the only source of truth for what has ' +
    'actually been performed. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  async execute() {
    const result = await agentFetch('/api/gym/workouts/active')
    if (!result.ok) return failFrom(result, 'Could not load the active workout')
    return ok(result.json)
  },
}
