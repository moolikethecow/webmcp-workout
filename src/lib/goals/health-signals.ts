/**
 * Live training signals derived from logged history.
 *
 * Estimated 1RM uses Epley over completed working sets only, so a live session
 * never spikes a trend mid-workout. Values are canonical lb; callers convert at
 * their display boundary.
 */
import 'server-only'

import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { KG_TO_LB } from '@/lib/units/weight'

export interface ExerciseE1rm {
  /** Best all-time estimated 1RM in lb. */
  best: number
  /** Best over the last 28 days, or null with no data in the window. */
  recent: number | null
  /** Best over the 28 days before that, or null. */
  prior: number | null
}

/** Best + 28d-bucketed estimated 1RM per exercise name, in one query. */
export async function exerciseE1rms(names: string[]): Promise<Map<string, ExerciseE1rm>> {
  const out = new Map<string, ExerciseE1rm>()
  if (names.length === 0) return out
  const rows = (
    await db.execute(sql`
      SELECT
        e.name AS name,
        max((CASE WHEN ws.weight_unit = 'kg' THEN ws.weight * ${KG_TO_LB} ELSE ws.weight END)
          * (1 + ws.reps / 30.0))::float8 AS best,
        max((CASE WHEN ws.weight_unit = 'kg' THEN ws.weight * ${KG_TO_LB} ELSE ws.weight END)
          * (1 + ws.reps / 30.0))
          FILTER (WHERE w.started_at >= CURRENT_DATE - 28 AND w.started_at < CURRENT_DATE)::float8 AS recent,
        max((CASE WHEN ws.weight_unit = 'kg' THEN ws.weight * ${KG_TO_LB} ELSE ws.weight END)
          * (1 + ws.reps / 30.0))
          FILTER (WHERE w.started_at >= CURRENT_DATE - 56 AND w.started_at < CURRENT_DATE - 28)::float8 AS prior
      FROM workout_sets ws
      JOIN workout_exercises we ON ws.workout_exercise_id = we.id
      JOIN workouts w ON we.workout_id = w.id
      JOIN exercises e ON we.exercise_id = e.id
      WHERE e.name IN (${sql.join(
        names.map((n) => sql`${n}`),
        sql`, `,
      )})
        AND ws.set_type <> 'warmup'
        AND ws.completed = true
        AND ws.weight IS NOT NULL AND ws.weight > 0
        AND ws.reps IS NOT NULL AND ws.reps > 0
        AND w.status = 'completed'
      GROUP BY e.name
    `)
  ).rows as unknown as Array<{ name: string; best: number | null; recent: number | null; prior: number | null }>
  for (const r of rows) {
    if (r.best == null) continue
    out.set(r.name, {
      best: Math.round(r.best * 10) / 10,
      recent: r.recent != null ? Math.round(r.recent * 10) / 10 : null,
      prior: r.prior != null ? Math.round(r.prior * 10) / 10 : null,
    })
  }
  return out
}
