import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import {
  createGym,
  excludeExerciseAtDefaultGym,
  listGyms,
  pickEquipment,
  GYM_EQUIPMENT_VOCAB,
} from '@/lib/gym/injuries-gyms'

/**
 * /api/gym/gyms — the My-Gyms editor list + create (GYM_PLAN §4 settings sheet).
 *
 *   GET  → { gyms: Gym[], equipmentVocab: string[] } (default first). The vocab is
 *          the FEDB equipment checklist the editor renders.
 *   POST { name, equipment?{categories,machines,machines_excluded}, notes?, isDefault? }
 *        → { gym } (201). First gym (or isDefault) becomes the sole default,
 *          transactionally. 400 on an empty name.
 *
 * Authed + ensureGymSchema() like the other gym write routes. Exactly-one-default is
 * enforced in the lib's transactions.
 */

export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    await ensureGymSchema()
    const gyms = await listGyms()
    return NextResponse.json({ gyms, equipmentVocab: GYM_EQUIPMENT_VOCAB })
  } catch (err) {
    console.error('[gym/gyms] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load gyms' }, { status: 500 })
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

  // Logger "Not available here" reason chip: append an exercise name to the DEFAULT
  // gym's machines_excluded (per-gym exclusion). No default gym → { excluded: false }.
  if (typeof b.excludeExercise === 'string' && b.excludeExercise.trim()) {
    try {
      await ensureGymSchema()
      const excluded = await excludeExerciseAtDefaultGym(b.excludeExercise)
      return NextResponse.json({ excluded })
    } catch (err) {
      console.error('[gym/gyms] exclude failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Failed to exclude exercise' }, { status: 500 })
    }
  }

  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  try {
    await ensureGymSchema()
    const gym = await createGym({
      name,
      equipment: pickEquipment(b.equipment),
      notes: typeof b.notes === 'string' ? b.notes : null,
      isDefault: b.isDefault === true,
    })
    if (!gym) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    return NextResponse.json({ gym }, { status: 201 })
  } catch (err) {
    console.error('[gym/gyms] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to create gym' }, { status: 500 })
  }
}
