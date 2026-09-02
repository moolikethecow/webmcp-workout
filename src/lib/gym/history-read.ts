/**
 * History read model (GET /api/gym/history + GET /api/gym/history/[id], GYM_PLAN
 * §4 "Tab: History", P2b). The DB glue behind the History tab: a month calendar,
 * the last-8-weeks workouts/volume bars, a paginated completed-session list, the
 * program-era bands, and one session's full set log.
 *
 * §3b filter-sweep discipline (GYM_PLAN §3b): EVERY query here scopes to
 * `w.status = 'completed'`, so an in-progress/discarded session never appears on
 * the calendar, the weekly bars, the session list, or the era bands.
 *
 * VOLUME MATH mirrors records.ts / finish.ts EXACTLY so a number here can never
 * disagree with the finish sheet or the exercise detail: incomplete prescription
 * rows and warmups excluded,
 * assisted_bodyweight excluded (assistance isn't load), weighted_bodyweight counts
 * the ADDED weight only, weight×reps in lb (kg → lb at KG_TO_LB). The exclusion is
 * expressed once, in the shared `volumeExpr` SQL fragment, so the list / weeks /
 * session-detail totals all agree by construction.
 *
 * `prCount` is deliberately OMITTED from the session list (the plan's
 * "optional-cheap: do NOT recompute records per session list row"): computing a
 * real PR count means replaying all-time history per exercise per row, which is
 * the finish-flow's job, not a list's. The field stays optional in the contract so
 * a later cheap source can fill it without a shape change.
 */
import { sql, type SQL } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { convertStoredWeight, convertWeight, KG_TO_LB, type WeightUnit } from '@/lib/units/weight'

import { displayExerciseName } from './display-name'
import { resolveGrip, toGripSpec, type GripSpec } from './grip'

// ---------------------------------------------------------------------------
// Contract (consumed verbatim by the History-tab client)
// ---------------------------------------------------------------------------

/** One day on the month calendar that had ≥1 completed workout. */
export interface CalendarDay {
  /** 'YYYY-MM-DD' (the workout's local calendar day). */
  date: string
  workoutIds: string[]
  count: number
}

/** One of the last 8 weeks on the workouts/week bar row. */
export interface WeekBar {
  /** 'YYYY-MM-DD' Monday of the week (local). */
  weekStart: string
  /** Completed workouts that week. */
  workouts: number
  /** Total working-set volume that week, in lb (rounded). */
  volumeLb: number
  /** Same volume converted to the current app-wide display unit. */
  volume: number
}

/** One completed session in the paginated list. */
export interface SessionRow {
  id: string
  name: string | null
  /** ISO started_at. */
  date: string
  durationSeconds: number | null
  exerciseCount: number
  /** Completed working (non-warmup) set count. */
  setCount: number
  volumeLb: number
  volume: number
  /** Optional — not computed in the list (see file header). */
  prCount?: number
  templateId: string | null
  templateName: string | null
}

/** A program era = a contiguous run of sessions on the same template. */
export interface ProgramEra {
  /** null for the "no template" run (free-form / imported sessions). */
  templateId: string | null
  templateName: string | null
  /** ISO started_at of the era's first + last session. */
  firstDate: string
  lastDate: string
  /** Sessions in the era. */
  sessions: number
}

