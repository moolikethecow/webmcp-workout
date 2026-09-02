import type { MuscleRegion } from '@/lib/fitness/muscles'

import { resolveProposalSetPrescriptions, type ProposalSetPrescription } from './proposal-payload'

export type ProgrammingGoal = 'balanced' | 'strength' | 'hypertrophy' | 'endurance' | 'power'
export type ProgrammingOrder = 'fatigue_aware' | 'preserve'
export type ProgrammingSupersets = 'off' | 'explicit' | 'history' | 'compatible'
export type ProgrammingWarmups = 'off' | 'ramp'
export type ProgrammingHistoryMode = 'off' | 'bounded'

/**
 * Shared workout-programming defaults. These are deliberately broad guardrails,
 * not claims that one exact prescription is universally optimal. Explicit
 * template/set values remain the final override layer.
 */
export interface WorkoutProgrammingPolicy {
  goal: ProgrammingGoal
  order: ProgrammingOrder
  supersets: ProgrammingSupersets
  warmups: ProgrammingWarmups
  history: ProgrammingHistoryMode
}

export const DEFAULT_WORKOUT_PROGRAMMING_POLICY: WorkoutProgrammingPolicy = {
  goal: 'balanced',
  order: 'fatigue_aware',
  supersets: 'history',
  warmups: 'ramp',
  history: 'bounded',
}

export interface ProgrammingHistory {
  /** Median zero-based position from recent completed sessions. */
  positionByExercise: Map<string, number>
  /** Share of recent sessions containing at least one paired exercise group. */
  supersetSessionRate: number
  /** Median observed working-set rest, used only within a narrow evidence band. */
  medianRestSeconds: number | null
}

export const EMPTY_PROGRAMMING_HISTORY: ProgrammingHistory = {
  positionByExercise: new Map(),
  supersetSessionRate: 0,
  medianRestSeconds: null,
}

export interface ProgrammingMetadata {
  region: MuscleRegion | null
  pattern: string
}

export interface ProgrammableExercise {
  exerciseId: string
  name: string
  sets: number
  reps: number | null
  targetWeight: number | null
  supersetGroup: number | null
  restSeconds: number | null
  region: MuscleRegion | null
  section?: 'warmup' | 'main' | 'cooldown'
  targetDurationS?: number | null
  setPrescriptions?: ProposalSetPrescription[]
}

