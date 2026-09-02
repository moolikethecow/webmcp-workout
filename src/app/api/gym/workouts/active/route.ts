import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { getActiveWorkout } from '@/lib/gym/active-workout'

/**
 * GET /api/gym/workouts/active — the current active workout, or { active: null }
 * (GYM_PLAN §4 resume banner). Uses the partial-index probe (idx_workouts_active).
 * Authed + ensureGymSchema() first.
 */
export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    await ensureGymSchema()
    const workout = await getActiveWorkout()
    if (!workout) return NextResponse.json({ active: null })
    return NextResponse.json(workout)
  } catch (err) {
    console.error('[gym/workouts/active] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load active workout' }, { status: 500 })
  }
}
