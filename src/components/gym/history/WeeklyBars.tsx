'use client'

/**
 * Workouts-per-week bars (GYM_PLAN §4 "Tab: History"): the last 8 weeks as a
 * house-SVG-free bar row (mirrors charts.tsx WeekBars). Each bar shows that week's
 * completed-workout count; hovering/tapping surfaces the count + volume. An
 * optional target line marks a weekly-workout goal.
 *
 * **Program-era bands** (simple version): subtle labeled background bands behind
 * the bars showing which template/program was active during a stretch. Eras are
 * mapped from their date span onto the 8-week axis; only eras that overlap the
 * visible window paint, and a band is labeled ("DAY 1 era") when it's wide enough.
 */
import { useMemo, useState } from 'react'

import { MonoLabel } from '@/components/health/primitives'
import type { ProgramEra, WeekBar } from './history-client'
import { volume, weekTick } from './format'

const TARGET = 4 // weekly-workout target line (default; informational)

export function WeeklyBars({
  weeks,
  eras,
  unit = 'lb',
}: {
  weeks: WeekBar[]
  eras: ProgramEra[]
  unit?: 'lb' | 'kg'
}) {
  const [hi, setHi] = useState<number | null>(null)
  const n = weeks.length

  const maxWorkouts = Math.max(TARGET, ...weeks.map((w) => w.workouts), 1)

  // Map eras onto week columns [startIdx, endIdx] within the visible window.
  const bands = useMemo(() => eraBands(weeks, eras), [weeks, eras])

  if (n === 0) {
    return (
      <div>
        <MonoLabel>Workouts / week</MonoLabel>
        <p style={emptyNote}>No sessions in the last 8 weeks.</p>
      </div>
    )
  }

  const active = hi == null ? null : weeks[hi]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <MonoLabel>Workouts / week</MonoLabel>
        {active ? (
          <span style={readout}>
            {active.workouts} workout{active.workouts === 1 ? '' : 's'} · {volume(active.volume ?? active.volumeLb, unit)}
          </span>
        ) : (
          <span style={{ ...readout, color: 'var(--fg-subtle)' }}>last 8 weeks · target {TARGET}</span>
        )}
      </div>

      {/* Bar area with era bands behind it. */}
      <div
        style={{ position: 'relative', height: 96, display: 'flex', alignItems: 'flex-end', gap: 5 }}
        onMouseLeave={() => setHi(null)}
      >
        {/* Era bands (behind bars) */}
        {bands.map((b, i) => (
          <div
            key={i}
            aria-hidden
            style={{
              position: 'absolute',
              top: 0,
              bottom: 16,
              left: `${(b.startIdx / n) * 100}%`,
              width: `${((b.endIdx - b.startIdx + 1) / n) * 100}%`,
              background: b.color,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'center',
              paddingTop: 4,
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
          >
            {b.wide && (
              <span style={bandLabel} title={b.label}>
                {b.label}
              </span>
            )}
          </div>
        ))}

        {/* Target line */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 16 + (TARGET / maxWorkouts) * (96 - 16),
            height: 0,
            borderTop: '1px dashed color-mix(in oklch, var(--fg-subtle) 60%, transparent)',
            pointerEvents: 'none',
          }}
        />

        {/* Bars */}
        {weeks.map((w, i) => {
          const on = hi === i
          const barH = w.workouts === 0 ? 3 : Math.max(6, (w.workouts / maxWorkouts) * (96 - 16))
          return (
            <button
              key={i}
              type="button"
              onMouseEnter={() => setHi(i)}
              onFocus={() => setHi(i)}
              onClick={() => setHi((cur) => (cur === i ? null : i))}
              aria-label={`Week of ${weekTick(w.weekStart)}: ${w.workouts} workouts, ${volume(w.volume ?? w.volumeLb, unit)}`}
              style={barBtn}
            >
              <span style={{ ...barCount, color: on ? 'var(--fg)' : 'transparent' }}>{w.workouts || ''}</span>
              <span
                style={{
                  width: '100%',
                  height: barH,
                  borderRadius: 3,
                  background:
                    w.workouts === 0
                      ? 'var(--border-muted)'
                      : on
                        ? 'color-mix(in oklch, var(--accent) 80%, white)'
                        : 'var(--accent)',
                  transition: 'background .12s',
                  position: 'relative',
                  zIndex: 1,
                }}
              />
              <span style={barTick}>{weekTick(w.weekStart)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── era → band mapping ───────────────────────────────────────────────────────
interface Band {
  startIdx: number
  endIdx: number
  label: string
  color: string
  wide: boolean
}

/** A rotating subtle palette for era bands (accent + neutrals, low alpha). */
const BAND_COLORS = [
  'color-mix(in oklch, var(--accent) 9%, transparent)',
  'color-mix(in oklch, var(--fg-subtle) 8%, transparent)',
  'color-mix(in oklch, var(--success, var(--accent)) 8%, transparent)',
]

/** Whole-day index (UTC) of a date, so week/era comparisons are timezone-agnostic
 *  regardless of whether an ISO carries a Z, an offset, or a bare 'YYYY-MM-DD'. */
function dayIndex(iso: string): number {
  // A bare date has no time → normalize to UTC midnight; a full ISO is parsed as-is
  // then floored to its UTC calendar day.
  const t = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso).getTime()
  if (Number.isNaN(t)) return NaN
  return Math.floor(t / 86_400_000)
}

/**
 * Map eras to visible week columns. An era covers weeks whose Monday..Sunday span
 * overlaps the era's [firstDate, lastDate]. Only eras that have a template (a real
 * program) paint — the null-template run is left blank (no "no program" band
 * clutter). Comparison is done on whole-day (UTC) indices so a Z-suffixed era date
 * and a bare week-start day compare on the same axis. Exported for tests.
 */
export function eraBands(weeks: WeekBar[], eras: ProgramEra[]): Band[] {
  if (weeks.length === 0) return []
  const weekStartDays = weeks.map((w) => dayIndex(w.weekStart))
  const bands: Band[] = []
  let colorIdx = 0

  for (const era of eras) {
    if (!era.templateId) continue // only real programs get a band
    const first = dayIndex(era.firstDate)
    const last = dayIndex(era.lastDate)
    if (Number.isNaN(first) || Number.isNaN(last)) continue

    // Weeks whose Monday..Sunday (7-day inclusive) span overlaps the era's days.
    let startIdx = -1
    let endIdx = -1
    for (let i = 0; i < weekStartDays.length; i++) {
      const wkStart = weekStartDays[i]!
      const wkEnd = wkStart + 6 // Sunday of that week
      if (last >= wkStart && first <= wkEnd) {
        if (startIdx === -1) startIdx = i
        endIdx = i
      }
    }
    if (startIdx === -1) continue // era doesn't overlap the visible window

    const width = endIdx - startIdx + 1
    bands.push({
      startIdx,
      endIdx,
      label: `${(era.templateName ?? 'Program').toUpperCase()} era`,
      color: BAND_COLORS[colorIdx % BAND_COLORS.length]!,
      wide: width >= 2,
    })
    colorIdx++
  }
  return bands
}

// ── styles ─────────────────────────────────────────────────────────────────
const readout: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-muted)',
}
const barBtn: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  height: '100%',
  justifyContent: 'flex-end',
  position: 'relative',
  zIndex: 1,
}
const barCount: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  height: 11,
  transition: 'color .1s',
}
const barTick: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8,
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
}
const bandLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 7.5,
  letterSpacing: '0.08em',
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '100%',
  padding: '0 4px',
}
const emptyNote: React.CSSProperties = {
  margin: '10px 0 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13,
  color: 'var(--fg-subtle)',
}
