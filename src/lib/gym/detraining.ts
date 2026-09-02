/**
 * Return-to-training (detraining) engine — PURE, deterministic, total.
 *
 * Why this exists (#1790): starting a saved template asked "what was last
 * lift?" and never "when?". After ~7 weeks off pushing, the most recent
 * completed session WAS the pre-injury 150lb one, so the progression overlay
 * rewrote a deliberately-authored 95lb restart to 150 — while keeping the
 * template's 50/65 warmups, which is what made it visible. `plan_workout`
 * already reasons about deload/detraining; `startWorkout` had no notion of
 * elapsed time at all. This module is the shared signal both paths consume, so
 * the load math is never forked (the same rule the e1RM helpers follow).
 *
 * ── The two numbers, which are NOT the same ────────────────────────────────
 * 1. What the user can still LIFT. Strength decays far slower than intuition says:
 *    maximal strength is broadly maintained for ~3 weeks with no training, and
 *    decays gradually thereafter (systematic reviews find much of the gain
 *    retained even at 16-24 weeks).
 * 2. What to PRESCRIBE on the first session back. Deliberately below (1):
 *    connective tissue and work capacity readapt slower than maximal strength,
 *    and the practical failure mode is a wrecked week of DOMS, not a missed rep.
 *
 * Conflating them is why a flat "-10%/week" feels wrong — it is too aggressive
 * in the first three weeks (nothing is lost yet) AND, being unbounded, decays
 * to zero at week 10. The bands below model (2), re-entry, and are FLOORED.
 *
 * ⚠️ These are heuristics seeded from general strength-training literature, not
 * clinical guidance and not settled science. They are deliberately table-driven
 * so they can be tuned against the user's own logged data. A return from a genuine
 * INJURY should be more conservative than one from travel, and a per-exercise
 * injury override (injury-profile.ts) always outranks anything computed here.
 */

import { roundNearest } from './progression'
import type { Unit } from './progression'

// ---------------------------------------------------------------------------
// Policy constants — tune these, not the algorithm
// ---------------------------------------------------------------------------

/** Below this, a gap is ordinary life (a deload week, a trip, a busy fortnight)
 *  and gets no adjustment at all. Above it, a re-entry ramp starts. */
export const NO_DELOAD_DAYS = 10

/** Completed sessions to climb from the re-entry factor back to full load.
 *  Four gives roughly +7pp per session off a 0.72 base — inside the +8-10%
 *  per-session range that return-to-training guidance typically suggests. */
export const RAMP_SESSIONS = 4

/** The hard floor. A 10-week layoff and a 10-YEAR layoff both land here: a
 *  linear decay would prescribe zero, which is worse than useless. Strength
 *  retention is high enough that 70% of a former working weight remains a
 *  reasonable, conservative re-entry even after a very long break. */
export const DELOAD_FLOOR = 0.7

/** Re-entry factor by layoff length. Read as: "after a gap of up to N days,
 *  start back at F of the pre-layoff working weight." Ordered, first match
 *  wins. Deliberately a table: this is policy, not arithmetic. */
export const RE_ENTRY_BANDS: ReadonlyArray<{ maxGapDays: number; factor: number }> = [
  // Strength is intact here; no adjustment. Ordinary life.
  { maxGapDays: NO_DELOAD_DAYS, factor: 1.0 },
  // ~2-3 weeks: still no meaningful strength loss — this is purely soreness
  // and work-capacity management.
  { maxGapDays: 21, factor: 0.9 },
  // ~4-6 weeks: decay has begun, but work capacity is the larger gap.
  { maxGapDays: 42, factor: 0.8 },
  // ~7-10 weeks: the user's #1790 case (7 weeks off pushing).
  { maxGapDays: 70, factor: 0.72 },
  // Beyond that, the floor holds forever.
  { maxGapDays: Number.POSITIVE_INFINITY, factor: DELOAD_FLOOR },
]

