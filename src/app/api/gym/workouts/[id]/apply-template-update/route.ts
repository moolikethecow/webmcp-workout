import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { applyTemplateUpdateForWorkout } from '@/lib/gym/finish'
import type { UpdateMode } from '@/lib/gym/template-diff'

/**
 * POST /api/gym/workouts/[id]/apply-template-update — absorb a finished workout's
 * deviation back into its template (GYM_PLAN §4 template-update prompt).
 *
 *   body { mode: 'structure' | 'values' | 'both' }
 *     → 200 { applied: true }
 *     → 404 when the workout has no template (nothing to apply)
 *     → 400 on a bad mode
 *
 * Replace-all in a transaction, preserving surviving exercises' progression
 * policies by exercise_id. Authed + ensureGymSchema() first.
 */

const VALID_MODES = new Set<UpdateMode>(['structure', 'values', 'both'])

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const mode = (body as { mode?: unknown }).mode as UpdateMode
  if (typeof mode !== 'string' || !VALID_MODES.has(mode)) {
    return NextResponse.json({ error: "mode must be 'structure' | 'values' | 'both'" }, { status: 400 })
  }

  try {
    await ensureGymSchema()
    const applied = await applyTemplateUpdateForWorkout(id, mode)
    if (!applied) {
      return NextResponse.json({ error: 'Workout has no template to update' }, { status: 404 })
    }
    return NextResponse.json({ applied: true })
  } catch (err) {
    console.error('[gym/workouts/:id/apply-template-update] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to apply template update' }, { status: 500 })
  }
}
