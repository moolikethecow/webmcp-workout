/**
 * Read model for the /health muscle map. Pulls the raw workout→exercise→set rows
 * (last N days), runs them through the TS exercise→muscle mapping (lib/muscles),
 * folds into per-region state (lib/muscle-state), and attaches the paired body
 * measurement per region. Read-only; the API route just calls buildMuscleMap().
 *
 * The muscle mapping is TS (name-keyword rules), not SQL, so the join happens in
 * JS: we fetch a compact per-(exercise, day) set-count table, then fan each
 * exercise out to its regions. Cheap — one row per exercise per training day, not
 * per set.
 */
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { convertLength, type LengthUnit } from '@/lib/units/system'
import {
  MUSCLE_REGIONS,
  REGION_LABELS,
  REGION_MEASUREMENTS,
  mobilityRegionsForExercise,
  musclesForExercise,
  type MuscleRegion,
} from './muscles'
import {
  computeMuscleStates,
  STATE_META,
  type MuscleAggregate,
  type MuscleState,
} from './muscle-state'

/** Window (days) of workout history the state math looks back over. */
const WINDOW_DAYS = 60

interface ExerciseDayRow {
  name: string
  primaryMuscle: string | null
  day: string // YYYY-MM-DD
  /** Working (non-warmup) set count for this exercise on this day. */
  sets: number
}

/** One (exercise, training-day) row with its set count, last WINDOW_DAYS. */
async function exerciseDayRows(): Promise<ExerciseDayRow[]> {
  await ensureGymSchema() // the modality filter below reads a gym-lane column
  return (
    await db.execute(sql`
      SELECT
        e.name AS name,
        e.primary_muscle AS "primaryMuscle",
        w.started_at::date::text AS day,
        count(DISTINCT COALESCE(ws.logical_set_id, ws.client_set_id, ws.id))::int AS sets
      FROM workout_sets ws
      JOIN workout_exercises we ON ws.workout_exercise_id = we.id
      JOIN workouts w ON we.workout_id = w.id
      JOIN exercises e ON we.exercise_id = e.id
      WHERE ws.set_type <> 'warmup'
        AND ws.completed = true
        -- §3b: recovery/state math reads completed sessions only — a live set
        -- must not falsely mark a muscle "recovering" mid-workout.
        AND w.status = 'completed'
        -- §10b.4: mobility work earns NO recovery credit — a stretch session
        -- must not mark a region "recovering" (it gets its own minutes lens).
        -- Cardio keeps its historical behavior; strength (incl. isometric
        -- holds) is what the recovery model measures.
        AND e.modality NOT IN ('stretch', 'dynamic', 'soft_tissue')
        AND w.started_at >= now() - make_interval(days => ${WINDOW_DAYS})
      GROUP BY e.name, e.primary_muscle, w.started_at::date
    `)
  ).rows as unknown as ExerciseDayRow[]
}

/** Weekly per-muscle mobility dose where ROM gains plateau (GYM_PLAN §10 —
 *  2025 meta-regression, PMID 39614059). The lens paints against this. */
export const MOBILITY_WEEKLY_TARGET_MIN = 10

interface MobilityDayRow {
  name: string
  primaryMuscle: string | null
  secondaryMuscles: unknown
  day: string // YYYY-MM-DD
  /** Total completed hold seconds for this exercise on this day. */
  seconds: number
}

/** One (mobility exercise, day) row with its total hold seconds, last
 *  WINDOW_DAYS. The §10b.5 minutes lens reads ONLY mobility modalities — the
 *  exact complement of the recovery read above. Every completed set counts
 *  (no warmup exclusion: a "warmup" stretch is still mobility work). */
async function mobilityDayRows(): Promise<MobilityDayRow[]> {
  await ensureGymSchema()
  return (
    await db.execute(sql`
      SELECT
        e.name AS name,
        e.primary_muscle AS "primaryMuscle",
        e.secondary_muscles AS "secondaryMuscles",
        w.started_at::date::text AS day,
        COALESCE(sum(ws.duration_s), 0)::int AS seconds
      FROM workout_sets ws
      JOIN workout_exercises we ON ws.workout_exercise_id = we.id
      JOIN workouts w ON we.workout_id = w.id
      JOIN exercises e ON we.exercise_id = e.id
      WHERE w.status = 'completed'
        AND ws.completed = true
        AND e.modality IN ('stretch', 'dynamic', 'soft_tissue')
        AND w.started_at >= now() - make_interval(days => ${WINDOW_DAYS})
      GROUP BY e.name, e.primary_muscle, e.secondary_muscles, w.started_at::date
    `)
  ).rows as unknown as MobilityDayRow[]
}

interface MeasurementRow {
  metric: string
  unit: string
  value: number
  date: string
}

