/**
 * Client-side type contract for the Gym Exercises surfaces (GYM_PLAN §4 "Tab:
 * Exercises" + §5). These mirror the API routes being built IN PARALLEL to the
 * exact shapes in GYM_PLAN's API-contract block — treat every field as
 * load-bearing; renaming one breaks the seam with the route agent.
 *
 *   GET  /api/gym/exercises?q=&muscle=&equipment=&filter=&limit=&offset= → ExerciseListResponse
 *   GET  /api/gym/exercises/[id]                                         → ExerciseDetailResponse
 *   POST /api/gym/exercises {name}                                       → ExerciseCreateResponse
 *   PATCH /api/gym/exercises/[id] {…prefs}                              → { exercise: ExerciseDetail }
 *   image URLs: /api/gym/exercise-image/<images[i]>
 */

import type { MuscleRegion } from '@/lib/fitness/muscles'
import type { DistanceUnit } from '@/lib/units/system'

/** A muscle region lit on the mini map, with its credit weight (1 primary / 0.5 secondary). */
export interface ExerciseRegionHit {
  region: MuscleRegion
  label: string
  /** 1 = primary mover, 0.5 = secondary/assisting. */
  weight: number
}

/** How an exercise is measured — drives which record/chart fields are meaningful. */
export type ExerciseTracks =
  | 'weight_reps'
  | 'weighted_bodyweight'
  | 'assisted_bodyweight'
  | 'reps'
  | 'time'
  | 'distance_time'

export type PreferredUnit = 'lb' | 'kg'
export type LoadBasis = 'total' | 'per_side'

/** Programming axis (GYM_PLAN §10b.1) — what readiness/analytics/coach filter on. */
export type ExerciseModality = 'strength' | 'stretch' | 'dynamic' | 'soft_tissue' | 'cardio'

/** A row in the Exercises list (GET /api/gym/exercises). */
export interface ExerciseListItem {
  id: string
  name: string
  category: string | null
  equipment: string | null
  primaryMuscle: string | null
  secondaryMuscles: string[]
  regions: ExerciseRegionHit[]
  tracks: ExerciseTracks
  /** Optional client-side: a bundle may be newer/older than the server during
   *  rollout — absent reads as 'strength'. */
  modality?: ExerciseModality
  /** Unilateral mobility work the logger pairs as L/R (M3). Absent = false. */
  perSide?: boolean
  isCustom: boolean
  aiFilled: boolean
  tracked: boolean
  disliked: boolean
  /** All-time completed-set count. */
  sets: number
  /** ISO date of the last time this was performed, or null. */
  lastPerformed: string | null
  hasImages: boolean
  slug: string | null
  /** Exact proxy-relative image path from the exercise row. */
  imagePath: string | null
}

export interface ExerciseListResponse {
  exercises: ExerciseListItem[]
  total: number
}

/** The full detail object (extends the list item with the heavy fields). */
export interface ExerciseDetail extends ExerciseListItem {
  instructions: string[]
  /** Image paths (relative to /api/gym/exercise-image/), e.g. "Incline_Dumbbell_Press/0.jpg". */
  images: string[]
  defaultRestSeconds: number | null
  restSecondsWarmup: number | null
  preferredUnit: PreferredUnit | null
  /** Total means one entered number is the whole set; per_side means per arm/leg. */
  loadBasis: LoadBasis
  dislikeReason: string | null
  /** FEDB metadata (may be absent for custom/LLM-filled rows); rendered as chips. */
  level?: string | null
  force?: string | null
  mechanic?: string | null
}

/** A single personal record (weight/e1RM/set-volume). */
export interface ExerciseRecord {
  value: number
  unit: string
  weight: number
  reps: number
  date: string
}

/** Best-weight record has no `weight` field of its own (the value IS the weight). */
export interface BestWeightRecord {
  value: number
  unit: string
  reps: number
  date: string
}

export interface RepMaxRow {
  reps: number
  weight: number
  unit: string
  date: string
}

