import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { readSessionDetail, updateCompletedSetRest } from '@/lib/gym/history-read'
import { deleteCompletedWorkout } from '@/lib/gym/history-delete'
import { getGymUnitPreferences } from '@/lib/gym/unit-preferences'

/**
 * GET /api/gym/history/[id] (GYM_PLAN §4 "Tab: History" session detail, P2b).
 *
 *   → 200 SessionDetail (full set log grouped by exercise, duration/volume header,
 *          notes) — see lib/gym/history-read.
 *   → 404 when the id doesn't exist or isn't a COMPLETED workout (§3b: an
 *          active/discarded session never resolves here).
 *
 * Authed + ensureGymSchema() like the other gym read routes.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  try {
    await ensureGymSchema()
    const units = await getGymUnitPreferences()
    const detail = await readSessionDetail(id, units.weightUnit)
    if (!detail) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    return NextResponse.json({ ...detail, distanceUnit: units.distanceUnit })
  } catch (err) {
    console.error('[gym/history/:id] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load session' }, { status: 500 })
  }
}

/**
 * PATCH /api/gym/history/[id] { setId, restSeconds } — edit the rest taken after
 * one set in a COMPLETED session (the inline tap-to-edit rest between sets).
 * `restSeconds` null/0 clears it. Only touches a set that belongs to this
 * completed workout.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  const body = (await req.json().catch(() => null)) as { setId?: unknown; restSeconds?: unknown } | null
  if (!body || typeof body.setId !== 'string') {
    return NextResponse.json({ error: 'setId is required' }, { status: 400 })
  }
  const raw = body.restSeconds
  // Accept a non-negative integer or null/0 to clear; cap at 1 hour.
  const restSeconds =
    raw == null || raw === 0
      ? null
      : typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= 3600
        ? raw
        : undefined
  if (restSeconds === undefined) {
    return NextResponse.json({ error: 'restSeconds must be null or 1..3600 seconds' }, { status: 400 })
  }
  try {
    await ensureGymSchema()
    const ok = await updateCompletedSetRest(id, body.setId, restSeconds)
    if (!ok) return NextResponse.json({ error: 'Set not found in this session' }, { status: 404 })
    return NextResponse.json({ ok: true, restSeconds })
  } catch (err) {
    console.error('[gym/history/:id] PATCH failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to update rest' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  try {
    await ensureGymSchema()
    const result = await deleteCompletedWorkout(id)
    if (!result) {
      return NextResponse.json({ error: 'Completed session not found' }, { status: 404 })
    }
    return NextResponse.json(result)
  } catch (err) {
    console.error('[gym/history/:id] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 })
  }
}
