/**
 * Progression policy engine (GYM_PLAN §2.5) — PURE, deterministic, total.
 *
 * The user authors a per-exercise progression POLICY (a JSON rule, not code). Every
 * session this engine evaluates (policy, prior working-set history) → the next
 * session's ghost targets + a plain-English rendering of the rule. The LLM never
 * does arithmetic at workout time; these targets are the policy's deterministic
 * output, zero LLM calls.
 *
 * INVARIANTS:
 *  - Total: never throws on a malformed policy — falls back to `last_time` with
 *    ruleText 'Custom rule (unreadable) — repeating last session.'
 *  - Deterministic: same inputs ⇒ same output, always.
 *  - Unit-aware: history rows carry their own unit; arithmetic runs in the
 *    exercise's DOMINANT unit (the most common unit across working history), so a
 *    stray kg row in an otherwise-lb history doesn't skew an lb increment. Emitted
 *    weights are in that dominant unit; the UI converts for display.
 *  - Weight rounding: policy `increment` wins; else round to 2.5 (kg) / 5 (lb).
 *
 * History is ordered OLDEST→NEWEST session; `history[history.length - 1]` is the
 * previous session's working sets. Warmups are excluded by the caller (this engine
 * treats every set it receives as a working set).
 */

import { KG_TO_LB } from './records'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Unit = 'lb' | 'kg'

/** One logged (or targeted) set. Fields are per-track; a weight_reps set carries
 *  weight+reps, a time set carries durationS, etc. */
export interface HistorySet {
  weight?: number | null
  /** Unit the `weight` was logged in. Defaults to the exercise's dominant unit. */
  unit?: Unit | null
  reps?: number | null
  durationS?: number | null
  /** Unilateral logger rows are stored as explicit L/R pairs. The policy engine
   * collapses each pair to its weaker side, then expands the next round back to
   * balanced pairs so one strong side can never clear progression alone. */
  side?: 'left' | 'right' | null
}

/** One prior session = its ordered working sets. */
export type Session = HistorySet[]

/** The full ordered history handed to the engine: OLDEST→NEWEST prior sessions. */
export type SessionHistory = Session[]

/** The engine's output: the ghost targets for the next session + the rule text. */
export interface ProgressionResult {
  sets: TargetSet[]
  ruleText: string
}

export interface TargetSet {
  weight?: number
  reps?: number
  durationS?: number
  side?: 'left' | 'right' | null
}

// ---- Policy DSL (§2.5) ----

export interface LastTimePolicy {
  type: 'last_time'
}
export interface DoubleProgressionPolicy {
  type: 'double_progression'
  /** [lo, hi] rep window. */
  repRange: [number, number]
  /** Weight bump when the top of the range is cleared on all sets. */
  increment: number
  /** Number of same-load working sets that must clear the range. Default 3. */
  requiredSets?: number
  /** Consecutive sessions with a set below `lo` before a deload. Default 2. */
  deloadAfterMisses?: number
  /** Deload as a percentage of current weight. Default 10. */
  deloadPct?: number
}
export interface LinearPolicy {
  type: 'linear'
  increment: number
}
export interface RepOnlyPolicy {
  type: 'rep_only'
  addRepWhen: { repsAtLeast: number }
  /** Reps added when the condition holds. Default 1. */
  addReps?: number
  /** Rep ceiling — once every set is at cap, stay. */
  capReps?: number
}
export interface RpeTargetPolicy {
  type: 'rpe_target'
  rpe: number
}
export interface RulePolicy {
  type: 'rule'
  when: {
    metric: 'reps' | 'weight' | 'all_sets_reps_at_least'
    op: '>=' | '>' | '<' | '<='
    value: number
  }
  then: { change: 'reps' | 'weight'; by: number }
  else?: { change: 'reps' | 'weight'; by: number }
}

