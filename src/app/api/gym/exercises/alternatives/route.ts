import { NextResponse, type NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'

import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { sourceProfile } from '@/lib/gym/source-profile'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { assembleCoachContext } from '@/lib/gym/coach-context'
import { musclesForExerciseEnriched, type MuscleHit } from '@/lib/fitness/muscles'
import { shapeAlternatives, type AlternativesResponse } from './shape'

/**
 * /api/gym/exercises/alternatives — the swap-sheet's deterministic alternatives
 * (GYM_PLAN §4 replace / §6 "same-muscle alternatives filtered by gym equipment +
 * not-disliked, deterministic"). NO LLM — the agent reranks if it wants to.
 *
 *   GET ?exerciseId=<id>&n=<count> → { region, regionLabel, alternatives: [...] }
 *
 * Thin: it resolves the source exercise's FULL muscle profile — primary AND
 * secondary hits, not primary alone (#1876; a movement chosen for a secondary
 * role, e.g. a reverse curl for forearms, used to only offer primary-muscle
 * alternatives) — reuses the coach-context rotation pools (already
 * gym-equipment-filtered + dislike-filtered), and shapes the top-n alternatives
 * ranked across that whole profile (staleness-tiebroken, source excluded). Authed
 * + ensureGymSchema() like the other gym routes.
 */

const DEFAULT_N = 8
const MAX_N = 24

export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const url = new URL(req.url)
  const exerciseId = url.searchParams.get('exerciseId')?.trim()
  if (!exerciseId) {
    return NextResponse.json({ error: 'exerciseId is required' }, { status: 400 })
  }
  const n = clampN(url.searchParams.get('n'))

  try {
    await ensureGymSchema()

    const profile = await sourceProfile(exerciseId)
    // Coach-context supplies pools already filtered by the default gym's equipment
    // + dislikes (deterministic, cached ~5min). Reuse it — never rebuild pools here.
    const ctx = await assembleCoachContext()
    const payload: AlternativesResponse = shapeAlternatives(ctx.pools, profile, exerciseId, n)
    return NextResponse.json(payload)
  } catch (err) {
    console.error(
      '[gym/exercises/alternatives] GET failed:',
      err instanceof Error ? err.message : String(err),
    )
    return NextResponse.json({ error: 'Failed to load alternatives' }, { status: 500 })
  }
}

function clampN(raw: string | null): number {
  if (raw == null) return DEFAULT_N
  const v = Number.parseInt(raw, 10)
  if (!Number.isFinite(v)) return DEFAULT_N
  return Math.max(1, Math.min(MAX_N, v))
}