/** How much an UNFAMILIAR movement is eased when the muscle group itself is
 *  trained. Deliberately gentle and floored high: if the user has been pressing, their
 *  chest has not detrained — but dumbbells demand different stabilization and
 *  the pattern needs reacquainting, so a first session back on a lift he has
 *  not done in months is not a full-load session either. */
export const SPECIFICITY_FLOOR = 0.9

export const SPECIFICITY_BANDS: ReadonlyArray<{ maxGapDays: number; factor: number }> = [
  { maxGapDays: 21, factor: 1.0 },
  { maxGapDays: 42, factor: 0.95 },
  { maxGapDays: Number.POSITIVE_INFINITY, factor: SPECIFICITY_FLOOR },
]

/** The specificity trim for a gap on ONE exercise. Never below the floor. */
export function specificityFactor(exerciseGapDays: number): number {
  for (const band of SPECIFICITY_BANDS) {
    if (exerciseGapDays <= band.maxGapDays) return band.factor
  }
  return SPECIFICITY_FLOOR
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One completed session's date plus its top working weight, in lb. Weight is
 *  null for sessions that carried no load (time/distance tracks). */
export interface SessionMark {
  /** ms since epoch — a number, not a Date, so the engine stays trivially
   *  serializable and testable without timezone entanglement. */
  at: number
  topWeightLb: number | null
  /** Did this session actually MEET its prescription (every prescribed working
   *  set completed at or above target reps)? `undefined` = unknown, which is
   *  the honest state for a session logged before prescriptions were stored —
   *  treated as met, so missing history can never stall a ramp forever. */
  metPrescription?: boolean
}

export interface DetrainingSignal {
  /** Multiplier to apply to the PRE-LAYOFF baseline. 1 = no adjustment. */
  factor: number
  /** The layoff that opened the current re-entry block, in whole days. */
  gapDays: number | null
  /** Completed sessions since coming back (0 = the layoff is still open, so the
   *  workout being prescribed right now is the first one back). */
  sessionsSinceReturn: number
  /** Sessions still to climb before full load resumes. */
  rampSessionsRemaining: number
  /** When the layoff BEGAN (the last session before the break), epoch ms.
   *  Lets a caller ask whether an authored template weight predates it. */
  layoffStartedAt: number | null
  /** Heaviest weight actually COMPLETED since coming back, lb. The ramp is a
   *  floor-raiser, never a ceiling: if the user overrode to 135 and finished it, the
   *  next session must not prescribe 120 and drag them backwards. */
  completedSinceReturnLb: number | null
  /** Top working weight of the last session BEFORE the layoff — the anchor the
   *  ramp climbs back toward. Null when unknown (no loaded pre-layoff session).
   *  ⚠️ Deliberately NOT the most recent session: after one de-loaded session
   *  back, the newest weight IS the de-loaded one, and ramping off that would
   *  walk the load DOWNWARD every session. */
  baselineLb: number | null
  /** One terse sentence for the workout payload, or null when factor === 1.
   *  Never a silent weight change — see feedback_no-ai-nag-surfaces: one line,
   *  not a nag. */
  reason: string | null
}

/** The no-op signal: nothing to adjust. */
export const NO_DETRAINING: DetrainingSignal = {
  factor: 1,
  gapDays: null,
  sessionsSinceReturn: 0,
  rampSessionsRemaining: 0,
  layoffStartedAt: null,
  completedSinceReturnLb: null,
  baselineLb: null,
  reason: null,
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000

/** Whole days between two epoch-ms instants, floored and never negative. */
export function dayGap(laterMs: number, earlierMs: number): number {
  return Math.max(0, Math.floor((laterMs - earlierMs) / MS_PER_DAY))
}

/** The re-entry factor for a layoff of `gapDays`. Total: always returns a
 *  number in [DELOAD_FLOOR, 1]. */
export function reEntryFactor(gapDays: number): number {
  for (const band of RE_ENTRY_BANDS) {
    if (gapDays <= band.maxGapDays) return band.factor
  }
  return DELOAD_FLOOR
}

/**
 * Compute the re-entry signal from a session history.
 *
 * `sessions` is NEWEST→OLDEST. `nowMs` is the instant the workout is being
 * prescribed for. Pure: same inputs ⇒ same output, no clock read, no I/O.
 */
export interface DetrainingInput {
  /** Completed sessions for THIS exercise, NEWEST→OLDEST. Supplies the baseline
   *  weight and the specificity trim. */
  exercise: readonly SessionMark[]
  /** Completed sessions for every exercise sharing this one's primary muscle
   *  region, NEWEST→OLDEST. This is what actually detects the layoff.
   *  Omit when the region cannot be resolved — the exercise history is then
   *  used for both, which is the old per-exercise behaviour. */
  region?: readonly SessionMark[]
}

/**
 * Compute the re-entry signal.
 *
 * ⚠️ The layoff is a property of the MUSCLE GROUP, not of one lift. Barbell
 * bench and dumbbell bench train the same thing; rotating between them is
 * exercise selection, not detraining. An earlier version keyed everything off
 * the single exercise and was wrong in BOTH directions — it de-loaded a lift
 * The user had merely swapped away from while he pressed all along, and it called
 * him fresh when one recent session of this movement sat inside an otherwise
 * empty eight weeks of pushing.
 *
 * So: the REGION drives the layoff and the ramp; the EXERCISE supplies the
 * baseline weight and a gentle specificity trim. The baseline is never invented
 * from a different movement's weights — that load transfer is the thing that is
 * genuinely unsafe to guess, and it never arises here.
 *
 * Pure: same inputs ⇒ same output, no clock read, no I/O.
 */
export function detrainingSignal(input: DetrainingInput, nowMs: number): DetrainingSignal {
  const exercise = input.exercise
  const region = input.region && input.region.length > 0 ? input.region : exercise

  // No history at all means no baseline to de-load FROM. A brand-new movement
  // is a different concern (start conservative because it is unfamiliar), and
  // pretending it is a layoff would invent a number out of nothing.
  if (exercise.length === 0) return NO_DETRAINING

  const layoff = findLayoff(region, nowMs)
  const exerciseGapDays = exercise.length > 0 ? dayGap(nowMs, exercise[0]!.at) : 0
  const specificity = specificityFactor(exerciseGapDays)

  // Region trained steadily. Only the specificity trim can apply — and only
  // when this particular lift has genuinely been away a while.
  if (!layoff) {
    if (specificity >= 1) return NO_DETRAINING
    const baselineLb = firstLoaded(exercise, 0)
    if (baselineLb == null) return NO_DETRAINING
    return {
      factor: specificity,
      gapDays: exerciseGapDays,
      sessionsSinceReturn: 0,
      rampSessionsRemaining: 0,
      layoffStartedAt: null,
      completedSinceReturnLb: null,
      baselineLb,
      reason:
        `you have trained this muscle group recently but not this exact lift in ` +
        `${Math.round(exerciseGapDays / 7)} weeks — easing to ${Math.round(specificity * 100)}% ` +
        `for the movement, not for lost strength.`,
    }
  }

  const base = reEntryFactor(layoff.gapDays)
  if (base >= 1) return NO_DETRAINING
  if (layoff.sessionsSinceReturn >= RAMP_SESSIONS) return NO_DETRAINING

  // ⚠️ Specificity does NOT stack here. The two cases are disjoint by design:
  // either the region is on a layoff (the re-entry factor already prices the
  // time away), or it is trained and only this lift is unfamiliar. Stacking
  // them double-charges ONE gap — and when the region falls back to the
  // exercise's own history the two gaps are literally the same days.
  const factor = Math.min(
    1,
    base + ((1 - base) * layoff.sessionsSinceReturn) / RAMP_SESSIONS,
  )
  if (factor >= 1) return NO_DETRAINING

  const baselineLb = firstLoaded(exercise, exerciseBaselineIndex(exercise, layoff.boundaryAt))

  return {
    factor,
    gapDays: layoff.gapDays,
    sessionsSinceReturn: layoff.sessionsSinceReturn,
    rampSessionsRemaining: Math.max(0, RAMP_SESSIONS - layoff.sessionsSinceReturn),
    layoffStartedAt: layoff.startedAt,
    completedSinceReturnLb: bestCompletedSince(exercise, layoff.boundaryAt),
    baselineLb,
    reason: explain(layoff.gapDays, layoff.sessionsSinceReturn, factor),
  }
}

interface Layoff {
  gapDays: number
  /** Sessions since coming back that actually MET their prescription. */
  sessionsSinceReturn: number
  /** Instant the layoff ended (the first session back), or nowMs when the
   *  layoff is still open. Anchors the exercise-side baseline lookup. */
  boundaryAt: number
  /** Instant the layoff BEGAN (last session before the break). */
  startedAt: number
}

/** Find the layoff currently governing this region, if any. */
function findLayoff(sessions: readonly SessionMark[], nowMs: number): Layoff | null {
  if (sessions.length === 0) return null

  const daysSinceLast = dayGap(nowMs, sessions[0]!.at)
  if (daysSinceLast > NO_DELOAD_DAYS) {
    // Still open: the workout being prescribed now is the first one back.
    return {
      gapDays: daysSinceLast,
      sessionsSinceReturn: 0,
      boundaryAt: nowMs,
      startedAt: sessions[0]!.at,
    }
  }

  for (let i = 0; i < sessions.length - 1; i += 1) {
    const gap = dayGap(sessions[i]!.at, sessions[i + 1]!.at)
    if (gap > NO_DELOAD_DAYS) {
      // ⚠️ PERFORMANCE-GATED: a session only advances the ramp if it actually
      // met its prescription. Bailing after one set should repeat the step, not
      // climb it. Unknown (undefined) counts as met so legacy rows never stall.
      let met = 0
      for (let k = 0; k <= i; k += 1) {
        if (sessions[k]!.metPrescription !== false) met += 1
      }
      return {
        gapDays: gap,
        sessionsSinceReturn: met,
        boundaryAt: sessions[i]!.at,
        startedAt: sessions[i + 1]!.at,
      }
    }
  }
  return null
}

/** Index of the first exercise session at or before the layoff boundary. */
function exerciseBaselineIndex(sessions: readonly SessionMark[], boundaryAt: number): number {
  // STRICTLY older: `<=` would select the first session back — which is the
  // de-loaded one — and the ramp would then climb off its own output.
  for (let i = 0; i < sessions.length; i += 1) {
    if (sessions[i]!.at < boundaryAt) return i
  }
  return sessions.length
}

/** Heaviest successfully-completed top weight at or after the layoff boundary.
 *  A session that fell short of its prescription does not raise the floor. */
function bestCompletedSince(
  sessions: readonly SessionMark[],
  boundaryAt: number,
): number | null {
  let best: number | null = null
  for (const s of sessions) {
    if (s.at < boundaryAt) continue
    if (s.metPrescription === false) continue
    if (s.topWeightLb != null && (best == null || s.topWeightLb > best)) best = s.topWeightLb
  }
  return best
}

/** First loaded top weight at or after `from`, walking older. */
function firstLoaded(sessions: readonly SessionMark[], from: number): number | null {
  for (let i = Math.max(0, from); i < sessions.length; i += 1) {
    const w = sessions[i]!.topWeightLb
    if (w != null && w > 0) return w
  }
  return null
}

/** One terse line for the workout payload. States the elapsed time, the
 *  adjustment, and when full load returns — so a changed weight is never a
 *  surprise the user has to reverse-engineer. */
function explain(gapDays: number, sessionsSinceReturn: number, factor: number): string {
  const pct = Math.round(factor * 100)
  const weeks = Math.round(gapDays / 7)
  const elapsed = weeks >= 2 ? `${weeks} weeks` : `${gapDays} days`
  const remaining = Math.max(0, RAMP_SESSIONS - sessionsSinceReturn)
  const tail =
    remaining <= 1
      ? 'back to full load next session.'
      : `full load in ${remaining} more sessions.`
  return sessionsSinceReturn === 0
    ? `${elapsed} since you last trained this — starting at ${pct}% to ease back in, ${tail}`
    : `easing back in after ${elapsed} off — session ${sessionsSinceReturn + 1} at ${pct}%, ${tail}`
}

/**
 * The de-loaded target for a set, in the exercise's dominant unit.
 *
 * ⚠️ Applies to the PRE-LAYOFF baseline, never to a weight the user authored by
 * hand. An explicitly-prescribed template weight is already a deliberate
 * restart load (#1790: Day 1 said 95 where this formula would say ~108) —
 * multiplying that again would de-load a de-load. Callers must only reach for
 * this where the number would otherwise come from history.
 */
export function deloadedTargetLb(
  signal: DetrainingSignal,
  unit: Unit,
  step?: number,
): number | null {
  if (signal.factor >= 1 || signal.baselineLb == null) return null
  const raw = signal.baselineLb * signal.factor
  const target = roundNearest(raw, step ?? (unit === 'kg' ? 2.5 : 5))
  // A ramp raises floors; it never lowers a weight the user has already completed in
  // this block. Overriding heavier and finishing it is DATA, not a mistake to
  // correct — the next session starts from there.
  if (signal.completedSinceReturnLb != null && signal.completedSinceReturnLb > target) {
    return roundNearest(signal.completedSinceReturnLb, step ?? (unit === 'kg' ? 2.5 : 5))
  }
  return target
}

/** One exercise's history-implied default, as `plan.ts` models it. */
export interface HistoryDefault {
  weight: number | null
  reps: number | null
}

/**
 * Apply the re-entry ramp to a whole map of history-implied defaults (#1790).
 *
 * Why here and not at the prescription site: `plan.ts` feeds this same map to
 * the candidate hints, the fallback targets AND the ±15%-of-history gate. If
 * only the target were de-loaded, the gate — still comparing against the stale
 * pre-layoff weight — would reject the de-load as an unjustified deviation.
 * De-loading at the source keeps all three consistent by construction.
 *
 * Pure. Returns a NEW map; `reasons` carries the per-exercise explanation for
 * whatever surface wants to show it.
 */
export function deloadHistoryDefaults(
  defaults: ReadonlyMap<string, HistoryDefault>,
  marksByExercise: ReadonlyMap<string, readonly SessionMark[]>,
  nowMs: number,
  unit: Unit = 'lb',
  /** Region marks keyed by exercise id. Omit and each exercise falls back to
   *  its own history, which is the pre-region behaviour. */
  regionMarksByExercise?: ReadonlyMap<string, readonly SessionMark[]>,
): { defaults: Map<string, HistoryDefault>; reasons: Map<string, string> } {
  const out = new Map<string, HistoryDefault>()
  const reasons = new Map<string, string>()
  for (const [id, def] of defaults) {
    const marks = marksByExercise.get(id)
    if (!marks || marks.length === 0 || def.weight == null) {
      out.set(id, def)
      continue
    }
    const signal = detrainingSignal(
      { exercise: marks, region: regionMarksByExercise?.get(id) },
      nowMs,
    )
    const target = deloadedTargetLb(signal, unit)
    if (target == null) {
      out.set(id, def)
      continue
    }
    out.set(id, { weight: target, reps: def.reps })
    if (signal.reason) reasons.set(id, signal.reason)
  }
  return { defaults: out, reasons }
}