export interface ProgramWorkoutOptions {
  policy?: Partial<WorkoutProgrammingPolicy> | null
  metadata: Map<string, ProgrammingMetadata>
  history?: ProgrammingHistory
  /** Generated drafts use false; an explicitly-authored template uses true. */
  preserveExplicitRest?: boolean
  /** Generated drafts redistribute the existing region total; exact templates do not. */
  redistributeWorkingSets?: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function normalizeWorkoutProgrammingPolicy(
  raw: unknown,
  fallback: WorkoutProgrammingPolicy = DEFAULT_WORKOUT_PROGRAMMING_POLICY,
): WorkoutProgrammingPolicy {
  const row = record(raw) ?? {}
  const goal = row.goal
  const order = row.order
  const supersets = row.supersets
  const warmups = row.warmups
  const history = row.history
  return {
    goal:
      goal === 'strength' || goal === 'hypertrophy' || goal === 'endurance' || goal === 'power' || goal === 'balanced'
        ? goal
        : fallback.goal,
    order: order === 'preserve' || order === 'fatigue_aware' ? order : fallback.order,
    supersets:
      supersets === 'off' || supersets === 'explicit' || supersets === 'history' || supersets === 'compatible'
        ? supersets
        : fallback.supersets,
    warmups: warmups === 'off' || warmups === 'ramp' ? warmups : fallback.warmups,
    history: history === 'off' || history === 'bounded' ? history : fallback.history,
  }
}

export function inferProgrammingGoal(parts: Array<string | null | undefined>): ProgrammingGoal {
  const text = parts.filter((part): part is string => typeof part === 'string').join(' ').toLowerCase()
  if (/\b(power|explosive|speed|velocity|olympic)\b/.test(text)) return 'power'
  if (/\b(endurance|conditioning|stamina|high[- ]?rep)\b/.test(text)) return 'endurance'
  if (/\b(hypertrophy|muscle(?: growth)?|grow|size|mass|bodybuild)/.test(text)) return 'hypertrophy'
  if (/\b(strength|stronger|one[- ]?rep(?: max)?|\bpr\b|powerlift)/.test(text)) return 'strength'
  if (/\b(squat|bench(?: press)?|deadlift|overhead press|pull[- ]?up)\b[^.]{0,24}\b\d{2,4}\s*(?:lb|lbs|pounds?|kg)\b/.test(text)) {
    return 'strength'
  }
  return 'balanced'
}

export interface GoalProgrammingSignal {
  title: string
  area: string | null
  fitnessIntent?: ProgrammingGoal | null
  exerciseName?: string
}

/** Resolve a workout's training intent without letting unrelated app goals leak
 * into programming. An explicit workout focus wins; otherwise the ordered
 * structured fitness goals win, with a health/exercise-only legacy fallback. */
export function resolveProgrammingGoal(
  focus: string | null | undefined,
  goals: GoalProgrammingSignal[],
): ProgrammingGoal {
  const explicit = inferProgrammingGoal([focus])
  if (explicit !== 'balanced') return explicit

  const structured = goals.find((goal) => goal.fitnessIntent)
  if (structured?.fitnessIntent) return structured.fitnessIntent

  const legacyFitnessGoals = goals.filter(
    (goal) => goal.area === 'health' || Boolean(goal.exerciseName),
  )
  return inferProgrammingGoal(
    legacyFitnessGoals.flatMap((goal) => [goal.title, goal.exerciseName]),
  )
}

function metadataFor(
  exercise: ProgrammableExercise,
  metadata: Map<string, ProgrammingMetadata>,
): ProgrammingMetadata {
  return metadata.get(exercise.exerciseId) ?? {
    region: exercise.region,
    pattern: 'other',
  }
}

function isIsolation(pattern: string): boolean {
  return pattern === 'isolation' || pattern.startsWith('isolation-')
}

function isTechnical(pattern: string): boolean {
  return pattern === 'olympic' || pattern === 'jump'
}

const PRIORITY_COMPOUND_PATTERNS = new Set([
  'olympic',
  'squat',
  'hinge',
  'lunge',
  'horizontal-push',
  'vertical-push',
  'horizontal-pull',
  'vertical-pull',
  'carry',
])

/** Unknown/accessory patterns are never promoted to compound by absence of
 * metadata. This keeps legacy `mechanic:null` catalog rows conservative. */
function isAccessoryPattern(pattern: string): boolean {
  return isIsolation(pattern) || (!PRIORITY_COMPOUND_PATTERNS.has(pattern) && !isTechnical(pattern))
}

function supportsRampWarmup(pattern: string): boolean {
  return PRIORITY_COMPOUND_PATTERNS.has(pattern) && pattern !== 'carry'
}

function isLower(region: MuscleRegion | null): boolean {
  return region === 'quads' || region === 'hamstrings' || region === 'glutes' ||
    region === 'calves'
}

const ANTAGONISTS: Partial<Record<MuscleRegion, MuscleRegion[]>> = {
  chest: ['lats', 'mid_back'],
  lats: ['chest'],
  mid_back: ['chest'],
  biceps: ['triceps'],
  triceps: ['biceps'],
  quads: ['hamstrings'],
  hamstrings: ['quads'],
  abs: ['lower_back'],
  lower_back: ['abs'],
}

export function supersetCompatibility(
  left: ProgrammableExercise,
  right: ProgrammableExercise,
  metadata: Map<string, ProgrammingMetadata>,
): 'antagonist' | 'non_competing' | null {
  const a = metadataFor(left, metadata)
  const b = metadataFor(right, metadata)
  if (!a.region || !b.region || a.region === b.region) return null
  if (isTechnical(a.pattern) || isTechnical(b.pattern)) return null
  if (ANTAGONISTS[a.region]?.includes(b.region)) return 'antagonist'
  if (isLower(a.region) !== isLower(b.region)) return 'non_competing'
  return null
}

function priorityScore(
  exercise: ProgrammableExercise,
  index: number,
  metadata: Map<string, ProgrammingMetadata>,
  history: ProgrammingHistory,
  useHistory: boolean,
): number {
  const meta = metadataFor(exercise, metadata)
  const section = exercise.section ?? 'main'
  if (section === 'warmup') return -1000 + index
  if (section === 'cooldown') return 1000 + index
  const classScore = isTechnical(meta.pattern) ? 0 : isAccessoryPattern(meta.pattern) ? 200 : 100
  const historic = useHistory ? history.positionByExercise.get(exercise.exerciseId) : null
  // History only breaks ties inside the evidence-led class; it can never move an
  // isolation ahead of a priority/technical movement.
  return classScore + (historic == null ? index / 100 : Math.max(0, Math.min(20, historic)) / 100)
}

interface ExerciseBlock<T extends ProgrammableExercise> {
  rows: T[]
  score: number
  originalIndex: number
}

function validExplicitBlocks<T extends ProgrammableExercise>(
  exercises: T[],
  metadata: Map<string, ProgrammingMetadata>,
  policy: WorkoutProgrammingPolicy,
  history: ProgrammingHistory,
): ExerciseBlock<T>[] {
  const validGroups = new Map<number, number[]>()
  exercises.forEach((exercise, index) => {
    if (exercise.supersetGroup == null) return
    const indexes = validGroups.get(exercise.supersetGroup)
    if (indexes) indexes.push(index)
    else validGroups.set(exercise.supersetGroup, [index])
  })
  const acceptedGroups = new Set<number>()
  if (policy.supersets !== 'off') {
    for (const [group, indexes] of validGroups) {
      if (
        indexes.length >= 2 &&
        // Explicit (user-authored) groups keep every member regardless of size —
        // a 3+ circuit is valid (#1838: was silently dropped because this only
        // ever accepted pairs). Auto-detected pairing (compatible/history) stays
        // pairwise-only — the antagonist/non-competing heuristic below is not
        // defined for 3+ members.
        (policy.supersets === 'explicit' ||
          (indexes.length === 2 &&
            supersetCompatibility(exercises[indexes[0]!]!, exercises[indexes[1]!]!, metadata)))
      ) acceptedGroups.add(group)
    }
  }

  const consumed = new Set<number>()
  const blocks: ExerciseBlock<T>[] = []
  exercises.forEach((exercise, index) => {
    if (consumed.has(index)) return
    const group = exercise.supersetGroup
    if (group != null && acceptedGroups.has(group)) {
      const indexes = validGroups.get(group)!
      indexes.forEach((member) => consumed.add(member))
      const rows = indexes.map((member) => ({ ...exercises[member]!, supersetGroup: group })) as T[]
      blocks.push({
        rows,
        score: Math.min(...indexes.map((member) => priorityScore(exercises[member]!, member, metadata, history, policy.history === 'bounded'))),
        originalIndex: Math.min(...indexes),
      })
      return
    }
    consumed.add(index)
    blocks.push({
      rows: [{ ...exercise, supersetGroup: null }] as T[],
      score: priorityScore(exercise, index, metadata, history, policy.history === 'bounded'),
      originalIndex: index,
    })
  })
  return blocks
}

function fatigueAwareOrder<T extends ProgrammableExercise>(
  blocks: ExerciseBlock<T>[],
  metadata: Map<string, ProgrammingMetadata>,
): ExerciseBlock<T>[] {
  const pending = [...blocks].sort((a, b) => a.score - b.score || a.originalIndex - b.originalIndex)
  const ordered: ExerciseBlock<T>[] = []
  while (pending.length > 0) {
    const previous = ordered.at(-1)?.rows.at(-1)
    let pick = 0
    if (previous) {
      const previousRegion = metadataFor(previous, metadata).region
      const bestScore = pending[0]!.score
      const alternative = pending.findIndex((block) => {
        if (block.score - bestScore >= 100) return false
        return metadataFor(block.rows[0]!, metadata).region !== previousRegion
      })
      if (alternative >= 0) pick = alternative
    }
    ordered.push(pending.splice(pick, 1)[0]!)
  }
  return ordered
}

function goalRange(goal: ProgrammingGoal, pattern: string): [number, number] {
  const isolation = isAccessoryPattern(pattern)
  if (goal === 'strength') return isolation ? [6, 10] : [3, 6]
  if (goal === 'hypertrophy') return isolation ? [10, 15] : [6, 12]
  if (goal === 'endurance') return isolation ? [15, 25] : [12, 20]
  if (goal === 'power') return isolation ? [6, 10] : [3, 5]
  return isolation ? [8, 15] : [6, 12]
}

/** #1879: for a movement with no external load (bodyweight reps — pull-ups,
 * push-ups, etc.), reps ARE the load. Snapping an already-known rep count into
 * a goal's generic numeric window assumes the missing lever is weight (drop
 * the bar, add reps) — a lever bodyweight work doesn't have. An authored/
 * anchored rep count for bodyweight work is respected as-is; only a genuinely
 * unknown current value (nothing authored yet) still gets the goal's midpoint. */
function repsForGoal(
  current: number | null,
  goal: ProgrammingGoal,
  pattern: string,
  bodyweightLoaded: boolean,
): number {
  if (current != null && Number.isFinite(current) && bodyweightLoaded) {
    return Math.round(current)
  }
  const [lo, hi] = goalRange(goal, pattern)
  if (current != null && Number.isFinite(current) && current >= lo && current <= hi) {
    return Math.round(current)
  }
  return Math.round((lo + hi) / 2)
}

function allocationWeight(goal: ProgrammingGoal, pattern: string): number {
  if (isTechnical(pattern)) return goal === 'power' ? 1.7 : 1.25
  if (isAccessoryPattern(pattern)) {
    if (goal === 'strength' || goal === 'power') return 0.75
    if (goal === 'endurance') return 1.1
    return 1
  }
  if (goal === 'strength' || goal === 'power') return 1.5
  if (goal === 'balanced') return 1.15
  return 1
}

/** Preserve each region's total volume while distributing more of it to the
 * exercise class that matches the selected goal. */
function redistributeSets<T extends ProgrammableExercise>(
  exercises: T[],
  metadata: Map<string, ProgrammingMetadata>,
  goal: ProgrammingGoal,
): T[] {
  const next = exercises.map((exercise) => ({ ...exercise })) as T[]
  const groups = new Map<MuscleRegion, number[]>()
  next.forEach((exercise, index) => {
    if (exercise.section === 'warmup' || exercise.region == null) return
    const indexes = groups.get(exercise.region)
    if (indexes) indexes.push(index)
    else groups.set(exercise.region, [index])
  })
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue
    const total = indexes.reduce((sum, index) => sum + Math.max(1, Math.round(next[index]!.sets)), 0)
    const weights = indexes.map((index) => allocationWeight(goal, metadataFor(next[index]!, metadata).pattern))
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0)
    const floors = weights.map((weight) => Math.max(1, Math.floor(total * weight / weightTotal)))
    let remaining = total - floors.reduce((sum, value) => sum + value, 0)
    const remainders = weights
      .map((weight, i) => ({ i, remainder: total * weight / weightTotal - floors[i]! }))
      .sort((a, b) => b.remainder - a.remainder || a.i - b.i)
    for (const row of remainders) {
      if (remaining <= 0) break
      floors[row.i]! += 1
      remaining -= 1
    }
    indexes.forEach((index, i) => { next[index]!.sets = floors[i]! })
  }
  return next
}

