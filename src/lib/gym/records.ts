/**
 * Per-exercise records + chart aggregation — the load-bearing PR math for the Gym
 * Exercises-detail surface (GYM_PLAN §3a). PURE functions (no DB, no LLM): a route
 * fetches raw set rows, these turn them into records/history/charts. Tested
 * thoroughly because a wrong PR is a wrong motivational surface.
 *
 * NUMERICAL CONSISTENCY: Epley e1RM = weight × (1 + reps/30), the exact formula
 * lib/health/training.ts (`prs()`) and lib/goals/health-signals.ts use — so a PR
 * shown here can never disagree with a goal signal.
 *
 * EXCLUSIONS (GYM_PLAN §3a, made deliberate + tested here):
 *   - set_type 'warmup'         → excluded from ALL records + volume.
 *   - drop / failure sets       → COUNT as working sets (real work).
 *   - tracks 'assisted_bodyweight' → excluded from volume AND e1RM (assistance is
 *       not load). Best least-assistance weight + repMaxes still compute.
 *   - tracks 'weighted_bodyweight' → volume counts the ADDED weight only; excluded
 *       from e1RM in v1 (no bodyweight assumption). bestWeight + repMaxes compute.
 *   - tracks 'reps'             → repMaxes only (max reps; no weight records).
 *   - tracks 'time'             → best duration (+ optional weight ignored for records).
 *   - tracks 'distance_time'    → best distance + best pace.
 *   - weight-based records require reps > 0 AND weight > 0.
 *
 * MIXED UNITS: weight is stored per row in its own unit. When one exercise's
 * history mixes lb and kg rows, every weight is converted to lb (kg → lb ×2.20462)
 * and records report unit 'lb'. Display-side conversion back to a preferred unit is
 * the UI's job; this module never guesses a preference.
 */

import {
  loadVolume,
  logicalSetKey,
  normalizeLoadBasis,
  normalizeSetSide,
  type LoadBasis,
  type SetSide,
} from './load-semantics'
import { EMPTY_GRIP, gripKey, gripLabel, type GripSpec } from './grip'

/** Epley e1RM. Matches training.ts exactly (weight × (1 + reps/30)). */
export function epley(weightLb: number, reps: number): number {
  return weightLb * (1 + reps / 30)
}

export const KG_TO_LB = 2.20462

/** Convert a stored weight to lb. lb passes through; kg scales; anything else is
 *  treated as lb (imports are lb; the app stores lb|kg only). */
export function toLb(weight: number, unit: string | null | undefined): number {
  return unit === 'kg' ? weight * KG_TO_LB : weight
}

/** The six measurement models an exercise can carry (mirrors catalog TRACKS). */
export type Tracks =
  | 'weight_reps'
  | 'weighted_bodyweight'
  | 'assisted_bodyweight'
  | 'reps'
  | 'time'
  | 'distance_time'

export type SetType = 'warmup' | 'normal' | 'drop' | 'failure' | string

/** A raw logged set as the route hands it in (weight in its stored unit). */
export interface SetInput {
  setType: SetType
  weight: number | null
  unit: string | null
  reps: number | null
  distanceM: number | null
  durationS: number | null
  /** Entered-load convention for this exercise. Omitted legacy callers default
   * to `total`, preserving all pre-unilateral behavior. */
  loadBasis?: LoadBasis
  /** NULL means Both/not-applicable; explicit L/R rows each contribute one side. */
  side?: SetSide
  /** Split L/R rows share this id so their contributions form one logical set. */
  logicalSetId?: string | null
  /** ISO date (workout day) — dated onto every derived record. */
  date: string
  /**
   * How it was held, already RESOLVED (set override over exercise default).
   * Omitted by callers that predate grip; those sets group under
   * `unspecified`, which is real history that stays in the overall totals but
   * cannot be compared handle-to-handle.
   */
  grip?: GripSpec
}

