/**
 * Rest-timer + display-unit pure helpers (GYM_PLAN §4 "Rest timer (honest iOS
 * story)" + "Units", P2b). No React, no store, no wall-clock capture inside the
 * math — every function takes `now` explicitly so it's deterministic and
 * throttle-proof (the timer is timestamp-math: we store `endsAt` and derive the
 * remaining time on each tick; a backgrounded tab that misses ticks still reads
 * the correct value the instant it foregrounds).
 */

import type { Unit } from './active-types'
import {
  KG_TO_LB,
  LB_TO_KG,
  convertWeight as convertWeightValue,
} from '@/lib/units/weight'

// ── rest countdown (timestamp-math) ──────────────────────────────────────────

export interface RestTimerState {
  /** Epoch ms when the countdown hits zero. */
  endsAt: number
  /** Which exercise's ✓ started this rest (for the "resting after X" label). */
  exerciseId: string
  /** The full duration the timer was started/adjusted to (for the ring fraction). */
  totalMs: number
}

/** Remaining ms until `endsAt`, clamped at 0 (never negative). */
export function remainingMs(state: RestTimerState | null, now: number): number {
  if (!state) return 0
  return Math.max(0, state.endsAt - now)
}

/** Whole seconds remaining (rounded UP so "0:01" shows until the true zero). */
export function remainingSeconds(state: RestTimerState | null, now: number): number {
  return Math.ceil(remainingMs(state, now) / 1000)
}

/** True once the countdown has reached (or passed) zero. */
export function isRestDone(state: RestTimerState | null, now: number): boolean {
  return !!state && now >= state.endsAt
}

/**
 * Fraction of the ring still to go, 0..1 (1 = just started, 0 = done). Derived
 * from `totalMs` so +30s / −15s adjust the ring proportionally.
 */
export function ringFraction(state: RestTimerState | null, now: number): number {
  if (!state || state.totalMs <= 0) return 0
  return clamp01(remainingMs(state, now) / state.totalMs)
}

/** Start a fresh rest state ending `seconds` from `now`. */
export function startRestState(exerciseId: string, seconds: number, now: number): RestTimerState {
  const ms = Math.max(0, Math.round(seconds * 1000))
  return { endsAt: now + ms, exerciseId, totalMs: ms }
}

/**
 * Adjust a running timer by `deltaSeconds` (+30 / −15). Both `endsAt` and the
 * ring's `totalMs` shift so the proportion stays honest; never lets the total go
 * below the current remaining (a −15 that would strand the ring is clamped to
 * "now"). Returns null when the adjustment empties the timer (→ treat as skip).
 */
export function adjustRestState(
  state: RestTimerState,
  deltaSeconds: number,
  now: number,
): RestTimerState | null {
  const nextEndsAt = state.endsAt + Math.round(deltaSeconds * 1000)
  if (nextEndsAt <= now) return null
  // Keep totalMs ≥ the new remaining so ringFraction stays within 0..1.
  const remaining = nextEndsAt - now
  const totalMs = Math.max(state.totalMs + Math.round(deltaSeconds * 1000), remaining)
  return { ...state, endsAt: nextEndsAt, totalMs }
}

/** "1:30" / "0:05" — mm:ss for a remaining-seconds count. */
export function formatRest(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Resolve the rest duration for a completed set: the warmup-specific rest when the
 * set is warmup-tagged AND a warmup rest is configured, else the working rest.
 * `restSecondsWarmup` is optional (the server read model may not carry it yet) —
 * when absent we fall back to the working rest, so the timer still fires.
 */
export function restSecondsForSet(
  isWarmup: boolean,
  restSeconds: number,
  restSecondsWarmup: number | null | undefined,
  setRestSeconds?: number | null,
): number {
  if (setRestSeconds != null) return Math.max(0, setRestSeconds)
  if (isWarmup && restSecondsWarmup != null && restSecondsWarmup > 0) return restSecondsWarmup
  return restSeconds
}

// ── display-unit conversion (GYM_PLAN §8 — DISPLAY only, never mutates rows) ──

export { KG_TO_LB, LB_TO_KG }

/**
 * Convert a stored weight (in `from` unit) to the display `to` unit. Pure display
 * math — the STORED value never changes (stored-as-entered invariant). null → null.
 * Rounds to 2dp; lb→lb / kg→kg pass through untouched.
 */
export function convertWeight(
  value: number | null,
  from: Unit,
  to: Unit,
): number | null {
  return convertWeightValue(value, from, to, 2)
}

/** Plate-stepper increments per display unit (lb → 2.5/5/10, kg → 1.25/2.5/5). */
export const UNIT_STEPS: Record<Unit, number[]> = {
  lb: [2.5, 5, 10],
  kg: [1.25, 2.5, 5],
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * Below this, a BARE number typed as a rest time is treated as ambiguous.
 *
 * Real sessions carry a prescribed rest_seconds=3 and =4 sitting between 120s
 * and 140s siblings (#1832). The reported cause was "timer-skip artifacts", but
 * skipping the rest timer writes nothing — the only writers are the two rest
 * inputs, both of which read a bare number as SECONDS. So those were typed and
 * committed meaning MINUTES: "3" for a 3:00 rest. Prescribed rest is a
 * programming concern (too-short rests once risked a shoulder injury), so the
 * units question is asked rather than guessed in either direction.
 */
export const AMBIGUOUS_REST_BELOW_SECONDS = 15

/**
 * Does this raw entry need the units question before it can be saved?
 *
 * Only a BARE number qualifies. An explicit "0:03" states seconds and is taken
 * at its word; 0 means straight into the next set and is never questioned.
 *
 * ⚠️ Both rest inputs (the logger's SetRestPicker and history's inline
 * RestLine) must ask the SAME question — they parse separately, and a rule that
 * lives in one of them is a rule the other silently disagrees with.
 */
export function isAmbiguousBareRest(raw: string, seconds: number): boolean {
  return !raw.includes(':') && seconds > 0 && seconds < AMBIGUOUS_REST_BELOW_SECONDS
}