function baseRestSeconds(reps: number, pattern: string, goal: ProgrammingGoal): number {
  const compound = !isAccessoryPattern(pattern)
  if (goal === 'power' || isTechnical(pattern)) return 180
  if (reps <= 5) return compound ? 180 : 150
  if (reps <= 8) return compound ? 150 : 120
  if (reps <= 12) return compound ? 120 : 90
  if (reps <= 20) return 90
  return 60
}

function boundedHistoricalRest(base: number, history: ProgrammingHistory, enabled: boolean): number {
  if (!enabled || history.medianRestSeconds == null) return base
  const bounded = Math.max(base - 30, Math.min(base + 30, history.medianRestSeconds))
  return Math.round(bounded / 15) * 15
}

function roundedRampWeight(target: number, fraction: number): number {
  const raw = target * fraction
  const step = target >= 50 ? 5 : 2.5
  return Math.max(step, Math.round(raw / step) * step)
}

function patternFamily(pattern: string, region: MuscleRegion | null): string {
  if (pattern === 'other' || pattern === 'isolation') return region ?? pattern
  return pattern.startsWith('isolation-') ? pattern : pattern
}

function warmupRamp(
  exercise: ProgrammableExercise,
  pattern: string,
  goal: ProgrammingGoal,
): ProposalSetPrescription[] {
  const target = exercise.targetWeight
  if (target == null || target <= 0) return []
  const heavy = goal === 'strength' || goal === 'power' || (exercise.reps != null && exercise.reps <= 5)
  const steps = heavy
    ? [{ fraction: 0.4, reps: 8, rest: 45 }, { fraction: 0.6, reps: 5, rest: 60 }, { fraction: 0.75, reps: 3, rest: 90 }]
    : [{ fraction: 0.5, reps: 6, rest: 45 }, { fraction: 0.7, reps: 3, rest: 60 }]
  if (target < 20 && !isTechnical(pattern)) steps.splice(1)
  return steps.map((step) => ({
    setType: 'warmup',
    targetWeight: roundedRampWeight(target, step.fraction),
    reps: step.reps,
    targetDurationS: null,
    targetRpe: null,
    restSeconds: step.rest,
    side: null,
  }))
}

