import { agentFetch, query } from '../fetch'
import type { WebMcpTool } from '../types'
import { failFrom, num, ok, str } from './shared'

/**
 * Substitution starts here, always. The tool pins `eligible=1` so a movement
 * this person cannot do is never even offered — the agent cannot route around
 * the gate by choosing not to pass a flag.
 *
 * Two gates hide behind that one flag, and the description names both, because
 * an agent that knows only about constraints will explain an absent barbell
 * bench press by blaming a shoulder when the real answer is that the gym has no
 * barbell.
 */
export const searchExercises: WebMcpTool = {
  name: 'search_exercises',
  description:
    'Search the exercise catalog. Results are filtered twice — to what the active gym can equip, and to ' +
    'what the current training constraints allow — so anything returned here is safe to add or ' +
    'substitute. Use this BEFORE proposing any exercise by name; names must match the catalog exactly ' +
    'for edit_active_workout to accept them. `excluded_count` is how many otherwise-matching movements ' +
    'were withheld, and `excluded_by_equipment` how many of those were the gym rather than the body — ' +
    'if a movement someone asked for is missing, that pair says which to tell them. Counts describe the ' +
    '`sampled` rows examined, not the whole `catalog_total`. Use list_gyms or switch_gym when the ' +
    'equipment is the problem. Read-only.',
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
      modality: {
        type: 'string',
        description: "Filter by movement type: 'strength' (default for programming), 'stretch', 'dynamic', 'cardio'. Pass 'strength' to keep stretches and mobility drills out of a working set search.",
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
        modality: str(args, 'modality'),
        limit: num(args, 'limit'),
        // Always on: eligibility is not the caller's choice.
        eligible: '1',
      })
    const result = await agentFetch(path)
    if (!result.ok) return failFrom(result, 'Could not search exercises')
    return ok(result.json)
  },
}
