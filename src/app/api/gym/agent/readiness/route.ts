import { NextResponse } from 'next/server'

import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { historyReadiness } from '@/lib/gym/readiness-source'

/**
 * GET /api/gym/agent/readiness — per-muscle-region readiness, freshest first.
 *
 *   → 200 { source, computedAt, basis, regions: RegionReadiness[] }
 *
 * The numbers come from logged sets and nothing else (see
 * `lib/gym/readiness-source.ts`). `basis` says so in the payload, because an
 * agent reading "recovering" needs to know it is a training-volume statement
 * and not a physiological one.
 */
export async function GET() {
  try {
    await ensureGymSchema()
    const now = new Date()
    const regions = await historyReadiness.compute(now)
    return NextResponse.json({
      source: historyReadiness.name,
      computedAt: now.toISOString(),
      basis:
        'Derived from logged sets only: days since the region was last worked, plus weighted working sets in the trailing 7 days (primary movers 1.0, secondary 0.5). Not a medical or recovery assessment.',
      regions,
    })
  } catch (err) {
    console.error('[gym/agent/readiness] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to compute readiness' }, { status: 500 })
  }
}
