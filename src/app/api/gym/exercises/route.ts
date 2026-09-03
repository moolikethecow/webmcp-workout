import { sql } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { createExerciseWithFill } from '@/lib/gym/exercise-detail'
import { listGyms, listInjuries } from '@/lib/gym/injuries-gyms'
import { gymCompatible, gymEquipmentTokens, gymExcludedNames } from '@/lib/gym/novelty'
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
    const eligible = p.get('eligible') === '1'
    const modality = p.get('modality') ?? undefined

    // The eligibility pass and the modality filter run AFTER the query, so
    // over-fetch when either is on and cut to the requested page afterwards —
    // otherwise a limited page can come back empty once its rows are excluded.
    const postFiltered = eligible || !!modality
    const result = await queryExercises({
      q: p.get('q') ?? undefined,
      muscle: p.get('muscle') ?? undefined,
      equipment: p.get('equipment') ?? undefined,
      filter,
      limit: postFiltered ? 200 : limit,
      offset: postFiltered ? undefined : offset,
    })
    if (modality) {
      result.exercises = result.exercises.filter((row) => row.modality === modality)
      result.total = result.exercises.length
    }

    // Opt-in eligibility pass. It lives HERE and not in lib/gym/search so the
    // catalog browser (which must show everything, greyed or not) and the agent
    // surface (which must never propose a movement a live constraint excludes)
    // read the same query with one explicit flag between them.
    if (eligible) {
      const filtered = await filterToEligible(result.exercises)
      const page = filtered.exercises.slice(0, limit ?? 50)
      return NextResponse.json({
        exercises: page,
        total: filtered.exercises.length,
        excluded_count: filtered.excluded,
        excluded_by_equipment: filtered.excludedByEquipment,
        eligibility: 'filtered',
      })
    }

    if (postFiltered) result.exercises = result.exercises.slice(0, limit ?? 50)
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
 * Drop every row this person cannot actually do right now.
 *
 * Two independent gates, because they fail for different reasons and an agent
 * that is told "excluded" deserves to know which:
 *
 *   constraints  the `InjuryConstraint[]` projection and the `injury_override`
 *                escape hatch mirror the template-start path in
 *                lib/gym/active-workout.ts exactly — a physio-cleared movement
 *                carries `injury_override` precisely so it survives the gate,
 *                and the gate itself (`exerciseAllowedWithInjuries`) is the one
 *                canonical check the drafting engine and live editor also use.
 *
 *   equipment    the active gym's kit, through the same `gymCompatible` the
 *                drafting pools use. This gate was specified from the start —
 *                `search_exercises` has always said "filtered to what the
 *                current equipment and constraints allow" — but only the
 *                constraint half was ever implemented, so a dumbbell-only hotel
 *                gym still returned barbell lifts to the agent. Found by
 *                switching gyms on prod and watching the eligible count refuse
 *                to move.
 */
async function filterToEligible(
  exercises: ExerciseListItem[],
): Promise<{ exercises: ExerciseListItem[]; excluded: number; excludedByEquipment: number }> {
  if (exercises.length === 0) return { exercises, excluded: 0, excludedByEquipment: 0 }

  const [injuriesRaw, gyms] = await Promise.all([listInjuries(true), listGyms()])
  const injuries: InjuryConstraint[] = injuriesRaw.map((injury) => ({
    region: injury.region,
    severity: injury.severity,
  })) as InjuryConstraint[]

  // The active gym is the default one; no gym, or a gym with no equipment
  // listed, means "assume everything is here" — same rule as buildPools.
  const activeGym = gyms.find((gym) => gym.isDefault) ?? null
  const tokens = gymEquipmentTokens(activeGym?.equipment ?? null)
  const excludedNames = gymExcludedNames(activeGym?.equipment ?? null)

  const afterEquipment = exercises.filter((exercise) => gymCompatible(exercise, tokens, excludedNames))
  const excludedByEquipment = exercises.length - afterEquipment.length

  if (injuries.length === 0) {
    return { exercises: afterEquipment, excluded: excludedByEquipment, excludedByEquipment }
  }

  const ids = afterEquipment.map((exercise) => exercise.id)
  if (ids.length === 0) {
    return { exercises: afterEquipment, excluded: excludedByEquipment, excludedByEquipment }
  }
  const rows = (
    await db.execute(sql`
      SELECT id, injury_profile, injury_override
      FROM exercises
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `)
  ).rows as unknown as Array<{ id: string; injury_profile: unknown; injury_override: boolean | null }>
  const byId = new Map(rows.map((row) => [row.id, row]))

  const kept = afterEquipment.filter((exercise) => {
    const row = byId.get(exercise.id)
    if (!row) return false
    if (row.injury_override) return true
    return exerciseAllowedWithInjuries(parseExerciseInjuryProfile(row.injury_profile), injuries).allowed
  })
  return { exercises: kept, excluded: exercises.length - kept.length, excludedByEquipment }
}

function toInt(v: string | null): number | undefined {
  if (v == null) return undefined
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}