export type ProgressionPolicy =
  | LastTimePolicy
  | DoubleProgressionPolicy
  | LinearPolicy
  | RepOnlyPolicy
  | RpeTargetPolicy
  | RulePolicy

// ---------------------------------------------------------------------------
// Unit helpers
// ---------------------------------------------------------------------------

const LB_TO_KG = 1 / KG_TO_LB

function convert(weight: number, from: Unit, to: Unit): number {
  if (from === to) return weight
  return from === 'kg' ? weight * KG_TO_LB : weight * LB_TO_KG
}

/** The dominant unit across a history = the unit most working sets used; ties and
 *  empty history fall back to the exercise's `unit` argument. */
export function dominantUnit(history: SessionHistory, fallback: Unit): Unit {
  let lb = 0
  let kg = 0
  for (const session of history) {
    for (const s of session) {
      if (s.weight == null || s.weight <= 0) continue
      if (s.unit === 'kg') kg += 1
      else lb += 1
    }
  }
  if (lb === 0 && kg === 0) return fallback
  if (kg > lb) return 'kg'
  if (lb > kg) return 'lb'
  return fallback
}

/** Default rounding step per unit when the policy provides no `increment`. */
function defaultStep(unit: Unit): number {
  return unit === 'kg' ? 2.5 : 5
}

/** Round to the nearest step (deterministic), trimming float noise. Exported for
 *  tests (the rounding rule is part of the §2.5 contract). */
export function roundNearest(weight: number, step: number): number {
  if (!(step > 0)) return trimFloat(weight)
  return trimFloat(Math.round(weight / step) * step)
}

