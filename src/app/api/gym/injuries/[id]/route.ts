import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { deleteInjury, updateInjury } from '@/lib/gym/injuries-gyms'

/**
 * /api/gym/injuries/[id] — patch (resolve/reopen/edit) or delete one injury.
 *
 *   PATCH { label?, note?, severity?, resolve? } → { injury } | 404.
 *          resolve: true → resolved now · false → reopen · ISO string → explicit time.
 *   DELETE → { ok: true } | 404.
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
    const injury = await updateInjury(id, {
      label: b.label === null || typeof b.label === 'string' ? (b.label as string | null) : undefined,
      note: b.note === null || typeof b.note === 'string' ? (b.note as string | null) : undefined,
      severity: typeof b.severity === 'string' ? b.severity : undefined,
      resolve:
        typeof b.resolve === 'boolean' || typeof b.resolve === 'string'
          ? (b.resolve as boolean | string)
          : undefined,
    })
    if (!injury) return NextResponse.json({ error: 'Injury not found' }, { status: 404 })
    return NextResponse.json({ injury })
  } catch (err) {
    console.error('[gym/injuries/:id] PATCH failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to update injury' }, { status: 500 })
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
    const ok = await deleteInjury(id)
    if (!ok) return NextResponse.json({ error: 'Injury not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[gym/injuries/:id] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to delete injury' }, { status: 500 })
  }
}
