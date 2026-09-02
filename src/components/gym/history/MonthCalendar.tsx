'use client'

/**
 * Compact month activity summary (GYM_PLAN §4 "Tab: History"). The default view
 * shows only the latest workout days, bounded to one short row even in a busy
 * month. An accessible disclosure reveals the complete 7-wide calendar on
 * demand. Tapping a workout day opens its session / jumps the session list.
 */
import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { MonoLabel } from '@/components/health/primitives'
import type { CalendarDay } from './history-client'
import { monthGrid, monthLabel } from './format'

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const
const MAX_COMPACT_DAYS = 5
const SHORT_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' })
const LONG_DATE = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
})

export function MonthCalendar({
  month,
  days,
  onPrev,
  onNext,
  onPickDay,
}: {
  month: string
  days: CalendarDay[]
  onPrev: () => void
  onNext: () => void
  /** Called with the day's workout ids when a workout day is tapped. */
  onPickDay: (date: string, workoutIds: string[]) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const byDate = new Map(days.map((d) => [d.date, d]))
  const cells = monthGrid(month)
  const workoutDays = days
    .filter((day) => day.count > 0 && day.date.startsWith(`${month}-`))
    .sort((a, b) => a.date.localeCompare(b.date))
  const compactDays = workoutDays.slice(-MAX_COMPACT_DAYS)
  const hiddenDayCount = workoutDays.length - compactDays.length
  const workoutCount = workoutDays.reduce((total, day) => total + day.count, 0)
  const fullGridId = `history-month-grid-${month}`

  return (
    <div>
      {/* Month header + nav */}
      <div style={headRow}>
        <MonoLabel>Calendar</MonoLabel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <NavBtn label="Previous month" onClick={onPrev}>
            <ChevronLeft size={15} />
          </NavBtn>
          <span style={monthText}>{monthLabel(month)}</span>
          <NavBtn label="Next month" onClick={onNext}>
            <ChevronRight size={15} />
          </NavBtn>
        </div>
      </div>

      <div style={summaryRow}>
        <span style={summaryText}>
          {workoutCount === 0
            ? 'No workouts this month'
            : `${workoutCount} workout${workoutCount === 1 ? '' : 's'} on ${workoutDays.length} day${workoutDays.length === 1 ? '' : 's'}`}
        </span>
        {workoutDays.length > 0 && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={fullGridId}
            onClick={() => setExpanded((value) => !value)}
            style={toggleButton}
          >
            {expanded ? 'Hide full month' : 'Show full month'}
          </button>
        )}
      </div>

      {!expanded && compactDays.length > 0 && (
        <div role="list" aria-label={`Workout days in ${monthLabel(month)}`} style={compactRow}>
          {compactDays.map((day) => (
            <div role="listitem" key={day.date}>
              <button
                type="button"
                onClick={() => onPickDay(day.date, day.workoutIds)}
                aria-label={workoutDayLabel(day.date, day.count)}
                style={compactDayButton}
              >
                <span style={compactWeekday}>{shortWeekday(day.date)}</span>
                <span style={compactDayNumber}>{Number(day.date.slice(-2))}</span>
                {day.count > 1 ? <span style={countPill}>{day.count}</span> : <span style={dot} aria-hidden />}
              </button>
            </div>
          ))}
          {hiddenDayCount > 0 && (
            <span style={moreDays} aria-label={`${hiddenDayCount} earlier workout days available in the full month`}>
              +{hiddenDayCount} earlier
            </span>
          )}
        </div>
      )}

      {expanded && (
        <div id={fullGridId} role="group" aria-label={`Full calendar for ${monthLabel(month)}`} style={expandedGrid}>
          {/* Weekday header */}
          <div style={grid} aria-hidden>
            {WEEKDAYS.map((w, i) => (
              <div key={i} style={weekdayCell}>
                {w}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div style={grid}>
            {cells.map((cell, i) => {
              if (!cell.date) return <div key={i} style={{ height: 36 }} />
              const hit = byDate.get(cell.date)
              const has = hit != null && hit.count > 0
              return (
                <button
                  key={i}
                  type="button"
                  disabled={!has}
                  onClick={() => has && onPickDay(cell.date!, hit!.workoutIds)}
                  aria-label={has ? workoutDayLabel(cell.date, hit.count) : fullDate(cell.date)}
                  style={{
                    ...dayCell,
                    cursor: has ? 'pointer' : 'default',
                    background: has ? 'color-mix(in oklch, var(--accent) 12%, var(--bg-elevated))' : 'transparent',
                    borderColor: has ? 'color-mix(in oklch, var(--accent) 35%, transparent)' : 'transparent',
                  }}
                >
                  <span style={{ ...dayNum, color: has ? 'var(--fg)' : 'var(--fg-subtle)' }}>{cell.day}</span>
                  {has &&
                    (hit.count > 1 ? (
                      <span style={countPill}>{hit.count}</span>
                    ) : (
                      <span style={dot} aria-hidden />
                    ))}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function asUtcDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`)
}

function shortWeekday(date: string): string {
  return SHORT_DAY.format(asUtcDate(date)).toUpperCase()
}

function fullDate(date: string): string {
  return LONG_DATE.format(asUtcDate(date))
}

function workoutDayLabel(date: string, count: number): string {
  return `${fullDate(date)}: ${count} workout${count === 1 ? '' : 's'}`
}

function NavBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 44,
        height: 44,
        borderRadius: 8,
        border: '1px solid var(--border-muted)',
        background: 'var(--bg-elevated)',
        color: 'var(--fg-muted)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

// ── styles ─────────────────────────────────────────────────────────────────
const headRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 6,
  gap: 10,
}
const monthText: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  letterSpacing: '0.04em',
  color: 'var(--fg-muted)',
  minWidth: 88,
  textAlign: 'center',
}
const summaryRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  minHeight: 44,
}
const summaryText: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  letterSpacing: '0.03em',
  color: 'var(--fg-muted)',
}
const toggleButton: React.CSSProperties = {
  minHeight: 44,
  padding: '0 4px',
  border: 0,
  background: 'transparent',
  color: 'var(--accent-bright)',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.03em',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}
const compactRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  paddingTop: 4,
}
const compactDayButton: React.CSSProperties = {
  position: 'relative',
  width: 48,
  height: 48,
  padding: 0,
  borderRadius: 9,
  border: '1px solid color-mix(in oklch, var(--accent) 35%, transparent)',
  background: 'color-mix(in oklch, var(--accent) 12%, var(--bg-elevated))',
  color: 'var(--fg)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 1,
  cursor: 'pointer',
}
const compactWeekday: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8,
  lineHeight: 1,
  letterSpacing: '0.07em',
  color: 'var(--fg-subtle)',
}
const compactDayNumber: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  lineHeight: 1.2,
  fontVariantNumeric: 'tabular-nums',
}
const moreDays: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
}
const expandedGrid: React.CSSProperties = {
  paddingTop: 6,
}
const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(7, 1fr)',
  gap: 4,
}
const weekdayCell: React.CSSProperties = {
  textAlign: 'center',
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.06em',
  color: 'var(--fg-subtle)',
  padding: '2px 0 6px',
}
const dayCell: React.CSSProperties = {
  position: 'relative',
  height: 36,
  borderRadius: 8,
  border: '1px solid transparent',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 3,
  padding: 0,
  fontFamily: 'inherit',
  transition: 'background .12s',
}
const dayNum: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
}
const dot: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: '50%',
  background: 'var(--accent)',
}
const countPill: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8,
  fontWeight: 600,
  lineHeight: 1,
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  borderRadius: 999,
  padding: '1.5px 4px',
}
