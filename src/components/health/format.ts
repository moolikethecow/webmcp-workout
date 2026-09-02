/**
 * Number/date formatting for the /health redesign — mirrors the design
 * prototype's `hfmt` helpers exactly (charts.jsx).
 */

/** Locale number with fixed decimals; '—' for missing. */
export function nf(v: number | null | undefined, round = 0): string {
  if (v == null || Number.isNaN(v)) return '—'
  const f = Math.pow(10, round)
  const r = Math.round(v * f) / f
  return round === 0 ? Math.round(r).toLocaleString('en-US') : r.toFixed(round)
}

/** Hours → '7h 04m'. */
export function fmtH(h: number | null | undefined): string {
  if (h == null || Number.isNaN(h)) return '—'
  const m = Math.round(h * 60)
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Hours → '7:04' (clock-style duration). */
export function fmtClock(h: number): string {
  const m = Math.round(h * 60)
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

/** 'YYYY-MM-DD' → 'Mon, Jun 29'. */
export function niceDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

/** 'YYYY-MM-DD' → 'Jun 29'. */
export function shortDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** WAKE date 'YYYY-MM-DD' → the night a human calls it: 'Wed night · Jul 22'.
 *  Sleep data is keyed by Apple's wake-date convention, so the bar for the
 *  night of Wednesday carries Thursday's date — labeling it 'Thu, Jul 23'
 *  reads like a night that hasn't happened yet. Noon anchor avoids DST edges. */
export function nightDate(wakeDate: string): string {
  const d = new Date(`${wakeDate}T12:00:00`)
  d.setDate(d.getDate() - 1)
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' })
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${wd} night · ${md}`
}

/** Header stamp → 'Mon · Jun 29 · 7:30a', rendered in the given IANA timezone
 *  (the app timezone). Falls back to the runtime's local zone when `tz` is
 *  omitted or not a valid zone — so a bad value degrades instead of throwing. */
export function fmtStamp(d: Date, tz?: string): string {
  const fmt = (opts: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat('en-US', tz ? { ...opts, timeZone: tz } : opts).formatToParts(d)
    } catch {
      return new Intl.DateTimeFormat('en-US', opts).formatToParts(d)
    }
  }
  const val = (parts: Intl.DateTimeFormatPart[], type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const wd = val(fmt({ weekday: 'short' }), 'weekday')
  const dateParts = fmt({ month: 'short', day: 'numeric' })
  const md = `${val(dateParts, 'month')} ${val(dateParts, 'day')}`
  const time = fmt({ hour: 'numeric', minute: '2-digit', hour12: true })
  const ap = val(time, 'dayPeriod').toLowerCase().startsWith('p') ? 'p' : 'a'
  return `${wd} · ${md} · ${val(time, 'hour')}:${val(time, 'minute')}${ap}`
}