export interface HistoryResponse {
  weightUnit: WeightUnit
  calendar: CalendarDay[]
  weeks: WeekBar[]
  sessions: SessionRow[]
  /** True when more completed sessions exist past this page. */
  hasMore: boolean
  eras: ProgramEra[]
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const WEEKS_BACK = 8

/**
 * Shared volume SQL fragment: Σ weight×reps in lb across WORKING sets, with the
 * records.ts exclusions baked in (warmup out; assisted out; weighted counts added
 * weight only; weight>0 AND reps>0). kg is converted to lb inline. Joins the
 * exercise's `tracks` via the passed alias so callers can reuse it under any join
 * shape. Wrapped in COALESCE(…, 0) at the call site.
 */
function volumeExpr(ws: string, ex: string): SQL {
  return sql.raw(`
    SUM(
      CASE
        WHEN ${ws}.set_type <> 'warmup'
         AND ${ws}.completed = true
         AND ${ex}.tracks IN ('weight_reps', 'weighted_bodyweight')
         AND ${ws}.weight IS NOT NULL AND ${ws}.weight > 0
         AND ${ws}.reps IS NOT NULL AND ${ws}.reps > 0
        THEN (CASE WHEN ${ws}.weight_unit = 'kg' THEN ${ws}.weight * ${KG_TO_LB} ELSE ${ws}.weight END)
          * ${ws}.reps
          * (CASE WHEN ${ex}.load_basis = 'per_side' AND ${ws}.side IS NULL THEN 2 ELSE 1 END)
        ELSE 0
      END
    )
  `)
}

/** Completed working (non-warmup) set count fragment. */
function workingSetCountExpr(ws: string): SQL {
  return sql.raw(`COUNT(DISTINCT COALESCE(${ws}.logical_set_id, ${ws}.client_set_id, ${ws}.id)) FILTER (WHERE ${ws}.set_type <> 'warmup' AND ${ws}.completed = true AND ${ws}.id IS NOT NULL)`)
}

// ---------------------------------------------------------------------------
// GET /api/gym/history — the whole tab in one read
// ---------------------------------------------------------------------------

export interface HistoryParams {
  /** 'YYYY-MM' for the calendar month; defaults to the current month (server tz). */
  month?: string
  offset?: number
  limit?: number
}

/**
 * Assemble the full History payload: month calendar + last-8-weeks bars +
 * paginated session list + program eras. Four independent reads (all scoped to
 * completed workouts). `month` defaults to the current server month; a bad month
 * string falls back to the current month rather than erroring.
 */
export async function readHistory(
  params: HistoryParams = {},
  displayUnit: WeightUnit = 'lb',
): Promise<HistoryResponse> {
  const month = normalizeMonth(params.month)
  const limit = clampLimit(params.limit)
  const offset = Math.max(0, params.offset ?? 0)

  const [calendar, weeks, sessionsPage, eras] = await Promise.all([
    readCalendar(month),
    readWeeks(),
    readSessions(offset, limit),
    readEras(),
  ])

  return {
    weightUnit: displayUnit,
    calendar,
    weeks: weeks.map((week) => ({
      ...week,
      volume: displayVolume(week.volumeLb, displayUnit),
    })),
    sessions: sessionsPage.sessions.map((session) => ({
      ...session,
      volume: displayVolume(session.volumeLb, displayUnit),
    })),
    hasMore: sessionsPage.hasMore,
    eras,
  }
}

function displayVolume(volumeLb: number, displayUnit: WeightUnit): number {
  return Math.round(convertWeight(volumeLb, 'lb', displayUnit) ?? 0)
}

/** 'YYYY-MM' → the first day '<month>-01'; invalid/absent → current server month. */
function normalizeMonth(raw?: string): string {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) {
    const m = Number(raw.slice(5, 7))
    if (m >= 1 && m <= 12) return raw
  }
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function clampLimit(raw?: number): number {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.floor(raw))
}

// ---------------------------------------------------------------------------
// Calendar (one month of workout days)
// ---------------------------------------------------------------------------

/** Completed-workout days within the given month, each with its workout ids. */
async function readCalendar(month: string): Promise<CalendarDay[]> {
  const monthStart = `${month}-01`
  const rows = (
    await db.execute(sql`
      SELECT w.started_at::date::text AS day,
        array_agg(w.id::text ORDER BY w.started_at) AS ids
      FROM workouts w
      WHERE w.status = 'completed'
        AND w.started_at >= ${monthStart}::date
        AND w.started_at < (${monthStart}::date + INTERVAL '1 month')
      GROUP BY w.started_at::date
      ORDER BY day
    `)
  ).rows as unknown as Array<{ day: string; ids: string[] }>

  return rows.map((r) => ({
    date: r.day,
    workoutIds: r.ids,
    count: r.ids.length,
  }))
}