export interface DurationRecord {
  value: number
  date: string
}
export interface DistanceRecord {
  value: number
  paceSecPerM: number | null
  date: string
}

export interface ExerciseRecords {
  bestWeight: BestWeightRecord | null
  bestE1rm: ExerciseRecord | null
  bestSetVolume: ExerciseRecord | null
  repMaxes: RepMaxRow[]
  /** e1RM PRs are not computed for assisted/timed movements. */
  excludedFromE1rm: boolean
  bestDuration?: DurationRecord | null
  bestDistance?: DistanceRecord | null
}

export type SetType = 'warmup' | 'normal' | 'drop' | 'failure'

export interface HistorySet {
  setNumber: number
  setType: SetType
  weight: number | null
  unit: string
  reps: number | null
  distanceM: number | null
  durationS: number | null
  rpe: number | null
  side: 'left' | 'right' | null
  logicalSetId: string
}

export interface HistorySession {
  workoutId: string
  date: string
  workoutName: string | null
  sets: HistorySet[]
}

/** A single point on a per-exercise chart (e1RM / volume / best-set trend). */
export interface ChartPoint {
  date: string
  value: number
}

export interface ExerciseCharts {
  e1rm: ChartPoint[]
  volume: ChartPoint[]
  bestSet: ChartPoint[]
}

export interface ExerciseDetailResponse {
  exercise: ExerciseDetail
  /** Global display unit applied consistently to records, history, and charts. */
  weightUnit?: PreferredUnit
  distanceUnit?: DistanceUnit
  records: ExerciseRecords
  /**
   * Bests for each way the movement was held, once a group has enough logged
   * work to mean something. Empty for every exercise done only one way, and
   * for all history predating grip — so a surface must treat "no entries" as
   * normal, not as missing data.
   */
  gripRecords?: GripRecordsSummary[]
  history: HistorySession[]
  charts: ExerciseCharts
}

export interface GripRecordsSummary {
  key: string
  /** Human label; null for the bucket of sets with no grip recorded. */
  label: string | null
  sets: number
  sessions: number
  records: ExerciseRecords
}

export interface ExerciseCreateResponse {
  exercise: ExerciseDetail
  created: boolean
  aiFilled: boolean
}

/** The mutable per-exercise preferences a PATCH can set. */
export interface ExercisePatch {
  disliked?: boolean
  dislikeReason?: string | null
  defaultRestSeconds?: number | null
  restSecondsWarmup?: number | null
  preferredUnit?: PreferredUnit
  loadBasis?: LoadBasis
  tracked?: boolean
  /** Temporary staleness cooldown in days (the "Bored of it" reason chip); 0/null
   *  clears it. Distinct from the hard `disliked`. */
  snoozeDays?: number | null
}

/** A durable, reversible rule that normalizes combined Strong weights to per-side. */
export interface LoadCorrection {
  id: string
  exerciseId: string
  source: 'strong-import'
  startDate: string | null
  endDate: string | null
  divisor: number
  previousLoadBasis: LoadBasis
  reason: string | null
  active: boolean
  affectedSets: number
  createdAt: string
  revertedAt: string | null
}

export interface LoadCorrectionPreview {
  exerciseId: string
  source: 'strong-import'
  startDate: string | null
  endDate: string | null
  divisor: number
  affectedSets: number
  firstDate: string | null
  lastDate: string | null
  rawWeightTotal: number
  correctedWeightTotal: number
  minRawWeight: number | null
  maxRawWeight: number | null
  minCorrectedWeight: number | null
  maxCorrectedWeight: number | null
  rawVolume: number
  correctedMatchedVolume: number
}

/** The list-query filter chips (single-select toggle in the tab). */
export type ExerciseFilter = 'custom' | 'disliked' | 'tracked'

export interface ExerciseQuery {
  q?: string
  muscle?: MuscleRegion | null
  equipment?: string | null
  filter?: ExerciseFilter | null
  limit?: number
  offset?: number
}