function workingSetsWithDefaults(
  exercise: ProgrammableExercise,
  restSeconds: number,
  preserveExplicitRest: boolean,
): ProposalSetPrescription[] {
  return resolveProposalSetPrescriptions(exercise)
    .filter((set) => set.setType !== 'warmup')
    .map((set) => ({
      ...set,
      reps: set.reps ?? exercise.reps,
      restSeconds: preserveExplicitRest && set.restSeconds != null ? set.restSeconds : restSeconds,
    }))
}

function addAutomaticSupersets<T extends ProgrammableExercise>(
  exercises: T[],
  metadata: Map<string, ProgrammingMetadata>,
  policy: WorkoutProgrammingPolicy,
  history: ProgrammingHistory,
): T[] {
  const shouldPair = policy.supersets === 'compatible' ||
    (policy.supersets === 'history' && history.supersetSessionRate >= 0.35)
  if (!shouldPair) return exercises
  const next = exercises.map((exercise) => ({ ...exercise })) as T[]
  let group = Math.max(0, ...next.map((exercise) => exercise.supersetGroup ?? 0)) + 1
  for (let index = 0; index < next.length - 1; index += 1) {
    const left = next[index]!
    const right = next[index + 1]!
    if (left.supersetGroup != null || right.supersetGroup != null) continue
    const compatibility = supersetCompatibility(left, right, metadata)
    if (!compatibility) continue
    const leftMeta = metadataFor(left, metadata)
    const rightMeta = metadataFor(right, metadata)
    // Heavy compound pairs can be explicitly authored, but the automatic pass
    // never invents them: the systemic-fatigue cost is not a safe default.
    if (!isAccessoryPattern(leftMeta.pattern) && !isAccessoryPattern(rightMeta.pattern)) continue
    left.supersetGroup = group
    right.supersetGroup = group
    group += 1
    index += 1
  }
  return next
}