/** Every reading (ordered) for each metric any region pairs with. */
async function measurementRows(): Promise<MeasurementRow[]> {
  const wanted = [...new Set(Object.values(REGION_MEASUREMENTS).flat())]
  if (wanted.length === 0) return []
  return (
    await db.execute(sql`
      SELECT metric, unit, value::float8 AS value, measured_at::text AS date
      FROM body_measurements
      WHERE metric IN (${sql.join(
        wanted.map((m) => sql`${m}`),
        sql`, `,
      )})
      ORDER BY metric, measured_at
    `)
  ).rows as unknown as MeasurementRow[]
}

export interface RegionMeasurement {
  label: string
  unit: string
  latest: number | null
  latestDate: string | null
  /** Change from the first reading in-window to the latest (null if <2 readings). */
  delta: number | null
  readings: number
}

export interface MuscleMapRegion extends MuscleState {
  label: string
  measurement: RegionMeasurement | null
  /** §10b.5 mobility lens: hold minutes credited this week / the prior week
   *  (region weights match strength credit: primary 1.0, secondary 0.5). */
  mobilityMinutes: number
  priorMobilityMinutes: number
  /** Days since any mobility work credited this region (null = never in window). */
  daysSinceMobility: number | null
}

export interface MuscleMapResult {
  windowDays: number
  regions: Record<MuscleRegion, MuscleMapRegion>
  legend: { state: string; label: string; hint: string }[]
  hasData: boolean
  /** §10b.5 weekly mobility summary (passive — derived only from logged holds). */
  mobility: {
    weekMinutes: number
    priorWeekMinutes: number
    regionsWorked: number
    targetMinutes: number
  }
}

/** Average the paired (e.g. left/right) metrics into a single region measurement,
 *  converting every reading from its stored unit to `displayLengthUnit` — body
 *  measurements are stored in whatever unit they were logged in (commonly cm from
 *  imports), so the map must not just forward the raw stored unit. */
function regionMeasurement(
  region: MuscleRegion,
  byMetric: Map<string, { unit: string; series: { date: string; value: number }[] }>,
  displayLengthUnit: LengthUnit,
): RegionMeasurement | null {
  const metrics = REGION_MEASUREMENTS[region]
  if (!metrics) return null

  // Collect all present metrics for this region; average across sides per date is
  // overkill — instead take each metric's latest + earliest, then average metrics.
  const latests: number[] = []
  const firsts: number[] = []
  let latestDate: string | null = null
  let totalReadings = 0
  for (const m of metrics) {
    const s = byMetric.get(m)
    if (!s || s.series.length === 0) continue
    const last = s.series[s.series.length - 1]!
    const first = s.series[0]!
    const lastValue = convertLength(last.value, s.unit, displayLengthUnit, 4)
    const firstValue = convertLength(first.value, s.unit, displayLengthUnit, 4)
    if (lastValue == null || firstValue == null) continue
    latests.push(lastValue)
    firsts.push(firstValue)
    totalReadings += s.series.length
    if (!latestDate || last.date > latestDate) latestDate = last.date
  }
  if (latests.length === 0) return null

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const latest = avg(latests)
  const firstAvg = firsts.length ? avg(firsts) : null
  const delta = firstAvg != null && firsts.length === latests.length ? latest - firstAvg : null
  const round1 = (n: number) => Math.round(n * 10) / 10
  return {
    label: REGION_LABELS[region],
    unit: displayLengthUnit,
    latest: round1(latest),
    latestDate,
    delta: delta == null ? null : round1(delta),
    readings: totalReadings,
  }
}

/** Build the whole muscle-map payload. `now` injectable for tests.
 *  `displayLengthUnit` is the app-wide unit preference (§ lib/units/system) — the
 *  paired body measurement is stored per-source unit and must be converted for
 *  display, same as the mobility ROM lens (lib/gym/mobility.ts). */