export interface WeightRecord {
  value: number
  unit: 'lb'
  reps: number
  date: string
}
export interface E1rmRecord {
  value: number
  unit: 'lb'
  weight: number
  reps: number
  date: string
}
export interface VolumeRecord {
  value: number
  unit: 'lb'
  weight: number
  reps: number
  date: string
}
export interface RepMaxEntry {
  reps: number
  weight: number
  unit: 'lb'
  date: string
}
export interface DurationRecord {
  /** Best (longest) duration in seconds. */
  value: number
  date: string
}
export interface DistanceRecord {
  /** Best (longest) distance in meters. */
  value: number
  /** Best pace on that record, seconds per meter (lower = faster), if a duration
   *  was logged alongside; null otherwise. */
  paceSecPerM: number | null
  date: string
}

export interface Records {
  bestWeight: WeightRecord | null
  bestE1rm: E1rmRecord | null
  bestSetVolume: VolumeRecord | null
  /** Best weight at each rep count 1..12 that has data, ascending by reps. */
  repMaxes: RepMaxEntry[]
  /** True when e1RM is deliberately not computed for this track (assisted /
   *  weighted bodyweight / reps / time / distance). */
  excludedFromE1rm: boolean
  /** Time-track only: best (longest) duration. */
  bestDuration: DurationRecord | null
  /** Distance-track only: best distance + its pace. */
  bestDistance: DistanceRecord | null
}

/**
 * Per-grip bests — the same records, computed over just the sets done one way.
 *
 * The user asked for one continuous history PLUS a best per handle, which is why
 * this sits ALONGSIDE `computeRecords` rather than replacing it: splitting the
 * exercise would break the trend line the moment he switched attachments, and
 * that is the whole reason grip is an attribute and not a catalog row.
 */
export interface GripRecords {
  /** `gripKey` — stable grouping id; `unspecified` for sets with no grip. */
  key: string
  grip: GripSpec
  /** Human label, or null for the unspecified bucket. */
  label: string | null
  /** Working sets in this group. */
  sets: number
  /** Distinct workout days in this group. */
  sessions: number
  records: Records
}

/**
 * A group needs this many working sets AND this many separate days before its
 * best is shown.
 *
 * Below the bar it is one good day, not a record, and printing it would be
 * flattering noise on exactly the sparse groups a newly-tried handle produces.
 * Both conditions are necessary: six sets in one session is still one session,
 * and two sessions of one set each has not yet found a top set on that handle.
 */
export const GRIP_RECORD_MIN_SETS = 6
export const GRIP_RECORD_MIN_SESSIONS = 2

export function computeRecordsByGrip(sets: SetInput[], tracks: Tracks): GripRecords[] {
  const groups = new Map<string, SetInput[]>()
  for (const set of sets) {
    if (!isWorking(set.setType)) continue
    const key = gripKey(set.grip ?? EMPTY_GRIP)
    const bucket = groups.get(key)
    if (bucket) bucket.push(set)
    else groups.set(key, [set])
  }

  const out: GripRecords[] = []
  for (const [key, groupSets] of groups) {
    const sessions = new Set(groupSets.map((s) => s.date)).size
    if (groupSets.length < GRIP_RECORD_MIN_SETS || sessions < GRIP_RECORD_MIN_SESSIONS) continue
    const grip = groupSets[0]!.grip ?? EMPTY_GRIP
    out.push({
      key,
      grip,
      label: gripLabel(grip),
      sets: groupSets.length,
      sessions,
      records: computeRecords(groupSets, tracks),
    })
  }
  // Most-trained first: the handle he actually uses should lead.
  return out.sort((a, b) => b.sets - a.sets || a.key.localeCompare(b.key))
}

/** A working set = anything that isn't a warmup (drop + failure count). */
function isWorking(setType: SetType): boolean {
  return setType !== 'warmup'
}

/** Does this track contribute to weight-based records at all? reps/time/distance
 *  carry no meaningful weight PR. */
function hasWeightRecords(tracks: Tracks): boolean {
  return (
    tracks === 'weight_reps' ||
    tracks === 'weighted_bodyweight' ||
    tracks === 'assisted_bodyweight'
  )
}

interface NormalizedWeightSet {
  weightLb: number
  reps: number
  date: string
  loadBasis: LoadBasis
  side: SetSide
  logicalSetId: string | null
  rowIndex: number
}

/** Validate and normalize loaded rows once. Weight/e1RM stay at the entered
 * per-side value; volume is the only metric that applies side semantics. */