function applyPairRest<T extends ProgrammableExercise>(
  exercises: T[],
  metadata: Map<string, ProgrammingMetadata>,
  history: ProgrammingHistory,
  policy: WorkoutProgrammingPolicy,
  preserveExplicitRest: boolean,
): T[] {
  const next = exercises.map((exercise) => ({ ...exercise })) as T[]
  const groups = new Map<number, number[]>()
  next.forEach((exercise, index) => {
    if (exercise.supersetGroup == null) return
    const indexes = groups.get(exercise.supersetGroup)
    if (indexes) indexes.push(index)
    else groups.set(exercise.supersetGroup, [index])
  })
  for (const indexes of groups.values()) {
    if (indexes.length !== 2) continue
    const [firstIndex, secondIndex] = indexes
    const first = next[firstIndex!]!
    const second = next[secondIndex!]!
    const firstBase = baseRestSeconds(first.reps ?? 8, metadataFor(first, metadata).pattern, policy.goal)
    const secondBase = baseRestSeconds(second.reps ?? 8, metadataFor(second, metadata).pattern, policy.goal)
    if (!preserveExplicitRest || first.restSeconds == null) first.restSeconds = 15
    if (!preserveExplicitRest || second.restSeconds == null) {
      second.restSeconds = boundedHistoricalRest(
        Math.max(firstBase, secondBase),
        history,
        policy.history === 'bounded',
      )
    }
  }
  return next
}

