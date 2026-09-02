import { NextResponse, type NextRequest } from 'next/server'

import { dropStaleWorkspaces } from '@/lib/workspace/sweep'

export const dynamic = 'force-dynamic'

/**
 * GET /api/workspace/sweep?token=… — drop workspaces nobody has touched in
 * `days` (default 14). Meant for an external scheduler (a cron hitting the URL).
 *
 * Guarded by `WORKSPACE_SWEEP_TOKEN`. When that env var is UNSET the route is
 * disabled outright (404) rather than open: an unguarded endpoint that deletes
 * every idle visitor's data is not something to leave on by default.
 */
export async function GET(req: NextRequest) {
  const expected = process.env.WORKSPACE_SWEEP_TOKEN
  if (!expected) {
    return NextResponse.json({ error: 'Sweep disabled' }, { status: 404 })
  }
  if (req.nextUrl.searchParams.get('token') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const daysParam = req.nextUrl.searchParams.get('days')
  const days = daysParam == null ? 14 : Number(daysParam)
  if (!Number.isFinite(days) || days < 1) {
    return NextResponse.json({ error: 'days must be a number >= 1' }, { status: 400 })
  }

  try {
    const result = await dropStaleWorkspaces(days)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[workspace] sweep failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
