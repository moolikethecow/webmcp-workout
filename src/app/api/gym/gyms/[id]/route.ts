import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { deleteGym, pickEquipment, updateGym } from '@/lib/gym/injuries-gyms'

/**
 * /api/gym/gyms/[id] — patch or delete one gym (GYM_PLAN §4 My-Gyms editor).
 *
 *   PATCH { name?, equipment?, notes?, isDefault? } → { gym } | 404.
 *          isDefault:true clears every other default in the same transaction
 *          (exactly-one-default invariant).
 *   DELETE → { ok: true } | 404. Deleting the default promotes the newest remaining
 *          gym so the invariant holds.
 *
 * Authed + ensureGymSchema(). Rowcount-honest 404s.
 */

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

  try {
    await ensureGymSchema()
    const gym = await updateGym(id, {
      name: typeof b.name === 'string' ? b.name : undefined,
      equipment: b.equipment !== undefined ? pickEquipment(b.equipment) : undefined,
      notes: b.notes === null || typeof b.notes === 'string' ? (b.notes as string | null) : undefined,
      isDefault: b.isDefault === true ? true : undefined,
    })
    if (!gym) return NextResponse.json({ error: 'Gym not found' }, { status: 404 })
    return NextResponse.json({ gym })
  } catch (err) {
    console.error('[gym/gyms/:id] PATCH failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to update gym' }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  try {
    await ensureGymSchema()
    const ok = await deleteGym(id)
    if (!ok) return NextResponse.json({ error: 'Gym not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[gym/gyms/:id] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to delete gym' }, { status: 500 })
  }
}
