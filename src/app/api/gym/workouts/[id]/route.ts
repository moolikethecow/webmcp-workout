import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { discardWorkout, patchCompletedWorkoutMeta, patchWorkoutMeta } from '@/lib/gym/active-workout'
import { finishSummaryForDisplay, finishWorkout } from '@/lib/gym/finish'
import { getGymWeightUnit } from '@/lib/gym/unit-preferences'

/**
 * PATCH /api/gym/workouts/[id] (GYM_PLAN §4).
 *
 *   body { name?, notes?, action?: 'finish' | 'discard' }
 *     - action 'finish'  → finishWorkout() → 200 FinishSummary
 *                          (422 { error:'empty workout' } | 404 lost-the-race)
 *     - action 'discard' → status='discarded' → 200 { discarded: true } (404 if not active)
 *     - no action        → patch name/notes on the active workout → 200 ActiveWorkout
 *                          (409 when the workout isn't active)
 *
 * Every status transition is rowcount-guarded (honest 404/409). Authed +
 * ensureGymSchema() first.
 */

const VALID_ACTIONS = new Set(['finish', 'discard'])

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const b = body as { name?: unknown; notes?: unknown; action?: unknown }
  const action = typeof b.action === 'string' ? b.action : undefined
  if (action !== undefined && !VALID_ACTIONS.has(action)) {
    return NextResponse.json({ error: "action must be 'finish' | 'discard'" }, { status: 400 })
  }

  try {
    await ensureGymSchema()

    if (action === 'finish') {
      const result = await finishWorkout(id)
      if (result.ok) {
        const displayUnit = await getGymWeightUnit()
        return NextResponse.json(finishSummaryForDisplay(result.summary, displayUnit))
      }
      if (result.status === 422) {
        return NextResponse.json({ error: 'empty workout' }, { status: 422 })
      }
      return NextResponse.json({ error: 'Workout is not active' }, { status: 404 })
    }

    if (action === 'discard') {
      const ok = await discardWorkout(id)
      if (!ok) return NextResponse.json({ error: 'Workout is not active' }, { status: 404 })
      return NextResponse.json({ discarded: true })
    }

    // No action → name/notes patch.
    const meta: { name?: string | null; notes?: string | null } = {}
    if (b.name === null || typeof b.name === 'string') meta.name = b.name as string | null
    if (b.notes === null || typeof b.notes === 'string') meta.notes = b.notes as string | null
    const workout = await patchWorkoutMeta(id, meta)
    if (!workout) {
      // Not active anymore — the finish sheet names a just-completed one-off.
      const renamed = await patchCompletedWorkoutMeta(id, meta)
      if (renamed) return NextResponse.json({ ok: true, completed: true })
      return NextResponse.json({ error: 'Workout is not active' }, { status: 409 })
    }
    return NextResponse.json(workout)
  } catch (err) {
    console.error('[gym/workouts/:id] PATCH failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to update workout' }, { status: 500 })
  }
}
