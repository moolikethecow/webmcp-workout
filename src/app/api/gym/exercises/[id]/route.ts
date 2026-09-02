import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import {
  ActiveLoadCorrectionError,
  getExerciseDetail,
  patchExercise,
  type PatchExerciseInput,
} from '@/lib/gym/exercise-detail'
import { getGymUnitPreferences } from '@/lib/gym/unit-preferences'

/**
 * /api/gym/exercises/[id] — one exercise's full detail + preference edits.
 *
 *   GET   → { exercise, records, history, charts } (see lib/gym/exercise-detail).
 *   PATCH { disliked?, dislikeReason?, preferred?, defaultRestSeconds?,
 *           restSecondsWarmup?, preferredUnit?, tracked?, snoozeDays? } →
 *           { exercise } (404 on a missing row). snoozeDays>0 → temporary
 *           staleness cooldown ("Bored of it" chip); 0/null clears it. `preferred`
 *           is the "Preference" replace-reason chip (#1876).
 *
 * Runs ensureGymSchema() first, authed like the other gym routes.
 */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  try {
    await ensureGymSchema()
    const units = await getGymUnitPreferences()
    const detail = await getExerciseDetail(id, units.weightUnit, units.distanceUnit)
    if (!detail) return NextResponse.json({ error: 'Exercise not found' }, { status: 404 })
    return NextResponse.json(detail)
  } catch (err) {
    console.error('[gym/exercises/:id] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load exercise' }, { status: 500 })
  }
}

const UNITS = new Set(['lb', 'kg'])
const LOAD_BASES = new Set(['total', 'per_side'])

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
  const b = body as Record<string, unknown>

  // Build a typed patch from only the provided, well-typed fields.
  const input: PatchExerciseInput = {}
  if (typeof b.disliked === 'boolean') input.disliked = b.disliked
  if (b.dislikeReason === null || typeof b.dislikeReason === 'string') {
    input.dislikeReason = b.dislikeReason as string | null
  }
  if (typeof b.preferred === 'boolean') input.preferred = b.preferred
  if (b.defaultRestSeconds === null || typeof b.defaultRestSeconds === 'number') {
    input.defaultRestSeconds = b.defaultRestSeconds as number | null
  }
  if (b.restSecondsWarmup === null || typeof b.restSecondsWarmup === 'number') {
    input.restSecondsWarmup = b.restSecondsWarmup as number | null
  }
  if (b.preferredUnit === null || (typeof b.preferredUnit === 'string' && UNITS.has(b.preferredUnit))) {
    input.preferredUnit = b.preferredUnit as 'lb' | 'kg' | null
  }
  if (typeof b.loadBasis === 'string' && LOAD_BASES.has(b.loadBasis)) {
    input.loadBasis = b.loadBasis as 'total' | 'per_side'
  }
  if (typeof b.tracked === 'boolean') input.tracked = b.tracked
  // "Bored of it" reason chip: temporary staleness cooldown (N days, or null clears).
  if (b.snoozeDays === null || typeof b.snoozeDays === 'number') {
    input.snoozeDays = b.snoozeDays as number | null
  }

  try {
    await ensureGymSchema()
    const detail = await patchExercise(id, input)
    if (!detail) return NextResponse.json({ error: 'Exercise not found' }, { status: 404 })
    return NextResponse.json({ exercise: detail.exercise })
  } catch (err) {
    if (err instanceof ActiveLoadCorrectionError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    console.error('[gym/exercises/:id] PATCH failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to update exercise' }, { status: 500 })
  }
}