export async function buildMuscleMap(
  now: Date = new Date(),
  displayLengthUnit: LengthUnit = 'cm',
): Promise<MuscleMapResult> {
  const [dayRows, mobilityRows, measRows] = await Promise.all([
    exerciseDayRows(),
    mobilityDayRows(),
    measurementRows(),
  ])

  // Fold workout rows → per-region aggregates via the TS muscle mapping.
  const nowMs = now.getTime()
  const wk1Cutoff = nowMs - 7 * 86_400_000
  const wk2Cutoff = nowMs - 14 * 86_400_000

  const acc = new Map<
    MuscleRegion,
    { lastWorked: string | null; lastPrimary: string | null; weekly: number; prior: number; exercises: Set<string> }
  >()
  const bump = (region: MuscleRegion) => {
    let a = acc.get(region)
    if (!a) {
      a = { lastWorked: null, lastPrimary: null, weekly: 0, prior: 0, exercises: new Set() }
      acc.set(region, a)
    }
    return a
  }

  for (const row of dayRows) {
    const hits = musclesForExercise(row.name, row.primaryMuscle)
    if (hits.length === 0) continue
    const dayMs = new Date(`${row.day}T00:00:00Z`).getTime()
    for (const { region, weight } of hits) {
      const a = bump(region)
      a.exercises.add(row.name)
      const credited = row.sets * weight
      if (dayMs >= wk1Cutoff) a.weekly += credited
      else if (dayMs >= wk2Cutoff) a.prior += credited
      // Last WORKED = any hit (primary OR secondary) — a secondary-only day still
      // fatigues the muscle, so it counts toward the recovery clock.
      if (!a.lastWorked || row.day > a.lastWorked) a.lastWorked = row.day
      // Last PRIMARY-mover day (weight === 1) — kept for "last trained directly".
      if (weight === 1 && (!a.lastPrimary || row.day > a.lastPrimary)) a.lastPrimary = row.day
    }
  }

  const aggregates: MuscleAggregate[] = MUSCLE_REGIONS.map((region) => {
    const a = acc.get(region)
    return {
      region,
      lastWorkedDate: a?.lastWorked ?? null,
      lastPrimaryDate: a?.lastPrimary ?? null,
      weeklySets: a ? Math.round(a.weekly * 10) / 10 : 0,
      priorWeeklySets: a ? Math.round(a.prior * 10) / 10 : 0,
      exercises: a ? [...a.exercises].sort() : [],
    }
  })
  const states = computeMuscleStates(aggregates, now)

  // Fold mobility rows → per-region weekly hold minutes (§10b.5). Same region
  // weights as strength credit; the enriched mapper reads catalog secondaries
  // (keyword rules rarely match stretch names, so primary/secondary muscles
  // from the catalog do the mapping work here).
  const round1 = (n: number) => Math.round(n * 10) / 10
  const mob = new Map<MuscleRegion, { weekly: number; prior: number; last: string | null }>()
  for (const row of mobilityRows) {
    const secondaries = Array.isArray(row.secondaryMuscles)
      ? row.secondaryMuscles.filter((m): m is string => typeof m === 'string')
      : []
    // §10b.9: joint-aware — a neck stretch credits Neck, not Traps.
    const hits = mobilityRegionsForExercise(row.name, row.primaryMuscle, secondaries)
    if (hits.length === 0) continue
    const dayMs = new Date(`${row.day}T00:00:00Z`).getTime()
    const minutes = row.seconds / 60
    for (const { region, weight } of hits) {
      let m = mob.get(region)
      if (!m) {
        m = { weekly: 0, prior: 0, last: null }
        mob.set(region, m)
      }
      const credited = minutes * weight
      if (dayMs >= wk1Cutoff) m.weekly += credited
      else if (dayMs >= wk2Cutoff) m.prior += credited
      if (!m.last || row.day > m.last) m.last = row.day
    }
  }
  const daysBetween = (day: string) =>
    Math.max(0, Math.floor((nowMs - new Date(`${day}T00:00:00Z`).getTime()) / 86_400_000))

  // Index measurements by metric (unit carried from the row).
  const byMetric = new Map<string, { unit: string; series: { date: string; value: number }[] }>()
  for (const r of measRows) {
    let s = byMetric.get(r.metric)
    if (!s) {
      s = { unit: r.unit, series: [] }
      byMetric.set(r.metric, s)
    }
    s.series.push({ date: r.date, value: r.value })
  }

  const regions = {} as Record<MuscleRegion, MuscleMapRegion>
  for (const region of MUSCLE_REGIONS) {
    const m = mob.get(region)
    regions[region] = {
      ...states[region],
      label: REGION_LABELS[region],
      measurement: regionMeasurement(region, byMetric, displayLengthUnit),
      mobilityMinutes: m ? round1(m.weekly) : 0,
      priorMobilityMinutes: m ? round1(m.prior) : 0,
      daysSinceMobility: m?.last ? daysBetween(m.last) : null,
    }
  }

  const hasData = dayRows.length > 0 || mobilityRows.length > 0
  const legend = (Object.keys(STATE_META) as (keyof typeof STATE_META)[]).map((state) => ({
    state,
    label: STATE_META[state].label,
    hint: STATE_META[state].hint,
  }))

  let weekMinutes = 0
  let priorWeekMinutes = 0
  let regionsWorked = 0
  for (const region of MUSCLE_REGIONS) {
    weekMinutes += regions[region].mobilityMinutes
    priorWeekMinutes += regions[region].priorMobilityMinutes
    if (regions[region].mobilityMinutes > 0) regionsWorked++
  }

  return {
    windowDays: WINDOW_DAYS,
    regions,
    legend,
    hasData,
    mobility: {
      weekMinutes: round1(weekMinutes),
      priorWeekMinutes: round1(priorWeekMinutes),
      regionsWorked,
      targetMinutes: MOBILITY_WEEKLY_TARGET_MIN,
    },
  }
}