/** Trim binary-float noise (e.g. 0.1+0.2) to 6 decimals. */
function trimFloat(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

// ---------------------------------------------------------------------------
// Working-set projection to the dominant unit
// ---------------------------------------------------------------------------

interface WorkingSet {
  /** Weight in the dominant unit (null when the set carried no weight). */
  weight: number | null
  reps: number | null
  durationS: number | null
}

/** Project one session's sets into the dominant unit (numeric weights only). */
function projectSession(session: Session, unit: Unit): WorkingSet[] {
  return session.map((s) => ({
    weight:
      s.weight != null && s.weight > 0 ? trimFloat(convert(s.weight, s.unit ?? unit, unit)) : null,
    reps: s.reps ?? null,
    durationS: s.durationS ?? null,
  }))
}

/** The previous session's working sets, projected to the dominant unit (or []). */
function lastSession(history: SessionHistory, unit: Unit): WorkingSet[] {
  const last = history.length > 0 ? history[history.length - 1]! : []
  return projectSession(last, unit)
}

/** Targets that simply repeat a projected session verbatim. */
function repeat(sets: WorkingSet[]): TargetSet[] {
  return sets.map((s) => {
    const t: TargetSet = {}
    if (s.weight != null) t.weight = s.weight
    if (s.reps != null) t.reps = s.reps
    if (s.durationS != null) t.durationS = s.durationS
    return t
  })
}

// ---------------------------------------------------------------------------
// Policy validation (total — a bad shape falls back to last_time)
// ---------------------------------------------------------------------------

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Validate + narrow an unknown JSON blob into a policy, or null if malformed. */
export function parsePolicy(raw: unknown): ProgressionPolicy | null {
  if (raw == null) return { type: 'last_time' } // null column = default
  if (typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  switch (p.type) {
    case 'last_time':
      return { type: 'last_time' }
    case 'linear':
      return isFiniteNum(p.increment) && p.increment > 0
        ? { type: 'linear', increment: p.increment }
        : null
    case 'double_progression': {
      const r = p.repRange
      if (!Array.isArray(r) || r.length !== 2 || !isFiniteNum(r[0]) || !isFiniteNum(r[1])) return null
      if (r[0] > r[1] || r[0] <= 0) return null
      if (!isFiniteNum(p.increment) || p.increment <= 0) return null
      return {
        type: 'double_progression',
        repRange: [r[0], r[1]],
        increment: p.increment,
        requiredSets:
          isFiniteNum(p.requiredSets) && p.requiredSets >= 1
            ? Math.trunc(p.requiredSets)
            : 3,
        deloadAfterMisses:
          isFiniteNum(p.deloadAfterMisses) && p.deloadAfterMisses >= 1 ? p.deloadAfterMisses : 2,
        deloadPct: isFiniteNum(p.deloadPct) && p.deloadPct > 0 ? p.deloadPct : 10,
      }
    }
    case 'rep_only': {
      const w = p.addRepWhen as Record<string, unknown> | undefined
      if (!w || !isFiniteNum(w.repsAtLeast) || w.repsAtLeast <= 0) return null
      return {
        type: 'rep_only',
        addRepWhen: { repsAtLeast: w.repsAtLeast },
        addReps: isFiniteNum(p.addReps) && p.addReps > 0 ? p.addReps : 1,
        capReps: isFiniteNum(p.capReps) && p.capReps > 0 ? p.capReps : undefined,
      }
    }
    case 'rpe_target':
      return isFiniteNum(p.rpe) && p.rpe > 0 ? { type: 'rpe_target', rpe: p.rpe } : null
    case 'rule': {
      const w = p.when as Record<string, unknown> | undefined
      const then = p.then as Record<string, unknown> | undefined
      if (!w || !then) return null
      const metric = w.metric
      const op = w.op
      if (
        (metric !== 'reps' && metric !== 'weight' && metric !== 'all_sets_reps_at_least') ||
        (op !== '>=' && op !== '>' && op !== '<' && op !== '<=') ||
        !isFiniteNum(w.value)
      )
        return null
      if ((then.change !== 'reps' && then.change !== 'weight') || !isFiniteNum(then.by)) return null
      const parsed: RulePolicy = {
        type: 'rule',
        when: { metric, op, value: w.value },
        then: { change: then.change, by: then.by },
      }
      const els = p.else as Record<string, unknown> | undefined
      if (els && (els.change === 'reps' || els.change === 'weight') && isFiniteNum(els.by)) {
        parsed.else = { change: els.change, by: els.by }
      }
      return parsed
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const FALLBACK_RULE_TEXT = 'Custom rule (unreadable) — repeating last session.'

// ---------------------------------------------------------------------------
// Plain-English rule text (shared by the engine AND the template builder)
// ---------------------------------------------------------------------------

/**
 * Render a PARSED policy's plain-English description. This is the single source of
 * the rule-text strings the engine emits — every `eval*` reuses it so the builder's
 * live preview (via `ruleTextFor`) is byte-identical to what the session ghosts show.
 */
function describePolicy(policy: ProgressionPolicy, unit: Unit): string {
  switch (policy.type) {
    case 'last_time':
      return 'Match last session.'
    case 'linear':
      return `Add ${fmtWeight(policy.increment, unit)} every session.`
    case 'double_progression': {
      const [lo, hi] = policy.repRange
      const requiredSets = policy.requiredSets ?? 3
      const misses = policy.deloadAfterMisses ?? 2
      const pct = policy.deloadPct ?? 10
      return (
        `Work ${lo}–${hi} reps for ${requiredSets} sets at the same weight: at ${hi} on all ${requiredSets}, ` +
        `add ${fmtWeight(policy.increment, unit)} and reset to ${lo}; ` +
        `after ${misses} sessions with a set under ${lo}, deload ${pct}%.`
      )
    }
    case 'rep_only': {
      const add = policy.addReps ?? 1
      const at = policy.addRepWhen.repsAtLeast
      const capText = policy.capReps != null ? ` (cap ${policy.capReps})` : ''
      return `Add ${add} rep${add === 1 ? '' : 's'} when every set hits ${at}${capText}.`
    }
    case 'rpe_target':
      return `Autoregulate to RPE ${policy.rpe}: keep last session's weights, adjust load to hit the target effort.`
    case 'rule':
      return renderRule(policy, unit)
  }
}

/**
 * Plain-English preview of a stored progression policy JSON — the template
 * builder's live "what this does" chip (GYM_PLAN §2.5). TOTAL: a null policy reads
 * as the `last_time` default; an unreadable one reads as the honest fallback. Same
 * strings the engine's ghosts carry (both route through `describePolicy`).
 *
 * @param rawPolicy the stored `progression` JSON (null ⇒ last_time default).
 * @param unit      the exercise's display unit (weights render in it).
 */
export function ruleTextFor(rawPolicy: unknown, unit: Unit = 'lb'): string {
  const policy = parsePolicy(rawPolicy)
  if (!policy) return FALLBACK_RULE_TEXT
  return describePolicy(policy, unit)
}

/**
 * Evaluate a progression policy against a session history → next-session ghost
 * targets + plain-English rule text. `unit` is the exercise's preferred/display
 * unit and the fallback dominant unit. TOTAL — never throws.
 *
 * @param rawPolicy  the stored `progression` JSON (null ⇒ last_time default).
 * @param history    OLDEST→NEWEST prior sessions of WORKING sets.
 * @param unit       exercise's preferred unit ('lb' | 'kg').
 */
export function evaluateProgression(
  rawPolicy: unknown,
  history: SessionHistory,
  unit: Unit = 'lb',
): ProgressionResult {
  try {
    const sideAware = collapsePerSideHistory(history)
    const policyHistory = sideAware.history
    const policy = parsePolicy(rawPolicy)
    let result: ProgressionResult
    if (!policy) {
      // Malformed → last_time behavior, but say so honestly.
      const dom = dominantUnit(policyHistory, unit)
      result = { sets: repeat(lastSession(policyHistory, dom)), ruleText: FALLBACK_RULE_TEXT }
      return sideAware.perSide ? expandPerSideTargets(result) : result
    }
    const dom = dominantUnit(policyHistory, unit)
    switch (policy.type) {
      case 'last_time':
        result = evalLastTime(policyHistory, dom)
        break
      case 'linear':
        result = evalLinear(policy, policyHistory, dom)
        break
      case 'double_progression':
        result = evalDoubleProgression(policy, policyHistory, dom)
        break
      case 'rep_only':
        result = evalRepOnly(policy, policyHistory, dom)
        break
      case 'rpe_target':
        result = evalRpeTarget(policy, policyHistory, dom)
        break
      case 'rule':
        result = evalRule(policy, policyHistory, dom)
        break
    }
    return sideAware.perSide ? expandPerSideTargets(result) : result
  } catch {
    // Absolute backstop — the engine is a hot path; never let it break a workout.
    return { sets: [], ruleText: FALLBACK_RULE_TEXT }
  }
}

function collapsePerSideSession(session: Session): { session: Session; perSide: boolean } {
  if (session.length === 0 || session.some((set) => set.side !== 'left' && set.side !== 'right')) {
    return { session, perSide: false }
  }
  const left = session.filter((set) => set.side === 'left')
  const right = session.filter((set) => set.side === 'right')
  const rounds = Math.max(left.length, right.length)
  return {
    perSide: true,
    session: Array.from({ length: rounds }, (_, index) => {
      const lhs = left[index]
      const rhs = right[index]
      // A missing side is an incomplete round, never evidence that the load or
      // rep gate cleared. Keeping it as an explicit null round prevents a lone
      // strong side from advancing the next workout.
      if (!lhs || !rhs) {
        return { weight: null, unit: null, reps: null, durationS: null, side: null }
      }
      const sameUnit = (lhs.unit ?? null) === (rhs.unit ?? null)
      const sameLoad =
        sameUnit &&
        lhs.weight != null &&
        rhs.weight != null &&
        Math.abs(lhs.weight - rhs.weight) <= 0.01
      const reps = lhs.reps != null && rhs.reps != null ? Math.min(lhs.reps, rhs.reps) : null
      const durationS =
        lhs.durationS != null && rhs.durationS != null
          ? Math.min(lhs.durationS, rhs.durationS)
          : null
      return {
        weight: sameLoad ? lhs.weight : null,
        unit: sameUnit ? lhs.unit : null,
        reps,
        durationS,
        side: null,
      }
    }),
  }
}

/** Collapse paired history only when the newest session proves this is a
 * per-side prescription. Older bilateral rows remain useful as logical rounds. */
export function collapsePerSideHistory(history: SessionHistory): {
  history: SessionHistory
  perSide: boolean
} {
  const newest = history.at(-1)
  if (!newest) return { history, perSide: false }
  const newestCollapsed = collapsePerSideSession(newest)
  if (!newestCollapsed.perSide) return { history, perSide: false }
  return {
    perSide: true,
    history: history.map((session) => {
      const collapsed = collapsePerSideSession(session)
      return collapsed.perSide ? collapsed.session : session
    }),
  }
}

function expandPerSideTargets(result: ProgressionResult): ProgressionResult {
  return {
    ...result,
    sets: result.sets.flatMap((set) => [
      { ...set, side: 'left' as const },
      { ...set, side: 'right' as const },
    ]),
  }
}

// ---- last_time ----
function evalLastTime(history: SessionHistory, unit: Unit): ProgressionResult {
  return {
    sets: repeat(lastSession(history, unit)),
    ruleText: describePolicy({ type: 'last_time' }, unit),
  }
}

// ---- linear ----
function evalLinear(
  policy: LinearPolicy,
  history: SessionHistory,
  unit: Unit,
): ProgressionResult {
  const ruleText = describePolicy(policy, unit)
  const last = lastSession(history, unit)
  if (last.length === 0) return { sets: [], ruleText }
  const sets = last.map((s) => {
    const t: TargetSet = {}
    if (s.weight != null) t.weight = roundNearest(s.weight + policy.increment, policy.increment)
    if (s.reps != null) t.reps = s.reps
    if (s.durationS != null) t.durationS = s.durationS
    return t
  })
  return { sets, ruleText }
}

// ---- double_progression ----
function evalDoubleProgression(
  policy: DoubleProgressionPolicy,
  history: SessionHistory,
  unit: Unit,
): ProgressionResult {
  const [lo, hi] = policy.repRange
  const requiredSets = policy.requiredSets ?? 3
  const misses = policy.deloadAfterMisses ?? 2
  const pct = policy.deloadPct ?? 10
  const ruleText = describePolicy(policy, unit)

  const last = lastSession(history, unit)
  if (last.length === 0) return { sets: [], ruleText }

  const lastWeight = modalWeight(last)
  const normalized = normalizeDoubleProgressionSets(last, requiredSets, lastWeight, lo)

  // Deload check: the last `misses` sessions ALL had a working set below lo.
  if (lastWeight != null && consecutiveMissSessions(history, unit, lo) >= misses) {
    const deloaded = roundNearest(lastWeight * (1 - pct / 100), policy.increment)
    return {
      sets: normalized.map((s) => shapeWeightReps(deloaded, s.reps ?? lo, lo)),
      ruleText,
    }
  }

  // Advance only after the configured number of SAME-LOAD working sets all hit
  // the top of the range. A shortened session or a back-off set cannot silently
  // qualify a load bump (the user's 3×8–10 rule).
  const qualifying = last.slice(0, requiredSets)
  const allAtHi =
    qualifying.length === requiredSets &&
    lastWeight != null &&
    qualifying.every(
      (s) => s.weight != null && sameWeight(s.weight, lastWeight) && (s.reps ?? 0) >= hi,
    )
  if (allAtHi && lastWeight != null) {
    const bumped = roundNearest(lastWeight + policy.increment, policy.increment)
    return {
      sets: Array.from({ length: requiredSets }, () => shapeWeightReps(bumped, lo, lo)),
      ruleText,
    }
  }

  // Otherwise repeat weight, nudging the FIRST set that was below hi up by 1 rep
  // (capped at hi) — the "keep grinding toward the top of the range" step.
  let nudged = false
  const sets = normalized.map((s) => {
    const reps = s.reps ?? lo
    let nextReps = reps
    if (!nudged && reps < hi) {
      nextReps = Math.min(reps + 1, hi)
      nudged = true
    }
    return shapeWeightReps(lastWeight ?? s.weight ?? 0, nextReps, lo)
  })
  return { sets, ruleText }
}

/** Normalize the next attempt to the configured set count and one working load.
 * Missing sets are restored at the bottom of the rep range; surplus sets are not
 * part of this policy's prescription. */
function normalizeDoubleProgressionSets(
  last: WorkingSet[],
  requiredSets: number,
  weight: number | null,
  lo: number,
): WorkingSet[] {
  return Array.from({ length: requiredSets }, (_, i) => {
    const prior = last[i]
    return {
      weight: weight ?? prior?.weight ?? null,
      reps: prior?.reps ?? lo,
      durationS: prior?.durationS ?? null,
    }
  })
}

function sameWeight(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6
}

/** Count how many of the MOST-RECENT consecutive sessions had ≥1 working set with
 *  reps below `lo` (a "miss"), walking newest→older until a clean session. */
function consecutiveMissSessions(history: SessionHistory, unit: Unit, lo: number): number {
  let count = 0
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const sets = projectSession(history[i]!, unit)
    if (sets.length === 0) break
    const missed = sets.some((s) => (s.reps ?? 0) < lo)
    if (missed) count += 1
    else break
  }
  return count
}

// ---- rep_only ----
function evalRepOnly(
  policy: RepOnlyPolicy,
  history: SessionHistory,
  unit: Unit,
): ProgressionResult {
  const add = policy.addReps ?? 1
  const at = policy.addRepWhen.repsAtLeast
  const cap = policy.capReps
  const ruleText = describePolicy(policy, unit)

  const last = lastSession(history, unit)
  if (last.length === 0) return { sets: [], ruleText }

  const everyAtLeast = last.every((s) => (s.reps ?? 0) >= at)
  const sets = last.map((s) => {
    const t: TargetSet = {}
    if (s.weight != null) t.weight = s.weight
    if (s.reps != null) {
      let next = everyAtLeast ? s.reps + add : s.reps
      if (cap != null && next > cap) next = cap
      t.reps = next
    }
    if (s.durationS != null) t.durationS = s.durationS
    return t
  })
  return { sets, ruleText }
}

// ---- rpe_target ----
function evalRpeTarget(
  policy: RpeTargetPolicy,
  history: SessionHistory,
  unit: Unit,
): ProgressionResult {
  return {
    sets: repeat(lastSession(history, unit)),
    ruleText: describePolicy(policy, unit),
  }
}

// ---- rule (composable conditional) ----
function evalRule(policy: RulePolicy, history: SessionHistory, unit: Unit): ProgressionResult {
  const { when, then } = policy
  const last = lastSession(history, unit)
  const ruleText = renderRule(policy, unit)
  if (last.length === 0) return { sets: [], ruleText }

  // metric value against last session:
  //  'reps' = MIN working-set reps; 'weight' = TOP working-set weight;
  //  'all_sets_reps_at_least' = 1 if every set's reps ≥ value else 0 (op is then
  //  compared as a boolean-ish 1/0 vs value, but the natural read is >= value on
  //  every set — we evaluate the "all sets" predicate directly).
  let conditionMet: boolean
  if (when.metric === 'all_sets_reps_at_least') {
    conditionMet = last.every((s) => compare(s.reps ?? 0, when.op, when.value))
  } else {
    const metricValue =
      when.metric === 'reps'
        ? minReps(last)
        : (topWeight(last) ?? 0)
    conditionMet = compare(metricValue, when.op, when.value)
  }

  const action = conditionMet ? then : policy.else
  const sets = last.map((s) => {
    const t: TargetSet = {}
    if (s.weight != null) t.weight = s.weight
    if (s.reps != null) t.reps = s.reps
    if (s.durationS != null) t.durationS = s.durationS
    if (action) applyAction(t, action, unit)
    return t
  })
  return { sets, ruleText }
}

function applyAction(t: TargetSet, action: { change: 'reps' | 'weight'; by: number }, unit: Unit) {
  if (action.change === 'reps' && t.reps != null) {
    t.reps = Math.max(0, t.reps + action.by)
  } else if (action.change === 'weight' && t.weight != null) {
    // Round the RESULT to the unit's plate step (2.5 kg / 5 lb), not to `by` —
    // `by` is the bump size, not a grid the final weight must land on (a +10 from
    // 205 is 215, not 220).
    t.weight = roundNearest(t.weight + action.by, defaultStep(unit))
  }
}

function compare(a: number, op: RulePolicy['when']['op'], b: number): boolean {
  switch (op) {
    case '>=':
      return a >= b
    case '>':
      return a > b
    case '<':
      return a < b
    case '<=':
      return a <= b
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Heaviest working-set weight in a projected session (null if none carry weight). */
function topWeight(sets: WorkingSet[]): number | null {
  let top: number | null = null
  for (const s of sets) {
    if (s.weight != null && (top == null || s.weight > top)) top = s.weight
  }
  return top
}

/** Most common positive working weight; ties keep the first-seen load. This is
 * the stable training load for double progression (back-off outliers do not
 * become the next session's prescription). */
function modalWeight(sets: WorkingSet[]): number | null {
  const counts = new Map<number, number>()
  let best: number | null = null
  let bestCount = 0
  for (const set of sets) {
    if (set.weight == null || set.weight <= 0) continue
    const count = (counts.get(set.weight) ?? 0) + 1
    counts.set(set.weight, count)
    if (count > bestCount) {
      best = set.weight
      bestCount = count
    }
  }
  return best
}

/** Minimum working-set reps (0 if none logged reps). */
function minReps(sets: WorkingSet[]): number {
  let min: number | null = null
  for (const s of sets) {
    if (s.reps != null && (min == null || s.reps < min)) min = s.reps
  }
  return min ?? 0
}

/** Build a weight_reps target with a floored rep count. */
function shapeWeightReps(weight: number, reps: number, floor: number): TargetSet {
  return { weight: trimFloat(weight), reps: Math.max(floor, Math.round(reps)) }
}

/** Format a weight for rule text (trim trailing zeros, append unit). */
function fmtWeight(w: number, unit: Unit): string {
  return `${trimFloat(w)} ${unit}`
}

/** Render a composable rule in plain English. */
function renderRule(policy: RulePolicy, unit: Unit): string {
  const { when, then } = policy
  const metricLabel =
    when.metric === 'reps'
      ? 'reps (min set)'
      : when.metric === 'weight'
        ? 'top weight'
        : 'every set'
  const cond =
    when.metric === 'all_sets_reps_at_least'
      ? `when every set hits ${when.op} ${when.value} reps`
      : `when ${metricLabel} ${when.op} ${when.value}`
  const act = describeAction(then, unit)
  const elseAct = policy.else ? `, otherwise ${describeAction(policy.else, unit)}` : ''
  return `${cap(cond)}, ${act}${elseAct}.`
}

function describeAction(a: { change: 'reps' | 'weight'; by: number }, unit: Unit): string {
  const dir = a.by >= 0 ? 'add' : 'drop'
  const mag = Math.abs(a.by)
  return a.change === 'weight'
    ? `${dir} ${mag} ${unit}`
    : `${dir} ${mag} rep${mag === 1 ? '' : 's'}`
}

function cap(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s
}