function normalizedWeightSets(sets: SetInput[]): NormalizedWeightSet[] {
  return sets.flatMap((set, rowIndex) => {
    if (set.reps == null || set.reps <= 0 || set.weight == null || set.weight <= 0) return []
    return [{
      weightLb: toLb(set.weight, set.unit),
      reps: set.reps,
      date: set.date,
      loadBasis: normalizeLoadBasis(set.loadBasis),
      side: normalizeSetSide(set.side),
      logicalSetId: set.logicalSetId ?? null,
      rowIndex,
    }]
  })
}

interface LogicalVolume {
  value: number
  weightLb: number
  reps: number
  date: string
}

/** Aggregate row contributions into logical sets. A Both row contributes two
 * sides by itself; paired explicit L/R rows contribute once each and share a key. */
function logicalVolumes(sets: NormalizedWeightSet[]): LogicalVolume[] {
  const grouped = new Map<string, LogicalVolume>()
  for (const set of sets) {
    const key = logicalSetKey(set.logicalSetId, set.rowIndex)
    const contribution = loadVolume(set.weightLb, set.reps, set.loadBasis, set.side)
    const current = grouped.get(key)
    if (current) current.value += contribution
    else {
      grouped.set(key, {
        value: contribution,
        weightLb: set.weightLb,
        reps: set.reps,
        date: set.date,
      })
    }
  }
  return [...grouped.values()]
}

/**
 * Compute the full records block for one exercise from its raw set rows. A strictly
 * greater value wins, so on an exact tie the FIRST set seen for that value keeps the
 * record (the detail query feeds sets newest-first, so a tie shows the newest date).
 */
export function computeRecords(sets: SetInput[], tracks: Tracks): Records {
  const working = sets.filter((s) => isWorking(s.setType))

  const excludedFromE1rm = tracks !== 'weight_reps'
  const records: Records = {
    bestWeight: null,
    bestE1rm: null,
    bestSetVolume: null,
    repMaxes: [],
    excludedFromE1rm,
    bestDuration: null,
    bestDistance: null,
  }

  // ---- time / distance tracks: duration + distance records, nothing else. ----
  if (tracks === 'time') {
    for (const s of working) {
      if (s.durationS == null || s.durationS <= 0) continue
      if (!records.bestDuration || s.durationS > records.bestDuration.value) {
        records.bestDuration = { value: s.durationS, date: s.date }
      }
    }
    return records
  }
  if (tracks === 'distance_time') {
    for (const s of working) {
      if (s.distanceM == null || s.distanceM <= 0) continue
      const pace = s.durationS != null && s.durationS > 0 ? s.durationS / s.distanceM : null
      if (!records.bestDistance || s.distanceM > records.bestDistance.value) {
        records.bestDistance = { value: s.distanceM, paceSecPerM: pace, date: s.date }
      }
    }
    return records
  }

  // ---- reps-only: max-reps table, no weight/e1RM/volume. ----
  if (tracks === 'reps') {
    records.repMaxes = repMaxTable(
      working.filter((s) => s.reps != null && s.reps > 0),
      // reps-track "repMax" is best reps; there's no weight — record weight 0.
      () => 0,
    )
    return records
  }

  // ---- weight-bearing tracks (weight_reps / weighted / assisted). ----
  if (!hasWeightRecords(tracks)) return records

  // Valid weight sets: reps>0 AND weight>0 (assistance stored positive). Convert
  // to lb up front so mixed-unit history is comparable.
  const weightSets = normalizedWeightSets(working)

  for (const s of weightSets) {
    // bestWeight: for assisted, "best" is LEAST assistance = smallest stored
    // positive weight; for the rest, heaviest. bestWeight computes for all three.
    const better =
      records.bestWeight == null ||
      (tracks === 'assisted_bodyweight'
        ? s.weightLb < records.bestWeight.value
        : s.weightLb > records.bestWeight.value)
    if (better) {
      records.bestWeight = { value: s.weightLb, unit: 'lb', reps: s.reps, date: s.date }
    }
  }

  // e1RM only for plain weight_reps (weighted/assisted excluded in v1).
  if (tracks === 'weight_reps') {
    for (const s of weightSets) {
      const e = epley(s.weightLb, s.reps)
      if (records.bestE1rm == null || e > records.bestE1rm.value) {
        records.bestE1rm = {
          value: e,
          unit: 'lb',
          weight: s.weightLb,
          reps: s.reps,
          date: s.date,
        }
      }
    }
  }

  // set volume: weight×reps. weighted_bodyweight counts ADDED weight only (which
  // is exactly the stored weight); assisted excluded (assistance isn't load).
  if (tracks === 'weight_reps' || tracks === 'weighted_bodyweight') {
    for (const set of logicalVolumes(weightSets)) {
      if (records.bestSetVolume == null || set.value > records.bestSetVolume.value) {
        records.bestSetVolume = {
          value: set.value,
          unit: 'lb',
          weight: set.weightLb,
          reps: set.reps,
          date: set.date,
        }
      }
    }
  }

  // rep-max table (best weight at each rep 1..12). Assisted: "best" = least
  // assistance (min weight); the rest: heaviest (max weight).
  records.repMaxes = repMaxTable(
    working.filter(
      (s) => s.reps != null && s.reps > 0 && s.weight != null && s.weight > 0 && s.reps! <= 12,
    ),
    (s) => toLb(s.weight!, s.unit),
    tracks === 'assisted_bodyweight' ? 'min' : 'max',
  )

  return records
}

