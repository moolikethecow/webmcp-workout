import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { readHistory } from '@/lib/gym/history-read'
import { getGymUnitPreferences } from '@/lib/gym/unit-preferences'

/**
 * GET /api/gym/history?month=YYYY-MM&offset=&limit= (GYM_PLAN §4 "Tab: History", P2b).
 *
 *   → 200 {
 *       calendar: [{ date, workoutIds, count }],       // the requested month
 *       weeks:    [{ weekStart, workouts, volumeLb }],  // last 8 weeks
 *       sessions: [{ id, name, date, durationSeconds, exerciseCount, setCount,
 *                    volumeLb, prCount?, templateId, templateName }],  // DESC page
 *       hasMore:  boolean,                              // more sessions past this page
 *       eras:     [{ templateId, templateName, firstDate, lastDate, sessions }]
 *     }
 *
 * status='completed' ONLY everywhere (§3b). `month` defaults to the current server
 * month; a bad month string falls back to it (never a 400). Authed + ensureGymSchema()
 * like the other gym read routes — no catalog enrichment (history doesn't need it).
 */
export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    await ensureGymSchema()

    const p = new URL(req.url).searchParams
    const units = await getGymUnitPreferences()
    const result = await readHistory(
      {
        month: p.get('month') ?? undefined,
        offset: toInt(p.get('offset')),
        limit: toInt(p.get('limit')),
      },
      units.weightUnit,
    )
    return NextResponse.json({ ...result, distanceUnit: units.distanceUnit })
  } catch (err) {
    console.error('[gym/history] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 })
  }
}

function toInt(v: string | null): number | undefined {
  if (v == null) return undefined
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}