// ---------------------------------------------------------------------------
// Weekly bars (last 8 weeks — workouts + volume)
// ---------------------------------------------------------------------------

/**
 * The last 8 ISO weeks (Monday-based), each with its completed-workout count and
 * total working-set volume. Weeks with no workouts still appear (zero bars) so the
 * bar row is a fixed 8-wide axis. Built from a generated week series LEFT JOINed to
 * the per-week aggregate — a missing week is a real zero, never a synthesized gap.
 */
async function readWeeks(): Promise<WeekBar[]> {
  const rows = (
    await db.execute(sql`
      WITH weeks AS (
        SELECT (date_trunc('week', CURRENT_DATE) - (n || ' weeks')::interval)::date AS week_start
        FROM generate_series(0, ${WEEKS_BACK - 1}) AS n
      ),
      per_week AS (
        SELECT date_trunc('week', w.started_at)::date AS week_start,
          COUNT(DISTINCT w.id) AS workouts,
          ${sql`COALESCE(${volumeExpr('ws', 'e')}, 0)`} AS volume
        FROM workouts w
        JOIN workout_exercises we ON we.workout_id = w.id
        JOIN exercises e ON e.id = we.exercise_id
        LEFT JOIN workout_sets ws ON ws.workout_exercise_id = we.id
        WHERE w.status = 'completed'
          AND w.started_at >= (date_trunc('week', CURRENT_DATE) - (${WEEKS_BACK - 1} || ' weeks')::interval)
        GROUP BY date_trunc('week', w.started_at)::date
      )
      SELECT weeks.week_start::text AS week_start,
        COALESCE(per_week.workouts, 0)::int AS workouts,
        COALESCE(per_week.volume, 0) AS volume
      FROM weeks
      LEFT JOIN per_week ON per_week.week_start = weeks.week_start
      ORDER BY weeks.week_start ASC
    `)
  ).rows as unknown as Array<{ week_start: string; workouts: number; volume: string | number }>

  return rows.map((r) => ({
    weekStart: r.week_start,
    workouts: r.workouts,
    volumeLb: Math.round(Number(r.volume) || 0),
    volume: Math.round(Number(r.volume) || 0),
  }))
}

// ---------------------------------------------------------------------------
// Session list (paginated, DESC)
// ---------------------------------------------------------------------------

interface SessionsPage {
  sessions: SessionRow[]
  hasMore: boolean
}

/**
 * A page of completed sessions, newest first. Each row carries its exercise count,
 * working-set count, and total volume — all in ONE aggregate query (no per-row PR
 * replay). Fetches limit+1 to report `hasMore` without a second COUNT.
 */
async function readSessions(offset: number, limit: number): Promise<SessionsPage> {
  const rows = (
    await db.execute(sql`
      SELECT w.id, w.name, w.started_at::text AS started_at, w.duration_seconds,
        w.template_id, t.name AS template_name,
        COUNT(DISTINCT we.id)::int AS exercise_count,
        ${sql`COALESCE(${workingSetCountExpr('ws')}, 0)`}::int AS set_count,
        ${sql`COALESCE(${volumeExpr('ws', 'e')}, 0)`} AS volume
      FROM workouts w
      LEFT JOIN workout_templates t ON t.id = w.template_id
      LEFT JOIN workout_exercises we ON we.workout_id = w.id
      LEFT JOIN exercises e ON e.id = we.exercise_id
      LEFT JOIN workout_sets ws ON ws.workout_exercise_id = we.id
      WHERE w.status = 'completed'
      GROUP BY w.id, t.name
      ORDER BY w.started_at DESC, w.id DESC
      LIMIT ${limit + 1} OFFSET ${offset}
    `)
  ).rows as unknown as Array<{
    id: string
    name: string | null
    started_at: string
    duration_seconds: number | null
    template_id: string | null
    template_name: string | null
    exercise_count: number
    set_count: number
    volume: string | number
  }>

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  return {
    sessions: page.map((r) => ({
      id: r.id,
      name: r.name,
      date: r.started_at,
      durationSeconds: r.duration_seconds,
      exerciseCount: r.exercise_count,
      setCount: r.set_count,
      volumeLb: Math.round(Number(r.volume) || 0),
      volume: Math.round(Number(r.volume) || 0),
      templateId: r.template_id,
      templateName: r.template_name,
    })),
    hasMore,
  }
}

