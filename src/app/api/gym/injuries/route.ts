import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { isMuscleRegion } from '@/lib/fitness/muscles'
import { createInjury, createTweakInjury, listInjuries } from '@/lib/gym/injuries-gyms'
import { isInjurySite } from '@/lib/gym/injury-profile'

/**
 * /api/gym/injuries — the injuries list + create (GYM_PLAN §4 settings sheet, §6).
 *
 *   GET  ?active=1              → { injuries: Injury[] } (active-only when active=1,
 *                                else all rows; see the "active" convention in
 *                                lib/gym/injuries-gyms — resolved_at NULL or future).
 *   POST { region, severity?, label?, note?, resolvedAt? }
 *                              → { injury } (201). region MUST be a canonical
 *                                InjurySite → 400 otherwise.
 *   POST { tweak: { region, days? } }
 *                              → { injury } — the logger "Tweaked" chip's auto-
 *                                expiring soft flag (resolved_at = now()+days).
 *
 * Authed + ensureGymSchema() like the other gym write routes.
 */

export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    await ensureGymSchema()
    const activeOnly = new URL(req.url).searchParams.get('active') === '1'
    const injuries = await listInjuries(activeOnly)
    return NextResponse.json({ injuries })
  } catch (err) {
    console.error('[gym/injuries] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load injuries' }, { status: 500 })
  }
}

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
  const b = body as Record<string, unknown>

  try {
    await ensureGymSchema()

    // Logger "Tweaked" chip: auto-expiring soft flag from the exercise's region.
    if (b.tweak && typeof b.tweak === 'object') {
      const t = b.tweak as Record<string, unknown>
      const region = typeof t.region === 'string' ? t.region : ''
      const days = typeof t.days === 'number' && t.days > 0 ? t.days : 7
      if (!isMuscleRegion(region)) {
        return NextResponse.json({ error: 'region must be a canonical muscle region' }, { status: 400 })
      }
      const injury = await createTweakInjury(region, days)
      return NextResponse.json({ injury }, { status: 201 })
    }

    const region = typeof b.region === 'string' ? b.region : ''
    if (!isInjurySite(region)) {
      return NextResponse.json({ error: 'region must be a canonical injury site' }, { status: 400 })
    }
    const injury = await createInjury({
      region,
      label: typeof b.label === 'string' ? b.label : null,
      note: typeof b.note === 'string' ? b.note : null,
      severity: typeof b.severity === 'string' ? b.severity : null,
      resolvedAt: typeof b.resolvedAt === 'string' ? b.resolvedAt : null,
    })
    if (!injury) {
      return NextResponse.json({ error: 'region must be a canonical injury site' }, { status: 400 })
    }
    return NextResponse.json({ injury }, { status: 201 })
  } catch (err) {
    console.error('[gym/injuries] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to create injury' }, { status: 500 })
  }
}
