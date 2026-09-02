import { sql } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { createExerciseWithFill } from '@/lib/gym/exercise-detail'
import { listInjuries } from '@/lib/gym/injuries-gyms'
import {
  exerciseAllowedWithInjuries,
  parseExerciseInjuryProfile,
  type InjuryConstraint,
} from '@/lib/gym/injury-profile'
import { queryExercises, type ExerciseFilter, type ExerciseListItem } from '@/lib/gym/search'

/**
 * /api/gym/exercises — the Gym Exercises-tab catalog surface.
 *
 *   GET  ?q=&muscle=&equipment=&filter=&limit=&offset=&eligible=
 *        → { exercises: ExerciseListItem[], total } (see lib/gym/search).
 *        eligible=1 additionally drops every row that conflicts with an ACTIVE
 *        training constraint and reports `excluded_count` + `eligibility`.
 *   POST { name }
 *        → { exercise, created, aiFilled }. Existing name → created:false (no fill);
 *          new name → plain custom row + LLM metadata fill (ai_filled on success).
 *
 * Every request runs ensureGymSchema() first; the catalog ships enriched, so
 * there is nothing to backfill at read time.
 */

const VALID_FILTERS = new Set(['custom', 'disliked', 'tracked'])

export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    await ensureGymSchema()

    const url = new URL(req.url)
    const p = url.searchParams
    const filterRaw = p.get('filter') ?? undefined
    const filter =
      filterRaw && VALID_FILTERS.has(filterRaw) ? (filterRaw as ExerciseFilter) : undefined
    const limit = toInt(p.get('limit'))
    const offset = toInt(p.get('offset'))

    const result = await queryExercises({
      q: p.get('q') ?? undefined,
      muscle: p.get('muscle') ?? undefined,
      equipment: p.get('equipment') ?? undefined,
      filter,
      limit,
      offset,
    })

    // Opt-in eligibility pass. It lives HERE and not in lib/gym/search so the
    // catalog browser (which must show everything, greyed or not) and the agent
    // surface (which must never propose a movement a live constraint excludes)
    // read the same query with one explicit flag between them.
    if (p.get('eligible') === '1') {
      const filtered = await filterToEligible(result.exercises)
      return NextResponse.json({
        exercises: filtered.exercises,
        total: filtered.exercises.length,
        excluded_count: filtered.excluded,
        eligibility: 'filtered',
      })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[gym/exercises] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load exercises' }, { status: 500 })
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
  const name = (body as { name?: unknown }).name
  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  try {
    await ensureGymSchema()
    const { detail, created, aiFilled } = await createExerciseWithFill(name)
    return NextResponse.json({ exercise: detail.exercise, created, aiFilled })
  } catch (err) {
    console.error('[gym/exercises] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to create exercise' }, { status: 500 })
  }
}

/**
 * Drop rows that conflict with an ACTIVE training constraint.
 *
 * The `InjuryConstraint[]` projection and the `injury_override` escape hatch
 * mirror the template-start path in lib/gym/active-workout.ts exactly — a
 * physio-cleared movement carries `injury_override` precisely so it survives
 * the gate, and the gate itself (`exerciseAllowedWithInjuries`) is the one
 * canonical eligibility check the drafting engine and the live editor also use.
 */
async function filterToEligible(
  exercises: ExerciseListItem[],
): Promise<{ exercises: ExerciseListItem[]; excluded: number }> {
  if (exercises.length === 0) return { exercises, excluded: 0 }
  const injuries: InjuryConstraint[] = (await listInjuries(true)).map((injury) => ({
    region: injury.region,
    severity: injury.severity,
  })) as InjuryConstraint[]
  if (injuries.length === 0) return { exercises, excluded: 0 }

  const ids = exercises.map((exercise) => exercise.id)
  const rows = (
    await db.execute(sql`
      SELECT id, injury_profile, injury_override
      FROM exercises
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `)
  ).rows as unknown as Array<{ id: string; injury_profile: unknown; injury_override: boolean | null }>
  const byId = new Map(rows.map((row) => [row.id, row]))

  const kept = exercises.filter((exercise) => {
    const row = byId.get(exercise.id)
    if (!row) return false
    if (row.injury_override) return true
    return exerciseAllowedWithInjuries(parseExerciseInjuryProfile(row.injury_profile), injuries).allowed
  })
  return { exercises: kept, excluded: exercises.length - kept.length }
}

function toInt(v: string | null): number | undefined {
  if (v == null) return undefined
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}
