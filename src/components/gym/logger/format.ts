/**
 * Pure formatting + stepper helpers for the logger (GYM_PLAN §4, §3a). No React,
 * no store — unit-tested in isolation.
 */

import type { PreviousSet, TargetSet } from '@/lib/gym-client/active-types'
import { formatDistance, type DistanceUnit } from '@/lib/units/system'

/** Plate steppers per unit (§4 numeric pad): lb → +2.5/+5/+10, kg → +1.25/+2.5/+5. */
export const PLATE_STEPS: Record<'lb' | 'kg', number[]> = {
  lb: [2.5, 5, 10],
  kg: [1.25, 2.5, 5],
}

/** The RPE quick-row values (§4). */
export const RPE_VALUES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10] as const

/** Trim trailing .0 — 185 not 185.0, 62.5 stays. null/NaN → "". */
export function trimNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return ''
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

/** Seconds → "1:30" / "0:45" (mm:ss). null → "". */
export function secToMmss(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return ''
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Canonical metres → the selected distance unit. null → "". */
export function metersLabel(m: number | null | undefined, unit: DistanceUnit = 'm'): string {
  return formatDistance(m, unit)
}

/**
 * The "previous" ghost column text for a set, per tracks shape:
 *   weight_reps      → "185 × 8" (+prefix on weighted, −prefix on assisted handled by caller)
 *   reps             → "8"
 *   time             → "1:30" (weight prefix when present)
 *   distance_time    → "800 m · 5:00"
 * Falls back to the progression TARGET when there's no previous set. "" when neither.
 */
export function previousText(
  tracks: string,
  prev: PreviousSet | undefined,
  target: TargetSet | undefined,
  distanceUnit: DistanceUnit = 'm',
): string {
  switch (tracks) {
    case 'weight_reps':
    case 'weighted_bodyweight':
    case 'assisted_bodyweight': {
      const w = prev?.weight ?? target?.weight
      const r = prev?.reps ?? target?.reps
      if (w == null && r == null) return ''
      if (w == null || w === 0) return r != null ? `${r}` : ''
      return `${trimNum(w)} × ${r ?? '—'}`
    }
    case 'reps': {
      const r = prev?.reps ?? target?.reps
      return r != null ? `${r}` : ''
    }
    case 'time': {
      const d = prev?.durationS ?? target?.durationS
      const w = prev?.weight ?? target?.weight
      if (d == null) return ''
      return w != null && w > 0 ? `${trimNum(w)} · ${secToMmss(d)}` : secToMmss(d)
    }
    case 'distance_time': {
      const dist = prev?.distanceM
      const dur = prev?.durationS
      const parts: string[] = []
      if (dist != null) parts.push(metersLabel(dist, distanceUnit))
      if (dur != null) parts.push(secToMmss(dur))
      return parts.join(' · ')
    }
    default:
      return ''
  }
}

/** A tiny "target 190×8" hint shown UNDER a row when a target exists AND differs
 *  from the previous placeholder (the policy nudging up). "" otherwise. */
export function targetHint(
  tracks: string,
  prev: PreviousSet | undefined,
  target: TargetSet | undefined,
): string {
  if (!target) return ''
  // Only weight_reps-family nudges are hinted (the common progression case).
  if (tracks !== 'weight_reps' && tracks !== 'weighted_bodyweight') return ''
  const pw = prev?.weight
  const pr = prev?.reps
  const tw = target.weight
  const tr = target.reps
  if (tw == null && tr == null) return ''
  const differs = (tw != null && tw !== pw) || (tr != null && tr !== pr)
  if (!differs) return ''
  // Terse token — it renders stacked under the Previous value inside that same
  // grid cell, so the arrow carries the "go here next" meaning without the word.
  return `→ ${trimNum(tw)}${tr != null ? `×${tr}` : ''}`
}

/** Whether `prescriptionSummary` would say anything worth carrying over — at
 *  least one working (non-warmup) target carries a real value (#1876 "keep the
 *  prescribed load/reps as your target?" replace-confirm prompt). */
export function hasPrescription(targets: TargetSet[]): boolean {
  return targets.some(
    (t) =>
      t.setType !== 'warmup' &&
      (t.weight != null || t.reps != null || t.durationS != null || t.distanceM != null),
  )
}

/** Summarize prescribed targets as "3 sets · 105×10 top" (top = heaviest working
 *  target) — the #1876 replace-confirm prompt's "keep this as your target?" line.
 *  "" when there is no working target. Mirrors `collapsedSummary`'s per-tracks
 *  shape but over TARGETS (optional numeric fields, no completed/side pairing —
 *  a confirm prompt doesn't need the legacy L/R round accounting). */
export function prescriptionSummary(
  tracks: string,
  targets: TargetSet[],
  distanceUnit: DistanceUnit = 'm',
): string {
  const working = targets.filter((t) => t.setType !== 'warmup')
  if (working.length === 0) return ''
  const setWord = `${working.length} set${working.length === 1 ? '' : 's'}`

  if (tracks === 'time') {
    const best = working.reduce<number | null>((m, t) => Math.max(m ?? 0, t.durationS ?? 0) || m, null)
    return best != null ? `${setWord} · ${secToMmss(best)}` : setWord
  }
  if (tracks === 'distance_time') {
    const dist = working.reduce((sum, t) => sum + (t.distanceM ?? 0), 0)
    return dist > 0 ? `${setWord} · ${metersLabel(dist, distanceUnit)}` : setWord
  }
  if (tracks === 'reps') {
    const best = working.reduce<number | null>(
      (m, t) => (t.reps != null && (m == null || t.reps > m) ? t.reps : m),
      null,
    )
    return best != null ? `${setWord} · ${best} reps top` : setWord
  }
  const top = working.reduce<{ w: number; r: number | null } | null>((best, t) => {
    if (t.weight == null) return best
    if (!best || t.weight > best.w) return { w: t.weight, r: t.reps ?? null }
    return best
  }, null)
  if (!top) return setWord
  return `${setWord} · ${trimNum(top.w)}×${top.r ?? '—'} top`
}

/** The one-line collapsed summary: "4 sets · 170×8 top" (top = heaviest working set). */
export function collapsedSummary(
  tracks: string,
  sets: Array<{
    setType: string
    weight: number | null
    reps: number | null
    durationS: number | null
    distanceM: number | null
    completed: boolean
    logicalSetId?: string
    side?: 'left' | 'right' | null
  }>,
  distanceUnit: DistanceUnit = 'm',
): string {
  const working = sets.filter((s) => s.setType !== 'warmup')
  const ids = new Set(working.flatMap((set) => set.logicalSetId ? [set.logicalSetId] : []))
  let legacyRounds = 0
  for (let index = 0; index < working.length; index += 1) {
    if (working[index]!.logicalSetId) continue
    legacyRounds += 1
    const next = working[index + 1]
    if (
      working[index]!.side != null &&
      next?.logicalSetId == null &&
      next?.side != null &&
      working[index]!.side !== next.side &&
      (working[index]!.setType ?? 'normal') === (next.setType ?? 'normal')
    ) index += 1
  }
  const n = ids.size + legacyRounds
  const setWord = `${n} set${n === 1 ? '' : 's'}`

  if (tracks === 'time') {
    const best = working.reduce<number | null>((m, s) => Math.max(m ?? 0, s.durationS ?? 0) || m, null)
    return best != null ? `${setWord} · ${secToMmss(best)}` : setWord
  }
  if (tracks === 'distance_time') {
    const dist = working.reduce((sum, s) => sum + (s.distanceM ?? 0), 0)
    return dist > 0 ? `${setWord} · ${metersLabel(dist, distanceUnit)}` : setWord
  }
  if (tracks === 'reps') {
    const best = working.reduce<number | null>((m, s) => (s.reps != null && (m == null || s.reps > m) ? s.reps : m), null)
    return best != null ? `${setWord} · ${best} reps top` : setWord
  }
  // weight tracks: heaviest working set
  const top = working.reduce<{ w: number; r: number | null } | null>((best, s) => {
    if (s.weight == null) return best
    if (!best || s.weight > best.w) return { w: s.weight, r: s.reps }
    return best
  }, null)
  if (!top) return setWord
  return `${setWord} · ${trimNum(top.w)}×${top.r ?? '—'} top`
}
