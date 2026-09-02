import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import {
  getTrainingPlan,
  setTrainingPlanStatus,
  TrainingPlanNotFoundError,
  TrainingPlanValidationError,
  updateTrainingPlan,
  type TrainingPlanStatus,
} from '@/lib/gym/training-plans'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: RouteContext) {
  if (!authenticateRequest(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const plan = await getTrainingPlan((await params).id, true)
    if (!plan) return NextResponse.json({ error: 'Training plan not found' }, { status: 404 })
    return NextResponse.json({ plan })
  } catch (err) {
    console.error('[gym/plans/:id] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load training plan' }, { status: 500 })
  }
}
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  if (!authenticateRequest(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const row = body != null && typeof body === 'object' ? body as Record<string, unknown> : {}
  try {
    const id = (await params).id
    if (row.status === 'active' || row.status === 'paused' || row.status === 'archived') {
      return NextResponse.json({ plan: await setTrainingPlanStatus(id, row.status as TrainingPlanStatus) })
    }
    return NextResponse.json({ plan: await updateTrainingPlan(id, body) })
  } catch (err) {
    if (err instanceof TrainingPlanNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 })
    }
    if (err instanceof TrainingPlanValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error('[gym/plans/:id] PATCH failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to update training plan' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  if (!authenticateRequest(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const plan = await setTrainingPlanStatus((await params).id, 'archived')
    return NextResponse.json({ plan })
  } catch (err) {
    if (err instanceof TrainingPlanNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 })
    }
    console.error('[gym/plans/:id] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to archive training plan' }, { status: 500 })
  }
}
