/**
 * Formatting helpers for the Gym Exercises surfaces — relative "last performed"
 * stamps, set counts, weights, durations. Pure + dependency-free.
 */

import { formatDistance, type DistanceUnit } from '@/lib/units/system'

/** ISO date → "today" / "5d ago" / "3w ago" / "Mar 4". null → "—". */
export function relTime(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  const ms = then.getTime()
  if (Number.isNaN(ms)) return '—'
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 28) return `${Math.floor(days / 7)}w ago`
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** ISO date → "Mar 4, '25" (short, year-suffixed). null → "—". */
export function shortStamp(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
}

/** "430 sets" / "1 set" / "no sets". */
export function setCount(n: number): string {
  if (!n) return 'no sets'
  return `${n.toLocaleString('en-US')} set${n === 1 ? '' : 's'}`
}

/** Trim trailing .0 — 185 not 185.0, but 62.5 stays. */
export function num(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

/** Seconds → "1:30" / "0:45" (mm:ss). */
export function mmss(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Seconds → "45:12" (mm:ss) under an hour, then "1h 5m" / "1h 30m" past it. */
export function elapsedClock(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  if (s < 3600) return mmss(s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}h ${m}m`
}

/** Canonical metres → the selected gym distance unit. */
export function meters(m: number | null | undefined, unit: DistanceUnit = 'm'): string {
  return formatDistance(m, unit) || '—'
}

/** A weight × reps set label, e.g. "185 × 5 lb". Bodyweight-only → "12 reps". */
export function setLabel(weight: number | null, reps: number | null, unit: string): string {
  if (weight != null && weight > 0) return `${num(weight)} × ${reps ?? '—'}${unit ? ` ${unit}` : ''}`
  if (reps != null) return `${reps} reps`
  return '—'
}

/** Pretty a snake/space equipment or category token → "Barbell", "Olympic Barbell". */
export function titleCase(token: string | null | undefined): string {
  if (!token) return ''
  return token
    .replace(/[_-]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