/**
 * Best weight at each rep count 1..12 that has any data, ascending by reps. For
 * `reps`-track exercises there is no weight, so `weightOf` returns 0 and the table
 * is effectively "these rep counts were hit". `mode` picks heaviest (max) or, for
 * assisted, least-assistance (min).
 */
function repMaxTable(
  sets: SetInput[],
  weightOf: (s: SetInput) => number,
  mode: 'max' | 'min' = 'max',
): RepMaxEntry[] {
  const best = new Map<number, { weight: number; date: string }>()
  for (const s of sets) {
    if (s.reps == null || s.reps <= 0 || s.reps > 12) continue
    const w = weightOf(s)
    const cur = best.get(s.reps)
    const better = !cur || (mode === 'min' ? w < cur.weight : w > cur.weight)
    if (better) best.set(s.reps, { weight: w, date: s.date })
  }
  return [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([reps, v]) => ({ reps, weight: v.weight, unit: 'lb' as const, date: v.date }))
}

// ---------------------------------------------------------------------------
// Charts: per-workout-day aggregates over the full history, chronological.
// ---------------------------------------------------------------------------

export interface ChartPoint {
  date: string
  value: number
}
export interface Charts {
  /** Best working-set e1RM that day (weight_reps only; empty for other tracks). */
  e1rm: ChartPoint[]
  /** Total working volume that day (Σ weight×reps in lb; added weight for weighted). */
  volume: ChartPoint[]
  /** Best working single-set volume that day. */
  bestSet: ChartPoint[]
}

/**
 * Per-day chart series. Groups working sets by day, then per day: best e1RM,
 * total volume, best single-set volume — same track exclusions as records. Points
 * are chronological. Days with no qualifying set produce no point on that series.
 */
export function computeCharts(sets: SetInput[], tracks: Tracks): Charts {
  const charts: Charts = { e1rm: [], volume: [], bestSet: [] }
  if (!hasWeightRecords(tracks)) return charts

  const byDay = new Map<string, NormalizedWeightSet[]>()
  for (const set of normalizedWeightSets(sets.filter((candidate) => isWorking(candidate.setType)))) {
    const arr = byDay.get(set.date) ?? []
    arr.push(set)
    byDay.set(set.date, arr)
  }

  const days = [...byDay.keys()].sort()
  const countsVolume = tracks === 'weight_reps' || tracks === 'weighted_bodyweight'
  const countsE1rm = tracks === 'weight_reps'

  for (const day of days) {
    const daySets = byDay.get(day)!
    if (countsE1rm) {
      const best = Math.max(...daySets.map((s) => epley(s.weightLb, s.reps)))
      charts.e1rm.push({ date: day, value: round1(best) })
    }
    if (countsVolume) {
      const total = daySets.reduce(
        (sum, set) => sum + loadVolume(set.weightLb, set.reps, set.loadBasis, set.side),
        0,
      )
      charts.volume.push({ date: day, value: round1(total) })
      const best = Math.max(...logicalVolumes(daySets).map((set) => set.value))
      charts.bestSet.push({ date: day, value: round1(best) })
    }
  }
  return charts
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