/**
 * Deterministically program an already-safe exercise slate. Injury/equipment
 * filtering remains upstream; this function only distributes/order/schemes the
 * supplied rows and never introduces an exercise.
 */
export function programWorkout<T extends ProgrammableExercise>(
  input: T[],
  options: ProgramWorkoutOptions,
): T[] {
  const policy = normalizeWorkoutProgrammingPolicy(options.policy)
  const history = options.history ?? EMPTY_PROGRAMMING_HISTORY
  let rows = input.map((exercise) => ({ ...exercise })) as T[]
  if (options.redistributeWorkingSets) rows = redistributeSets(rows, options.metadata, policy.goal)

  const blocks = validExplicitBlocks(rows, options.metadata, policy, history)
  rows = (policy.order === 'preserve' ? blocks : fatigueAwareOrder(blocks, options.metadata))
    .flatMap((block) => block.rows)
    .map((exercise) => ({ ...exercise })) as T[]
  rows = addAutomaticSupersets(rows, options.metadata, policy, history)

  rows = rows.map((exercise) => {
    const meta = metadataFor(exercise, options.metadata)
    // A hold or carry is prescribed in SECONDS. repsForGoal has no null to
    // return — given no current reps it hands back the midpoint of the goal's
    // range — so running it over a duration-based movement invents a rep count
    // out of nothing. Live 2026-08-26: a 2:10 Kegels hold came back carrying
    // "12 reps", the midpoint of the balanced isolation range [8,15], which then
    // rendered beside the duration in the logger.
    const durationBased =
      exercise.targetDurationS != null ||
      (exercise.setPrescriptions?.some((set) => set.targetDurationS != null) ?? false)
    const bodyweightLoaded = exercise.targetWeight == null || exercise.targetWeight <= 0
    const reps =
      exercise.section === 'warmup' || durationBased
        ? exercise.reps
        : repsForGoal(exercise.reps, policy.goal, meta.pattern, bodyweightLoaded)
    const evidenceRest = boundedHistoricalRest(
      baseRestSeconds(reps ?? 8, meta.pattern, policy.goal),
      history,
      policy.history === 'bounded',
    )
    return {
      ...exercise,
      reps,
      restSeconds:
        options.preserveExplicitRest && exercise.restSeconds != null
          ? exercise.restSeconds
          : evidenceRest,
    }
  }) as T[]
  rows = applyPairRest(
    rows,
    options.metadata,
    history,
    policy,
    options.preserveExplicitRest === true,
  )

  if (policy.warmups === 'ramp') {
    const warmedFamilies = new Set<string>()
    rows = rows.map((exercise) => {
      const meta = metadataFor(exercise, options.metadata)
      const family = patternFamily(meta.pattern, meta.region)
      const existing = resolveProposalSetPrescriptions(exercise)
      const existingWarmups = existing.filter((set) => set.setType === 'warmup')
      const eligible =
        (exercise.section ?? 'main') === 'main' &&
        supportsRampWarmup(meta.pattern) &&
        exercise.targetDurationS == null &&
        exercise.targetWeight != null && exercise.targetWeight > 0 &&
        !warmedFamilies.has(family)
      if (eligible) warmedFamilies.add(family)
      const ramp = eligible && existingWarmups.length === 0
        ? warmupRamp(exercise, meta.pattern, policy.goal)
        : existingWarmups
      const working = workingSetsWithDefaults(
        exercise,
        exercise.restSeconds ?? 120,
        options.preserveExplicitRest === true,
      )
      return {
        ...exercise,
        setPrescriptions: ramp.length > 0 ? [...ramp, ...working] : working,
      }
    }) as T[]
  }

  return rows
}
