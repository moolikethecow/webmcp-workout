/**
 * The source exercise's FULL muscle profile — primary AND secondary hits —
 * resolved through the enriched mapper that rotation pools already use.
 *
 * Lives in lib rather than beside the route that first needed it: a Next.js
 * `route.ts` may only export HTTP handlers and a fixed set of config symbols,
 * and exporting a helper from one breaks the generated route types (and the
 * build) even though `vitest` and a plain typecheck of `src/` stay green.
 *
 * Two callers need the same answer and must not drift: the alternatives GET
 * that RANKS replacements, and the exercises POST that records whether the
 * replacement a human chose was among the ones offered (#1876). Ranking on the
 * primary muscle alone is what made replacing a reverse curl offer biceps work
 * when the lift is in the program for forearms.
 */
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { musclesForExerciseEnriched, type MuscleHit } from '@/lib/fitness/muscles'

export async function sourceProfile(exerciseId: string): Promise<MuscleHit[]> {
  const [row] = (
    await db.execute(
      sql`SELECT name, primary_muscle, secondary_muscles FROM exercises WHERE id = ${exerciseId} LIMIT 1`,
    )
  ).rows as unknown as Array<{
    name: string
    primary_muscle: string | null
    secondary_muscles: unknown
  }>
  if (!row) return []
  const sec = Array.isArray(row.secondary_muscles)
    ? row.secondary_muscles.filter((x): x is string => typeof x === 'string')
    : []
  return musclesForExerciseEnriched(row.name, row.primary_muscle, sec)
}