// ── Per-region session drill-down (tap a muscle → its recent sets) ───────────

/** How far back the "recent sets" drill-down looks, and how many sessions it
 *  shows. Wider than the state window so a rarely-hit muscle still has history. */
const SESSION_WINDOW_DAYS = 120
const MAX_SESSIONS = 8

interface SetRow {
  workoutId: string
  day: string
  workoutName: string | null
  exerciseName: string
  primaryMuscle: string | null
  position: number
  setNumber: number
  setType: string
  weight: number | null
  reps: number | null
  unit: string | null
}

export interface RegionSet {
  setNumber: number
  weight: number | null
  reps: number | null
  unit: string
  warmup: boolean
}
export interface RegionSessionExercise {
  name: string
  /** True when this exercise trains the region as a PRIMARY mover (vs assisting). */
  primary: boolean
  sets: RegionSet[]
}
export interface RegionSession {
  date: string
  workoutName: string | null
  exercises: RegionSessionExercise[]
}

/**
 * The actual recent sets that trained one region, grouped by workout (newest
 * first) then by exercise — the "tap a muscle to see the log" drill-down. Only
 * exercises that hit THIS region are included in each session; a set carries its
 * weight×reps so the panel reads like a training log. Read-only; the route calls
 * this lazily when a muscle is selected, so the map's initial load stays lean.
 */
export async function buildRegionSessions(
  region: MuscleRegion,
  now: Date = new Date(),
): Promise<RegionSession[]> {
  void now // reserved for future "as of" testing; the query keys off now() in SQL
  await ensureGymSchema() // the modality filter below reads a gym-lane column
  const rows = (
    await db.execute(sql`
      SELECT
        w.id::text AS "workoutId",
        w.started_at::date::text AS day,
        w.name AS "workoutName",
        e.name AS "exerciseName",
        e.primary_muscle AS "primaryMuscle",
        we.position AS position,
        ws.set_number AS "setNumber",
        ws.set_type AS "setType",
        ws.weight::float8 AS weight,
        ws.reps AS reps,
        ws.weight_unit AS unit
      FROM workout_sets ws
      JOIN workout_exercises we ON ws.workout_exercise_id = we.id
      JOIN workouts w ON we.workout_id = w.id
      JOIN exercises e ON we.exercise_id = e.id
      -- §3b: the tap-a-muscle drill-down shows completed sessions only.
      WHERE w.status = 'completed'
        AND ws.completed = true
        -- §10b.4: the drill-down is the STRENGTH training log — mobility work
        -- reads on the mobility lens, not here.
        AND e.modality NOT IN ('stretch', 'dynamic', 'soft_tissue')
        AND w.started_at >= now() - make_interval(days => ${SESSION_WINDOW_DAYS})
      ORDER BY w.started_at DESC, we.position ASC, ws.set_number ASC
    `)
  ).rows as unknown as SetRow[]

  // Group rows (already newest-first, position/set ordered) into sessions →
  // exercises, keeping only exercises whose muscle mapping includes `region`.
  const order: string[] = []
  const byWorkout = new Map<string, RegionSession>()
  // Track each (workout,exercise) so sets append to the right exercise block.
  const exIndex = new Map<string, RegionSessionExercise>()

  for (const r of rows) {
    const hits = musclesForExercise(r.exerciseName, r.primaryMuscle)
    const hit = hits.find((h) => h.region === region)
    if (!hit) continue

    // Skip empty rows — Strong exports carry placeholder sets with neither weight
    // nor reps (they'd render as noisy "0 reps" chips). A real set has weight OR
    // reps; bodyweight sets (reps only) and loaded sets (weight) both survive.
    const hasWeight = r.weight != null && r.weight > 0
    const hasReps = r.reps != null && r.reps > 0
    if (!hasWeight && !hasReps) continue

    let session = byWorkout.get(r.workoutId)
    if (!session) {
      if (byWorkout.size >= MAX_SESSIONS) continue // cap sessions; rows stay ordered
      session = { date: r.day, workoutName: r.workoutName, exercises: [] }
      byWorkout.set(r.workoutId, session)
      order.push(r.workoutId)
    }
    const exKey = `${r.workoutId}|${r.exerciseName}`
    let ex = exIndex.get(exKey)
    if (!ex) {
      ex = { name: r.exerciseName, primary: hit.weight === 1, sets: [] }
      exIndex.set(exKey, ex)
      session.exercises.push(ex)
    }
    ex.sets.push({
      setNumber: r.setNumber,
      weight: r.weight,
      reps: r.reps,
      unit: r.unit ?? '',
      warmup: r.setType === 'warmup',
    })
  }

  return order.map((id) => byWorkout.get(id)!)
}
