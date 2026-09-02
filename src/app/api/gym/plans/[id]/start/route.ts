import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import {
  startTrainingPlanDay,
  TrainingPlanNotFoundError,
  TrainingPlanValidationError,
} from '@/lib/gym/training-plans'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!authenticateRequest(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body: unknown = {}
  try {
    const text = await req.text()
    body = text ? JSON.parse(text) : {}
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const dayId =
    body != null && typeof body === 'object' && typeof (body as Record<string, unknown>).dayId === 'string'
      ? String((body as Record<string, unknown>).dayId)
      : undefined
  try {
    const result = await startTrainingPlanDay((await params).id, dayId)
    if (result.conflictActiveWorkoutId) {
      return NextResponse.json(
        { activeWorkoutId: result.conflictActiveWorkoutId },
        { status: 409 },
      )
    }
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof TrainingPlanNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 })
    }
    if (err instanceof TrainingPlanValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error('[gym/plans/:id/start] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to start training-plan workout' }, { status: 500 })
  }
}