// ---------------------------------------------------------------------------
// Program eras (contiguous template runs)
// ---------------------------------------------------------------------------

/**
 * Derive program-era bands from the completed sessions' template_id runs. An era
 * is a maximal contiguous run (in chronological order) of sessions that share the
 * same template_id — so switching to a new program starts a new band, and
 * switching back later starts ANOTHER band (runs are contiguous, not grouped).
 *
 * The grouping is done in TS (a simple linear pass over ordered sessions) rather
 * than SQL window gymnastics — cheaper to read, tested directly.
 */
async function readEras(): Promise<ProgramEra[]> {
  const rows = (
    await db.execute(sql`
      SELECT w.id, w.started_at::text AS started_at, w.template_id, t.name AS template_name
      FROM workouts w
      LEFT JOIN workout_templates t ON t.id = w.template_id
      WHERE w.status = 'completed'
      ORDER BY w.started_at ASC
    `)
  ).rows as unknown as Array<{
    id: string
    started_at: string
    template_id: string | null
    template_name: string | null
  }>

  return buildEras(rows)
}

/** One session as the era builder sees it (exported shape for the pure fn/test). */
export interface EraSessionInput {
  started_at: string
  template_id: string | null
  template_name: string | null
}

/**
 * PURE: collapse chronologically-ordered sessions into contiguous same-template
 * runs. Input MUST be oldest→newest. A run breaks whenever template_id changes
 * (null is its own template — consecutive no-template sessions band together).
 */
export function buildEras(sessions: EraSessionInput[]): ProgramEra[] {
  const eras: ProgramEra[] = []
  let current: ProgramEra | null = null

  for (const s of sessions) {
    if (current && current.templateId === s.template_id) {
      current.lastDate = s.started_at
      current.sessions += 1
      // Keep the name fresh if a null-named row later resolves (defensive).
      if (current.templateName == null && s.template_name != null) {
        current.templateName = s.template_name
      }
      continue
    }
    current = {
      templateId: s.template_id,
      templateName: s.template_name,
      firstDate: s.started_at,
      lastDate: s.started_at,
      sessions: 1,
    }
    eras.push(current)
  }
  return eras
}

// ---------------------------------------------------------------------------
// GET /api/gym/history/[id] — one session's full set log
// ---------------------------------------------------------------------------

/** One logged set inside a session-detail exercise block. */
/**
 * Set (or clear) the rest taken after one set in a COMPLETED session. Scoped by
 * a join to the owning workout so a bad id can't touch another session's set.
 * Returns true when a row was updated.
 */
