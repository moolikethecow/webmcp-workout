import { NextResponse } from 'next/server'

import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { getActiveWorkout } from '@/lib/gym/active-workout'
import { listGyms, listInjuries } from '@/lib/gym/injuries-gyms'
import { getTodayProposal } from '@/lib/gym/plan'
import { getGymUnitPreferences } from '@/lib/gym/unit-preferences'

/**
 * GET /api/gym/agent/context — the orientation payload behind
 * `get_training_context`.
 *
 * Three blocks, and the order matters to a reader:
 *   product — what this app can actually do, in one list.
 *   state   — the few facts that change what the next call should be.
 *   rules   — the operating rules an agent is expected to honour here. They are
 *             repeated in each tool's description because descriptions travel
 *             with the tool, but an agent that reads only this still has them.
 *
 * Everything is cheap and read-only. No LLM runs on this path.
 */

const CAPABILITIES = [
  'Read and edit the workout currently being performed, safely, while a person is logging sets in the app',
  'Search the exercise catalog filtered to what the current equipment and training constraints allow',
  'Report per-muscle-region readiness derived from training history',
  'Report per-exercise records, recent sessions, trend and the next prescribed target',
  'Record and resolve training constraints',
  'Build a deterministic workout draft, edit it, and start it',
  'Read workout history',
] as const

const RULES = [
  'The workout is a shared artifact: a person may be logging sets in the app at the same time. Read canonical state before every change.',
  'Canonical server state wins over anything said in conversation. Pass expected_revision from the last read on every mutation; on a stale_revision answer, re-read and retry rather than forcing the write.',
  'Never infer that a set was completed from conversation. Only the logger records performance.',
  'Completed performance is preserved by default. Change a logged set only as an explicit correction the person asked for.',
  'Warm-up sets are not working volume. A change to "sets" means working sets; warm-up ramps are edited separately.',
  'Training constraints and available equipment are hard limits, not preferences. Use search_exercises before proposing a substitution and pick from what it returns.',
  'Muscle readiness is derived from training history only — days since a region was worked and its recent working volume. It is not a recovery score and no wearable data enters it.',
  'Do not diagnose or prescribe treatment. A training constraint records what a person says they cannot do; it is not a medical finding.',
] as const

export async function GET() {
  // TODO(workspace): read the request-scoped workspace from the cookie layer
  // and run these readers inside that workspace's schema context.
  try {
    await ensureGymSchema()

    const [active, injuries, gyms, units, proposal] = await Promise.all([
      getActiveWorkout(),
      listInjuries(true),
      listGyms(),
      getGymUnitPreferences(),
      getTodayProposal().catch(() => null),
    ])

    const gym = gyms.find((candidate) => candidate.isDefault) ?? gyms[0] ?? null

    return NextResponse.json({
      product: {
        name: 'Workout',
        capabilities: CAPABILITIES,
      },
      state: {
        hasActiveWorkout: active != null,
        activeWorkoutRevision: active?.revision ?? null,
        hasDraft: proposal != null && proposal.status === 'proposed',
        units: { weight: units.weightUnit, distance: units.distanceUnit },
        activeConstraints: injuries.length,
        gymEquipment: gym
          ? {
              gym: gym.name,
              categories: gym.equipment.categories,
              machines: gym.equipment.machines,
              machinesExcluded: gym.equipment.machines_excluded,
            }
          : null,
      },
      rules: RULES,
    })
  } catch (err) {
    console.error('[gym/agent/context] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load training context' }, { status: 500 })
  }
}
