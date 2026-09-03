import { sql } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/lib/db/client'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { getExerciseDetail, type HistorySession } from '@/lib/gym/exercise-detail'
import {
  evaluateProgression,
  type HistorySet as PolicyHistorySet,
  type SessionHistory,
  type Unit,
} from '@/lib/gym/progression'
import { epley, toLb } from '@/lib/gym/records'
import { queryExercises } from '@/lib/gym/search'
import { getGymUnitPreferences } from '@/lib/gym/unit-preferences'

/**
 * GET /api/gym/agent/progress?exercise=<name> — everything an agent needs to
 * talk about one movement without guessing.
 *
 *   → 200 { exercise, units, records, recentSessions[], trend, progression }
 *   → 400 when `exercise` is missing
 *   → 404 { error, suggestions[] } when the name doesn't resolve (up to 5
 *          close matches, so the caller can retry with a real name)
 *
 * `recentSessions` is the last 8 COMPLETED sessions, newest first, with the
 * working-set summary only — warm-ups are excluded from volume and from the
 * best set, because they are not working volume. `progression` is the explicit
 * policy that applies plus the target it produces for the next session; the
 * arithmetic is deterministic and lives in `lib/gym/progression.ts`.
 */

const RECENT_SESSIONS = 8

/** Working sets only: warm-ups never count toward volume or a best set. */
function isWorking(setType: string): boolean {
  return setType !== 'warmup'
}

interface SessionSummary {
  date: string
  workoutId: string
  workoutName: string | null
  workingSets: number
  /** Σ weight×reps over working sets, in lb. */
  workingVolumeLb: number
  bestSet: { weight: number | null; unit: string; reps: number | null } | null
  topE1rmLb: number | null
}

function summarizeSession(session: HistorySession): SessionSummary {
  const working = session.sets.filter((set) => isWorking(set.setType))
  let volume = 0
  let topE1rm: number | null = null
  let best: SessionSummary['bestSet'] = null
  let bestLb = -1
  for (const set of working) {
    const weightLb = set.weight == null ? null : toLb(set.weight, set.unit)
    if (weightLb != null && set.reps != null) {
      volume += weightLb * set.reps
      const e1rm = epley(weightLb, set.reps)
      if (topE1rm == null || e1rm > topE1rm) topE1rm = e1rm
    }
    if (weightLb != null && weightLb > bestLb) {
      bestLb = weightLb
      best = { weight: set.weight, unit: set.unit, reps: set.reps }
    }
  }
  return {
    date: session.date,
    workoutId: session.workoutId,
    workoutName: session.workoutName,
    workingSets: working.length,
    workingVolumeLb: Math.round(volume),
    bestSet: best,
    topE1rmLb: topE1rm == null ? null : Math.round(topE1rm * 10) / 10,
  }
}

/** OLDEST→NEWEST working sets, the order the policy engine expects. */
function toPolicyHistory(sessions: HistorySession[]): SessionHistory {
  return [...sessions]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((session) =>
      session.sets
        .filter((set) => isWorking(set.setType))
        .map<PolicyHistorySet>((set) => ({
          weight: set.weight,
          unit: set.unit === 'kg' ? 'kg' : 'lb',
          reps: set.reps,
          durationS: set.durationS,
          side: set.side,
        })),
    )
    .filter((session) => session.length > 0)
}

/**
 * The progression policy that applies to this exercise: a per-exercise rule
 * beats a template default, exactly like the live-workout reader. Null means
 * the `last_time` default.
 */
async function progressionPolicyFor(exerciseId: string): Promise<unknown> {
  const [row] = (
    await db.execute(sql`
      SELECT COALESCE(te.progression, t.progression) AS progression
      FROM template_exercises te
      JOIN workout_templates t ON t.id = te.template_id
      WHERE te.exercise_id = ${exerciseId}
        AND COALESCE(te.progression, t.progression) IS NOT NULL
      ORDER BY (te.progression IS NOT NULL) DESC
      LIMIT 1
    `)
  ).rows as unknown as Array<{ progression: unknown }>
  return row?.progression ?? null
}

export async function GET(req: NextRequest) {
  const requested = (new URL(req.url).searchParams.get('exercise') ?? '').trim()
  if (!requested) {
    return NextResponse.json({ error: 'exercise is required' }, { status: 400 })
  }

  try {
    await ensureGymSchema()
    const units = await getGymUnitPreferences()

    const { exercises } = await queryExercises({ q: requested, limit: 25 })
    const wanted = requested.toLowerCase()
    const exact = exercises.filter((row) => row.name.trim().toLowerCase() === wanted)
    let pool = exact.length > 0 ? exact : exercises
    // "incline bench" matches five catalog rows, but only one has ever been
    // performed. When the name is ambiguous, prefer the movements with history —
    // that is what someone asking about their progress means.
    if (pool.length > 1) {
      const performed = pool.filter((row) => (row.sets ?? 0) > 0 || row.lastPerformed)
      if (performed.length >= 1) pool = performed
    }
    if (pool.length !== 1) {
      return NextResponse.json(
        {
          error:
            pool.length === 0
              ? `No exercise matches "${requested}".`
              : `"${requested}" matches more than one exercise.`,
          suggestions: pool.slice(0, 5).map((row) => row.name),
        },
        { status: 404 },
      )
    }

    const match = pool[0]!
    const detail = await getExerciseDetail(match.id, units.weightUnit, units.distanceUnit)
    if (!detail) {
      return NextResponse.json({ error: 'Exercise not found', suggestions: [] }, { status: 404 })
    }

    const recentSessions = [...detail.history]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, RECENT_SESSIONS)
      .map(summarizeSession)

    const policyHistory = toPolicyHistory(detail.history)
    const rawPolicy = await progressionPolicyFor(match.id)
    const unit: Unit = (detail.exercise.preferredUnit === 'kg' ? 'kg' : units.weightUnit) as Unit
    const progression = evaluateProgression(rawPolicy, policyHistory, unit)

    return NextResponse.json({
      exercise: {
        id: match.id,
        name: match.name,
        tracks: detail.exercise.tracks,
        primaryMuscle: detail.exercise.primaryMuscle,
        equipment: detail.exercise.equipment,
        loadBasis: detail.exercise.loadBasis,
        perSide: detail.exercise.perSide,
        lastPerformed: detail.exercise.lastPerformed,
        totalSets: detail.exercise.sets,
      },
      units: { weight: detail.weightUnit, distance: detail.distanceUnit },
      records: detail.records,
      recentSessions,
      trend: {
        // Chronological per-day series; e1RM is empty for tracks where it is
        // deliberately not computed (see records.excludedFromE1rm).
        e1rm: detail.charts.e1rm,
        volume: detail.charts.volume,
        bestSet: detail.charts.bestSet,
        excludedFromE1rm: detail.records.excludedFromE1rm,
      },
      progression: {
        policy: rawPolicy,
        rule: progression.ruleText,
        nextTarget: progression.sets,
        unit,
        basedOnSessions: policyHistory.length,
      },
    })
  } catch (err) {
    console.error('[gym/agent/progress] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load exercise progress' }, { status: 500 })
  }
}
