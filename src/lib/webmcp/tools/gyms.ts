import { agentFetch } from '../fetch'
import type { WebMcpTool } from '../types'
import { afterMutation, fail, failFrom, ok, str, strArray } from './shared'

/**
 * Where you are training changes what exists.
 *
 * The eligibility gate already takes a gym's equipment into account — drafting,
 * search and live edits all run every candidate through `gymCompatible` — but
 * until now the only way to change gyms was the settings sheet, which is the
 * one surface you are not looking at while standing in an unfamiliar hotel
 * basement. These two tools put it in the agent's hands: say where you are, and
 * the catalog narrows to what is in the room.
 *
 * `switch_gym` will create the gym when you describe its equipment, because on
 * the road the gym you are standing in is one you have never recorded.
 */

export const listGyms: WebMcpTool = {
  name: 'list_gyms',
  description:
    'List the gyms on record and which one is currently active. The active gym decides what counts ' +
    'as available equipment, so every draft, substitution and exercise search is limited to it. ' +
    'Check this before assuming a movement is possible. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  async execute() {
    const result = await agentFetch('/api/gym/gyms')
    if (!result.ok) return failFrom(result, 'Could not load gyms')
    const gyms = Array.isArray(result.json.gyms) ? (result.json.gyms as GymRow[]) : []
    return ok({
      active: gyms.find((gym) => gym.isDefault)?.name ?? null,
      gyms: gyms.map((gym) => ({
        name: gym.name,
        active: gym.isDefault === true,
        equipment: gym.equipment?.categories ?? [],
        machines: gym.equipment?.machines ?? [],
        notes: gym.notes,
      })),
      equipmentVocabulary: result.json.equipmentVocab ?? [],
    })
  },
}

export const switchGym: WebMcpTool = {
  name: 'switch_gym',
  description:
    'Make a gym the active one. Everything selected afterwards — drafts, substitutions, search — is ' +
    'restricted to that gym\'s equipment, so switching is how you say "I am somewhere else today". ' +
    'Matches an existing gym by name, case-insensitively. When the name is new, pass `equipment` to ' +
    'record it on the spot: that is the travelling case, where the room in front of you has never ' +
    'been seen before. Passing no equipment for an unknown name fails with the list of known gyms ' +
    'rather than inventing one.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The gym to switch to, e.g. "Hotel gym" or the name from list_gyms.',
      },
      equipment: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'barbell', 'dumbbell', 'machine', 'cable', 'body only', 'kettlebells',
            'bands', 'e-z curl bar', 'medicine ball', 'exercise ball', 'foam roll', 'other',
          ],
        },
        description:
          'Creating a new gym: the equipment categories actually present. Anything omitted is treated ' +
          'as absent, which is the point — a dumbbell-only room should exclude every barbell lift.',
      },
      machines: {
        type: 'array',
        items: { type: 'string' },
        description: 'Creating a new gym: named machines present, in the room\'s own words.',
      },
      notes: { type: 'string', description: 'Creating a new gym: anything worth remembering about it.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  async execute(args) {
    const name = str(args, 'name')
    if (!name) return fail('name is required.')

    const listed = await agentFetch('/api/gym/gyms')
    if (!listed.ok) return failFrom(listed, 'Could not load gyms')
    const gyms = Array.isArray(listed.json.gyms) ? (listed.json.gyms as GymRow[]) : []
    const match = gyms.find((gym) => gym.name.trim().toLowerCase() === name.trim().toLowerCase())

    if (match) {
      if (match.isDefault) return ok({ active: match.name, unchanged: true, ...(await eligibility()) })
      const patched = await agentFetch(`/api/gym/gyms/${encodeURIComponent(match.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: true }),
      })
      if (!patched.ok) return failFrom(patched, `Could not switch to ${match.name}`)
      afterMutation('switch_gym', `Switched to ${match.name}.`)
      return ok({ active: match.name, created: false, ...(await eligibility()) })
    }

    const categories = strArray(args, 'equipment')
    if (!categories || categories.length === 0) {
      return fail(
        `No gym called "${name}". Known gyms: ${gyms.map((gym) => gym.name).join(', ') || 'none yet'}. ` +
          'To record this one, call again with `equipment` listing what is actually in the room.',
      )
    }

    const created = await agentFetch('/api/gym/gyms', {
      method: 'POST',
      body: JSON.stringify({
        name,
        equipment: {
          categories,
          machines: strArray(args, 'machines') ?? [],
          machines_excluded: [],
        },
        notes: str(args, 'notes') ?? null,
        isDefault: true,
      }),
    })
    if (!created.ok) return failFrom(created, `Could not create ${name}`)
    afterMutation('switch_gym', `Recorded ${name} and made it the active gym.`)
    return ok({ active: name, created: true, equipment: categories, ...(await eligibility()) })
  },
}

/**
 * How much of the catalog survives the new gym.
 *
 * A switch whose only evidence is "ok: true" tells an agent nothing about what
 * it just did to the option space, and the next draft would be the first hint.
 * One extra read makes the consequence part of the answer.
 */
async function eligibility(): Promise<{ eligibleExercises?: number; catalogSize?: number }> {
  const [eligible, all] = await Promise.all([
    agentFetch('/api/gym/exercises?eligible=1&limit=1'),
    agentFetch('/api/gym/exercises?limit=1'),
  ])
  if (!eligible.ok || typeof eligible.json.total !== 'number') return {}
  return {
    eligibleExercises: eligible.json.total,
    ...(all.ok && typeof all.json.total === 'number' ? { catalogSize: all.json.total } : {}),
  }
}

interface GymRow {
  id: string
  name: string
  isDefault: boolean
  notes: string | null
  equipment: { categories?: string[]; machines?: string[] } | null
}
