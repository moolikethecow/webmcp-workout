import { agentFetch } from '../fetch'
import type { WebMcpTool } from '../types'
import { afterMutation, bool, fail, failFrom, num, ok, str } from './shared'

/**
 * Constraints are the hardest limit in the product: they gate what the drafting
 * engine deals, what the live editor accepts, and what search returns. Reading
 * them is trivial; writing them is deliberately narrow, and the description
 * carries the non-medical disclaimer because that framing has to travel with
 * the tool wherever it is surfaced.
 */

export const getTrainingConstraints: WebMcpTool = {
  name: 'get_training_constraints',
  description:
    'List the training constraints currently in force — the body regions someone has said they cannot ' +
    'load right now, and how limiting each one is. These are hard limits on exercise selection, not ' +
    'preferences. Check them before proposing or substituting any movement. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      include_resolved: {
        type: 'boolean',
        description: 'Default false. True also returns constraints that have already been resolved.',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async execute(args) {
    const includeResolved = bool(args, 'include_resolved') === true
    const result = await agentFetch(`/api/gym/injuries${includeResolved ? '' : '?active=1'}`)
    if (!result.ok) return failFrom(result, 'Could not load training constraints')
    return ok(result.json)
  },
}

export const setTrainingConstraint: WebMcpTool = {
  name: 'set_training_constraint',
  description:
    'Records a user-stated training limitation so exercise eligibility can exclude conflicting ' +
    'movements. This does not diagnose an injury or prescribe rehabilitation. Use action "create" with ' +
    'a canonical region when someone says they cannot load something; "update" with an id to change its ' +
    'severity or note; "resolve" with an id when they say it is fine again. Severity: nagging (train ' +
    'around it), limiting or out (both exclude conflicting movements outright).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'resolve'] },
      id: { type: 'string', description: 'update/resolve: the constraint id from get_training_constraints.' },
      region: {
        type: 'string',
        description:
          'create: the body region. Canonical sites: shoulder_joint, elbows, wrists, hands, upper_arms, spine, ribs, hips, pelvis, groin, thighs, lower_legs, feet, head, neck, knees, ankles, plus the muscle regions traps, delts, chest, biceps, forearms, abs, obliques, quads, calves, lats, mid_back, lower_back, triceps, glutes, hamstrings. Common words are accepted and mapped (shoulder → shoulder_joint, knee → knees, back → lower_back, hamstring → hamstrings, …).',
      },
      severity: {
        type: 'string',
        enum: ['nagging', 'limiting', 'out'],
        description:
          'nagging = noted, nothing is excluded; limiting = every movement that loads the site is excluded from search, drafts and live edits; out = the site is unusable (same exclusion). Choose limiting when the person wants to work around it today.',
      },
      label: { type: 'string', description: 'Short human label, e.g. "left shoulder".' },
      note: { type: 'string', description: "What the person actually said, in their words." },
      expires_in_days: {
        type: 'integer',
        description: 'create: register a self-expiring soft flag for this many days instead of an open-ended constraint.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(args) {
    const action = str(args, 'action')
    if (action === 'create') {
      const region = canonicalRegion(str(args, 'region'))
      if (!region) return fail('region is required to create a constraint.')
      const days = num(args, 'expires_in_days')
      const body =
        days != null && days > 0
          ? { tweak: { region, days } }
          : {
              region,
              severity: str(args, 'severity') ?? null,
              label: str(args, 'label') ?? null,
              note: str(args, 'note') ?? null,
            }
      const result = await agentFetch('/api/gym/injuries', { method: 'POST', body: JSON.stringify(body) })
      if (!result.ok) return failFrom(result, 'Could not record the training constraint')
      afterMutation('set_training_constraint', `Recorded a training constraint on ${region}.`)
      return ok(result.json)
    }

    const id = str(args, 'id')
    if (!id) {
      return fail('id is required for update and resolve.')
    }
    const body =
      action === 'resolve'
        ? { resolve: true }
        : {
            ...(str(args, 'severity') ? { severity: str(args, 'severity') } : {}),
            ...(args.label !== undefined ? { label: str(args, 'label') ?? null } : {}),
            ...(args.note !== undefined ? { note: str(args, 'note') ?? null } : {}),
          }
    const result = await agentFetch(`/api/gym/injuries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    if (!result.ok) return failFrom(result, 'Could not update the training constraint')
    afterMutation(
      'set_training_constraint',
      action === 'resolve' ? 'Resolved a training constraint.' : 'Updated a training constraint.',
    )
    return ok(result.json)
  },
}

const REGION_ALIASES: Record<string, string> = {
  shoulder: 'shoulder_joint', shoulders: 'shoulder_joint', rotator_cuff: 'shoulder_joint', 'rotator cuff': 'shoulder_joint',
  delt: 'delts', deltoid: 'delts', deltoids: 'delts',
  knee: 'knees', ankle: 'ankles', wrist: 'wrists', elbow: 'elbows', hip: 'hips', hand: 'hands', foot: 'feet',
  thigh: 'thighs', shin: 'lower_legs', shins: 'lower_legs', calf: 'calves',
  back: 'lower_back', 'lower back': 'lower_back', lumbar: 'lower_back', 'upper back': 'mid_back', 'mid back': 'mid_back',
  hamstring: 'hamstrings', quad: 'quads', quadriceps: 'quads', glute: 'glutes', bicep: 'biceps', tricep: 'triceps',
  forearm: 'forearms', pec: 'chest', pecs: 'chest', pectorals: 'chest', lat: 'lats', ab: 'abs', core: 'abs', trap: 'traps',
}

/** Accept the words people actually use and hand the API a canonical site. */
export function canonicalRegion(input: string | undefined): string | undefined {
  if (!input) return undefined
  const key = input.trim().toLowerCase().replace(/[-\s]+/g, '_')
  const spaced = input.trim().toLowerCase()
  return REGION_ALIASES[key] ?? REGION_ALIASES[spaced] ?? key
}
