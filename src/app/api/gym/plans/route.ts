import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import {
  createTrainingPlan,
  listTrainingPlans,
  TrainingPlanValidationError,
} from '@/lib/gym/training-plans'

export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const includeArchived = new URL(req.url).searchParams.get('archived') === '1'
    return NextResponse.json({ plans: await listTrainingPlans(includeArchived) })
  } catch (err) {
    console.error('[gym/plans] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load training plans' }, { status: 500 })
  }
}
export async function POST(req: NextRequest) {
  if (!authenticateRequest(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  try {
    return NextResponse.json({ plan: await createTrainingPlan(body) }, { status: 201 })
  } catch (err) {
    if (err instanceof TrainingPlanValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error('[gym/plans] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to create training plan' }, { status: 500 })
  }
}
