import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { getActiveWorkout, restoreTemplateWeights } from '@/lib/gym/active-workout'

/**
 * POST /api/gym/workouts/active/restore-weights — undo the return-to-training
 * ease for the live session, putting the template's own weights back (#1790).
 *
 * The Train tab's banner action. Deliberately NOT a confirmation gate on start:
 * `start_workout` stays risk:'medium', the session opens eased (the safe
 * direction), and restoring is one tap. Only uncompleted sets change.
 */
export async function POST(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    await ensureGymSchema()
    const active = await getActiveWorkout()
    if (!active) return NextResponse.json({ error: 'No workout is active.' }, { status: 404 })
    const result = await restoreTemplateWeights(active.id)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
    // Echo the refreshed session so the logger re-renders from one source.
    const refreshed = await getActiveWorkout()
    return NextResponse.json({ restored: result.restored, active: refreshed })
  } catch (err) {
    console.error(
      '[gym/workouts/active/restore-weights] POST failed:',
      err instanceof Error ? err.message : err,
    )
    return NextResponse.json({ error: 'Failed to restore template weights' }, { status: 500 })
  }
}
