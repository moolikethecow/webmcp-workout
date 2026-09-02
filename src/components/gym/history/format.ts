/**
 * Pure formatting + date helpers for the History tab. Dependency-free and tested.
 * Calendar math is done on LOCAL calendar days (the API already emits 'YYYY-MM-DD'
 * local days), so a session logged late at night lands on the right square.
 */

/** 'YYYY-MM' → { year, month } (month 1-12). */
export function parseMonth(month: string): { year: number; month: number } {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return { year: y, month: m }
}

/** The current server-local month as 'YYYY-MM'. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** Shift a 'YYYY-MM' by ±n months, clamping into a valid month. */
export function shiftMonth(month: string, delta: number): string {
  const { year, month: m } = parseMonth(month)
  const zero = year * 12 + (m - 1) + delta
  const ny = Math.floor(zero / 12)
  const nm = (zero % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
}

/** 'YYYY-MM' → "July 2026". */
export function monthLabel(month: string): string {
  const { year, month: m } = parseMonth(month)
  const d = new Date(year, m - 1, 1)
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export interface CalendarCell {
  /** null for leading/trailing blanks in the grid. */
  date: string | null
  day: number | null
}

/**
 * Build the 6×7 (or 5×7) grid cells for a month, Monday-first. Leading blanks pad
 * to the month's first weekday; trailing cells fill the final week. Each real cell
 * carries its 'YYYY-MM-DD' so the caller can match calendar hits by date string.
 */
export function monthGrid(month: string): CalendarCell[] {
  const { year, month: m } = parseMonth(month)
  const first = new Date(year, m - 1, 1)
  const daysInMonth = new Date(year, m, 0).getDate()
  // JS getDay(): 0=Sun..6=Sat → Monday-first index 0=Mon..6=Sun.
  const firstWeekday = (first.getDay() + 6) % 7

  const cells: CalendarCell[] = []
  for (let i = 0; i < firstWeekday; i++) cells.push({ date: null, day: null })
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({
      date: `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      day: d,
    })
  }
  // Pad the final row to a full week.
  while (cells.length % 7 !== 0) cells.push({ date: null, day: null })
  return cells
}

/** Seconds → "1h 12m" / "48m" / "—". */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${total}s`
}

/** A weight-unit volume → "12,340 lb" / "5,598 kg" / "—". */
export function volume(value: number | null | undefined, unit: 'lb' | 'kg' = 'lb'): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—'
  return `${Math.round(value).toLocaleString('en-US')} ${unit}`
}

/** ISO → "Jul 8" (short weekday-less). */
export function shortDay(iso: string): string {
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** ISO → "Tue, Jul 8" (weekday + date, for the session detail header). */
export function longDay(iso: string): string {
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

/** 'YYYY-MM-DD' Monday → "Jul 7" tick label for the weekly bars. */
export function weekTick(weekStartIso: string): string {
  const d = new Date(`${weekStartIso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** A weight × reps set label, e.g. "185 × 5" (unit shown separately). Bodyweight → "12". */
export function setValue(weight: number | null, reps: number | null, unit: string): string {
  const w = weight != null && weight > 0 ? trimNum(weight) : null
  if (w != null) return `${w}${unit ? ` ${unit}` : ''} × ${reps ?? '—'}`
  if (reps != null) return `${reps} reps`
  return '—'
}

/** Seconds → "1:30" mm:ss (for time-track sets). */
export function mmss(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Trim trailing .0 — 185 not 185.0, but 62.5 stays. */
export function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

/** Superset A1/B1-style label from (group, indexWithinGroup). null group → ''. */
export function supersetLabel(group: number | null, indexWithinGroup: number): string {
  if (group == null) return ''
  // Letter by group-appearance is resolved by the caller; here we just index reps.
  return String.fromCharCode(65 + indexWithinGroup)
}
