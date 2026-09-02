import { agentFetch, query } from '../fetch'
import type { WebMcpTool } from '../types'
import { failFrom, num, ok, str } from './shared'

/**
 * Substitution starts here, always. The tool pins `eligible=1` so a movement
 * excluded by a live training constraint is never even offered — the agent
 * cannot route around the gate by choosing not to pass a flag.
 */
export const searchExercises: WebMcpTool = {
  name: 'search_exercises',
  description:
    'Search the exercise catalog. Results are filtered to what the current training constraints allow, ' +
    'so anything returned here is safe to add or substitute. Use this BEFORE proposing any exercise by ' +
    'name — names must match the catalog exactly for edit_active_workout to accept them. `excluded_count` ' +
    'reports how many otherwise-matching movements were withheld by an active constraint. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Free-text search over name, primary muscle and equipment.' },
      muscle: {
        type: 'string',
        description: 'Canonical muscle region to filter by, e.g. chest, lats, quads, hamstrings.',
      },
      equipment: {
        type: 'string',
        description: 'Equipment class, e.g. barbell, dumbbell, machine, cable, body only, bands.',
      },
      limit: { type: 'integer', description: 'Maximum rows to return (default 50, max 200).' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async execute(args) {
    const path =
      '/api/gym/exercises' +
      query({
        q: str(args, 'q'),
        muscle: str(args, 'muscle'),
        equipment: str(args, 'equipment'),
        limit: num(args, 'limit'),
        // Always on: eligibility is not the caller's choice.
        eligible: '1',
      })
    const result = await agentFetch(path)
    if (!result.ok) return failFrom(result, 'Could not search exercises')
    return ok(result.json)
  },
}
