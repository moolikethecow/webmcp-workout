import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { buildRegionSessions } from '@/lib/fitness/muscle-map'
import { isMuscleRegion } from '@/lib/fitness/muscles'

/**
 * GET /api/health/muscle-map/sessions?region=<region> — the drill-down.
 *
 *   → 200 { sessions: RegionSession[] }
 *
 * The actual sets that trained one region, newest session first. Loaded lazily
 * when someone taps a muscle, which is why it is a second route rather than
 * part of the map payload: the tab's first paint stays one query.
 *
 * An unknown region is a 400 rather than an empty list — silently answering
 * "no sessions" would read as "you have never trained this", which is a
 * different and wrong statement.
 */
export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const region = req.nextUrl.searchParams.get('region')?.trim() ?? ''
  if (!isMuscleRegion(region)) {
    return NextResponse.json({ error: `Unknown muscle region: ${region || '(none)'}` }, { status: 400 })
  }
  try {
    return NextResponse.json({ sessions: await buildRegionSessions(region) })
  } catch (err) {
    console.error('[health/muscle-map/sessions] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load sessions for this region' }, { status: 500 })
  }
}
