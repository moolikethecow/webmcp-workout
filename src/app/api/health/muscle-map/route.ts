import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { buildMuscleMap } from '@/lib/fitness/muscle-map'

/**
 * GET /api/health/muscle-map — the Body tab's read model.
 *
 *   → 200 { windowDays, regions, legend, hasData, mobility }
 *
 * A thin wrapper over `buildMuscleMap()`, which is where all the work is: it
 * reads completed, non-warm-up sets over the trailing window, fans each
 * exercise out to the muscle regions it trains, and folds those into per-region
 * state. Nothing is computed here, so the figure on this tab and the readiness
 * an agent reads through `get_muscle_readiness` cannot disagree — both call the
 * same builder.
 *
 * `db` resolves the caller's workspace on its own (see `lib/db/client`), so the
 * map is the visitor's own training history and no one else's.
 */
export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return NextResponse.json(await buildMuscleMap())
  } catch (err) {
    console.error('[health/muscle-map] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to build the muscle map' }, { status: 500 })
  }
}