export async function updateCompletedSetRest(
  workoutId: string,
  setId: string,
  restSeconds: number | null,
): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE workout_sets ws
       SET rest_seconds = ${restSeconds}
      FROM workout_exercises we
      JOIN workouts w ON w.id = we.workout_id
     WHERE ws.id = ${setId}
       AND ws.workout_exercise_id = we.id
       AND w.id = ${workoutId}
       AND w.status = 'completed'
  `)
  return (res.rowCount ?? 0) > 0
}

export interface SessionDetailSet {
  /**
   * The grip this set was ACTUALLY performed with — the exercise's grip with
   * any per-set override applied, never the raw column. A caller reading the
   * raw column would see null and conclude "no grip", when the honest answer
   * is "whatever the exercise said".
   */
  grip: GripSpec
  /** workout_sets row id — the edit target for per-set rest. */
  id: string
  setNumber: number
  setType: string
  weight: number | null
  unit: string
  reps: number | null
  distanceM: number | null
  durationS: number | null
  rpe: number | null
  /** Rest taken after this set (seconds); null when unknown. Populated for
   *  Strong imports from the per-set rest rows and for in-app logged sets. */
  restSeconds: number | null
  /** Measured gap since the previous completed set — rest PLUS the set itself.
   *  ⚠️ NOT pure rest: without a set-start marker the two cannot be separated,
   *  and calling it `actualRest` would overstate what was measured. Null on
   *  sessions logged before timestamps existed (#1835). */
  secondsSincePreviousSet: number | null
  side: 'left' | 'right' | null
  /** Physical L/R rows for one performed set share this id. */
  logicalSetId: string
  completed: boolean
  /**
   * 1-based rank in the ACTUAL completion sequence across the whole session —
   * derived from `completed_at`, independent of programmed exercise/set order
   * (#1792). Two rows saved in the same request (e.g. an L/R pair) share a
   * timestamp and get consecutive ranks in read order, not a tie. Null when
   * the set was never completed (no `completed_at`).
   */
  completionOrder: number | null
}

/** One exercise block in a session detail (its sets, in order). */
export interface SessionDetailExercise {
  /** The session-level grip; each set inherits any field it doesn't set. */
  grip: GripSpec
  workoutExerciseId: string
  exerciseId: string
  name: string
  tracks: string
  loadBasis: 'total' | 'per_side'
  primaryMuscle: string | null
  supersetGroup: number | null
  notes: string | null
  sets: SessionDetailSet[]
  /**
   * First-to-last `completed_at` span across this exercise's completed WORKING
   * sets (warmups excluded — same convention as every other aggregate in this
   * file), in whole seconds (#1792). Null with fewer than two timestamps: one
   * data point has no duration to report, and 0 would falsely claim it was
   * measured.
   */
  durationSeconds: number | null
}

export interface SessionDetail {
  id: string
  name: string | null
  /** ISO started_at. */
  date: string
  durationSeconds: number | null
  notes: string | null
  templateId: string | null
  templateName: string | null
  exerciseCount: number
  /** Working (non-warmup) set count. */
  setCount: number
  volumeLb: number
  volume: number
  weightUnit: WeightUnit
  exercises: SessionDetailExercise[]
  /**
   * Pairs of exercises whose completed WORKING sets interleaved in time —
   * evidence the user supersetted them in practice, whether or not either
   * exercise's programmed `superset_group` agrees (#1792, the actual prize
   * in the issue). Observation only, never written back: an engine once
   * clobbered an explicit `superset_group` (#1838) and the user's own grouping is
   * his statement of intent. Empty when no pair clears the threshold.
   */
  performedSupersets: PerformedSuperset[]
}

// ---------------------------------------------------------------------------
// Performed order, duration, and superset detection — all DERIVED from
// completed_at, never a separate write (#1792).
// ---------------------------------------------------------------------------

/** One completed set as the detectors below see it. */
export interface PerformedSetInput {
  workoutExerciseId: string
  setId: string
  completedAt: string
}

/** 1-based completion-order rank for every set passed in, keyed by set id.
 * Input need not be pre-sorted; ties (identical `completed_at`) keep their
 * relative input order (Array#sort is stable), so an L/R pair saved together
 * gets consecutive ranks rather than an arbitrary shuffle. */
export function rankCompletionOrder(sets: PerformedSetInput[]): Map<string, number> {
  const ordered = [...sets].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
  const order = new Map<string, number>()
  ordered.forEach((s, i) => order.set(s.setId, i + 1))
  return order
}

/** First-to-last span across a set of ISO timestamps, in whole seconds. Null
 * with fewer than two — see SessionDetailExercise.durationSeconds. */
export function completedSpanSeconds(completedAts: string[]): number | null {
  if (completedAts.length < 2) return null
  const times = completedAts.map((t) => Date.parse(t))
  return Math.round((Math.max(...times) - Math.min(...times)) / 1000)
}

/**
 * Shortest alternating run that counts as a genuine PERFORMED superset, not a
 * single revisit. A,B,A (3 sets) is indistinguishable from wandering back to a
 * machine once; A,B,A,B (4) means the pattern repeated — The user actually cycled
 * between the two exercises rather than just returning to one.
 */
export const MIN_ALTERNATING_SETS = 4

/**
 * Longest gap between two alternating sets that still counts as "the same
 * circuit", in seconds. Rest between working sets rarely runs past a few
 * minutes even for heavy compounds, so 5 minutes is generous headroom for
 * walking between stations while still excluding an exercise pair that
 * happened to alternate once early in the session and again much later —
 * two separate blocks, not one continuous superset.
 */
export const MAX_TRANSITION_GAP_SECONDS = 300

/** One detected performed superset: two exercises whose completed sets
 * interleaved in time (see SessionDetail.performedSupersets). */
export interface PerformedSuperset {
  exerciseAId: string
  exerciseAName: string
  exerciseBId: string
  exerciseBName: string
  /** Length of the longest qualifying alternating run (>= MIN_ALTERNATING_SETS). */
  alternatingSets: number
}

export interface ExerciseForDetection {
  workoutExerciseId: string
  name: string
  /** Completed WORKING sets only (warmups excluded), any order. */
  completedSets: PerformedSetInput[]
}

/** Longest run of strictly-alternating, closely-spaced entries in a
 * chronologically-sorted two-exercise sequence. A big gap or two consecutive
 * same-exercise entries breaks the run (resets to 1) rather than ending
 * detection outright — a later stretch of the same pair can still qualify. */
function longestAlternatingRun(seq: PerformedSetInput[]): number {
  if (seq.length === 0) return 0
  let best = 1
  let current = 1
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1]!
    const curr = seq[i]!
    const gapSeconds = (Date.parse(curr.completedAt) - Date.parse(prev.completedAt)) / 1000
    const alternates = curr.workoutExerciseId !== prev.workoutExerciseId
    current = alternates && gapSeconds <= MAX_TRANSITION_GAP_SECONDS ? current + 1 : 1
    best = Math.max(best, current)
  }
  return best
}

/**
 * Pairwise performed-superset detection (#1792): for every pair of exercises
 * in the session, merge their completed working sets in time order and look
 * for a run of >= MIN_ALTERNATING_SETS strictly-alternating, closely-spaced
 * (<= MAX_TRANSITION_GAP_SECONDS) sets. A single back-and-forth is excluded by
 * construction (see MIN_ALTERNATING_SETS) — this only fires on a REPEATED
 * cycle. Pure and exported for direct unit testing.
 */
export function detectPerformedSupersets(exercises: ExerciseForDetection[]): PerformedSuperset[] {
  const found: PerformedSuperset[] = []
  for (let i = 0; i < exercises.length; i++) {
    for (let j = i + 1; j < exercises.length; j++) {
      const a = exercises[i]!
      const b = exercises[j]!
      if (a.completedSets.length === 0 || b.completedSets.length === 0) continue
      const merged = [...a.completedSets, ...b.completedSets].sort(
        (x, y) => Date.parse(x.completedAt) - Date.parse(y.completedAt),
      )
      if (merged.length < MIN_ALTERNATING_SETS) continue
      const run = longestAlternatingRun(merged)
      if (run >= MIN_ALTERNATING_SETS) {
        found.push({
          exerciseAId: a.workoutExerciseId,
          exerciseAName: a.name,
          exerciseBId: b.workoutExerciseId,
          exerciseBName: b.name,
          alternatingSets: run,
        })
      }
    }
  }
  return found
}

function num(v: string | null): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Load one COMPLETED session's full set log grouped by exercise, or null when the
 * id doesn't exist / isn't completed (the route 404s). §3b: the workout join is
 * status-gated so an active/discarded workout never resolves here. Volume + working
 * set count are computed in TS from the same exclusions as the aggregate SQL.
 */
export async function readSessionDetail(
  workoutId: string,
  displayUnit: WeightUnit = 'lb',
): Promise<SessionDetail | null> {
  const [w] = (
    await db.execute(sql`
      SELECT w.id, w.name, w.started_at::text AS started_at, w.duration_seconds,
        w.notes, w.template_id, t.name AS template_name
      FROM workouts w
      LEFT JOIN workout_templates t ON t.id = w.template_id
      WHERE w.id = ${workoutId} AND w.status = 'completed'
      LIMIT 1
    `)
  ).rows as unknown as Array<{
    id: string
    name: string | null
    started_at: string
    duration_seconds: number | null
    notes: string | null
    template_id: string | null
    template_name: string | null
  }>
  if (!w) return null

  const rows = (
    await db.execute(sql`
      SELECT we.id AS workout_exercise_id, we.exercise_id, we.position,
        we.superset_group, we.notes AS we_notes,
        we.grip_width AS we_grip_width, we.grip_orientation AS we_grip_orientation,
        we.attachment AS we_attachment,
        e.name, e.tracks, e.load_basis, e.primary_muscle,
        ws.id AS set_id,
        ws.grip_width, ws.grip_orientation, ws.attachment,
        ws.set_number, ws.set_type, ws.weight::text AS weight, ws.weight_unit AS unit,
        ws.reps, ws.distance_m::text AS distance_m, ws.duration_s, ws.rpe::text AS rpe,
        ws.rest_seconds, ws.side, ws.logical_set_id::text AS logical_set_id, ws.completed,
        -- Raw completion timestamp (#1792): the ordering signal behind
        -- completionOrder, exercise durationSeconds, and performedSupersets
        -- detection below — all computed in TS from this one column.
        ws.completed_at::text AS completed_at,
        -- Seconds since the PREVIOUS completed set in this session (#1835).
        -- Computed in SQL so every reader gets the same number.
        EXTRACT(EPOCH FROM (
          ws.completed_at - LAG(ws.completed_at) OVER (
            PARTITION BY we.workout_id ORDER BY ws.completed_at
          )
        ))::int AS seconds_since_previous_set
      FROM workout_exercises we
      JOIN exercises e ON e.id = we.exercise_id
      LEFT JOIN workout_sets ws ON ws.workout_exercise_id = we.id
      WHERE we.workout_id = ${workoutId}
      ORDER BY we.position, we.id, ws.set_number
    `)
  ).rows as unknown as Array<{
    workout_exercise_id: string
    exercise_id: string
    position: number
    superset_group: number | null
    we_notes: string | null
    name: string
    tracks: string
    load_basis: string
    primary_muscle: string | null
    we_grip_width: string | null
    we_grip_orientation: string | null
    we_attachment: string | null
    grip_width: string | null
    grip_orientation: string | null
    attachment: string | null
    set_id: string | null
    set_number: number | null
    set_type: string | null
    weight: string | null
    unit: string | null
    reps: number | null
    distance_m: string | null
    duration_s: number | null
    rpe: string | null
    rest_seconds: number | null
    completed_at: string | null
    seconds_since_previous_set: number | null
    side: string | null
    logical_set_id: string | null
    completed: boolean | null
  }>

  const exercises: SessionDetailExercise[] = []
  const byWe = new Map<string, SessionDetailExercise>()
  const workingLogicalSets = new Set<string>()
  // Raw completed_at per physical set row, keyed by the same id exposed on
  // SessionDetailSet — feeds completionOrder/durationSeconds/performedSupersets
  // below (#1792). Kept out of the SessionDetailSet contract itself: those three
  // derived fields are the useful signal, an absolute timestamp isn't.
  const completedAtBySetId = new Map<string, string>()
  let volumeLb = 0

  for (const r of rows) {
    let block = byWe.get(r.workout_exercise_id)
    if (!block) {
      block = {
        workoutExerciseId: r.workout_exercise_id,
        exerciseId: r.exercise_id,
        name: displayExerciseName(r.name),
        tracks: r.tracks,
        loadBasis: r.load_basis === 'per_side' ? 'per_side' : 'total',
        primaryMuscle: r.primary_muscle,
        supersetGroup: r.superset_group,
        notes: r.we_notes,
        grip: toGripSpec({
          grip_width: r.we_grip_width,
          grip_orientation: r.we_grip_orientation,
          attachment: r.we_attachment,
        }),
        sets: [],
        durationSeconds: null,
      }
      byWe.set(r.workout_exercise_id, block)
      exercises.push(block)
    }
    // A LEFT JOIN row with no set (exercise had zero sets logged) → skip the set.
    if (r.set_number == null) continue

    const weight = num(r.weight)
    const reps = r.reps
    const setType = r.set_type ?? 'normal'
    const logicalSetId = r.logical_set_id ?? r.set_id ?? `${r.workout_exercise_id}:${r.set_number}`
    block.sets.push({
      // Resolved, not raw — see SessionDetailSet.grip.
      grip: resolveGrip(toGripSpec(r), block.grip),
      id: r.set_id ?? `${r.workout_exercise_id}:${r.set_number}`,
      setNumber: r.set_number,
      setType,
      weight: convertStoredWeight(weight, r.unit, displayUnit),
      unit: displayUnit,
      reps,
      distanceM: num(r.distance_m),
      durationS: r.duration_s,
      rpe: num(r.rpe),
      restSeconds: r.rest_seconds,
      secondsSincePreviousSet: r.seconds_since_previous_set,
      side: r.side === 'left' || r.side === 'right' ? r.side : null,
      logicalSetId,
      completed: r.completed === true,
      // Filled in below, once every row has been read (#1792).
      completionOrder: null,
    })
    if (r.completed === true && r.completed_at) {
      completedAtBySetId.set(r.set_id ?? `${r.workout_exercise_id}:${r.set_number}`, r.completed_at)
    }

    if (r.completed === true && setType !== 'warmup') {
      workingLogicalSets.add(logicalSetId)
      // Volume: same exclusions as volumeExpr (weight_reps/weighted only; >0 both).
      if (
        (r.tracks === 'weight_reps' || r.tracks === 'weighted_bodyweight') &&
        weight != null && weight > 0 &&
        reps != null && reps > 0
      ) {
        const sideFactor = r.load_basis === 'per_side' && r.side == null ? 2 : 1
        volumeLb += (convertStoredWeight(weight, r.unit, 'lb') ?? 0) * reps * sideFactor
      }
    }
  }

  // Completion order (#1792): rank EVERY completed set (warmups included — this
  // is a plain sequencing fact, not a performance aggregate) by completed_at
  // across the whole session, independent of the we.position/set_number the
  // rows were read in above.
  const allCompletedSets: PerformedSetInput[] = []
  for (const ex of exercises) {
    for (const s of ex.sets) {
      const completedAt = completedAtBySetId.get(s.id)
      if (completedAt) allCompletedSets.push({ workoutExerciseId: ex.workoutExerciseId, setId: s.id, completedAt })
    }
  }
  const completionOrder = rankCompletionOrder(allCompletedSets)
  for (const ex of exercises) {
    for (const s of ex.sets) {
      s.completionOrder = completionOrder.get(s.id) ?? null
    }
  }

  // Exercise duration + performed-superset detection (#1792) both use only
  // completed WORKING sets — same warmup exclusion as volume/setCount above.
  const workingCompletedSets: ExerciseForDetection[] = exercises.map((ex) => ({
    workoutExerciseId: ex.workoutExerciseId,
    name: ex.name,
    completedSets: ex.sets
      .filter((s) => s.completed && s.setType !== 'warmup' && completedAtBySetId.has(s.id))
      .map((s) => ({
        workoutExerciseId: ex.workoutExerciseId,
        setId: s.id,
        completedAt: completedAtBySetId.get(s.id)!,
      })),
  }))
  exercises.forEach((ex, i) => {
    ex.durationSeconds = completedSpanSeconds(workingCompletedSets[i]!.completedSets.map((s) => s.completedAt))
  })
  const performedSupersets = detectPerformedSupersets(workingCompletedSets)

  const roundedVolumeLb = Math.round(volumeLb)
  return {
    id: w.id,
    name: w.name,
    date: w.started_at,
    durationSeconds: w.duration_seconds,
    notes: w.notes,
    templateId: w.template_id,
    templateName: w.template_name,
    exerciseCount: exercises.length,
    setCount: workingLogicalSets.size,
    volumeLb: roundedVolumeLb,
    volume: displayVolume(roundedVolumeLb, displayUnit),
    weightUnit: displayUnit,
    exercises,
    performedSupersets,
  }
}
