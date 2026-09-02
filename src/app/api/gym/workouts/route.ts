import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { startWorkout, type StartFrom } from '@/lib/gym/active-workout'

/**
 * POST /api/gym/workouts — start a new active workout (GYM_PLAN §4, P2a/P2b).
 *
 *   body { from: 'template' | 'empty' | 'repeat_last' | 'workout', templateId?, workoutId? }
 *     → 200 ActiveWorkout
 *     → 409 { activeWorkoutId } when one is already active (UI offers resume/discard)
 *     → 400 on a bad body / missing templateId / missing workoutId
 *     → 404 on an unknown template / unknown source workout
 *
 * `from: 'workout'` (+ `workoutId`) is the History-tab "Repeat" path — it copies a
 * SPECIFIC completed session's structure, same mechanics as repeat_last for an
 * explicit id. No sets rows are pre-created — planned sets stay virtual until the UI
 * materializes them via PUT /sets. Authed + ensureGymSchema() like the other gym
 * write routes (no catalog enrichment — write paths don't need it).
 */

const VALID_FROM = new Set<StartFrom>(['template', 'empty', 'repeat_last', 'workout'])

export async function POST(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const b = body as { from?: unknown; templateId?: unknown; workoutId?: unknown }
  const from = b.from as StartFrom
  if (typeof from !== 'string' || !VALID_FROM.has(from)) {
    return NextResponse.json(
      { error: "from must be 'template' | 'empty' | 'repeat_last' | 'workout'" },
      { status: 400 },
    )
  }
  const templateId = typeof b.templateId === 'string' ? b.templateId : undefined
  const workoutId = typeof b.workoutId === 'string' ? b.workoutId : undefined
  if (from === 'template' && !templateId) {
    return NextResponse.json({ error: 'templateId is required when from=template' }, { status: 400 })
  }
  if (from === 'workout' && !workoutId) {
    return NextResponse.json({ error: 'workoutId is required when from=workout' }, { status: 400 })
  }

  try {
    await ensureGymSchema()
    const result = await startWorkout(from, templateId, workoutId)
    if (result.conflictActiveWorkoutId) {
      return NextResponse.json(
        { activeWorkoutId: result.conflictActiveWorkoutId },
        { status: 409 },
      )
    }
    return NextResponse.json(result.workout)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('template not found')) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }
    if (msg.includes('workout not found')) {
      return NextResponse.json({ error: 'Workout not found' }, { status: 404 })
    }
    console.error('[gym/workouts] POST failed:', msg)
    return NextResponse.json({ error: 'Failed to start workout' }, { status: 500 })
  }
}
