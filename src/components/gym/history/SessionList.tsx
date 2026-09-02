'use client'

/**
 * Session list (GYM_PLAN §4 "Tab: History"): completed sessions newest-first, each
 * a tappable card → SessionDetailSheet. Previous/Next controls page through the
 * list without accumulating rows. Imported sessions (304 legacy, no template)
 * render clean — the template chip simply doesn't show.
 */
import { Loader2 } from 'lucide-react'

import { HCard, MonoLabel } from '@/components/health/primitives'
import { titleCase } from '@/components/gym/exercises/format'
import { normalizeGeneratedWorkoutName } from '@/lib/gym/display-name'
import type { SessionRow } from './history-client'
import { duration, shortDay, volume } from './format'

export function SessionList({
  sessions,
  page,
  hasNext,
  loadingPage,
  onOpen,
  onPrevious,
  onNext,
  unit = 'lb',
}: {
  sessions: SessionRow[]
  page: number
  hasNext: boolean
  loadingPage: boolean
  onOpen: (id: string) => void
  onPrevious: () => void
  onNext: () => void
  unit?: 'lb' | 'kg'
}) {
  const hasPrevious = page > 1
  const showPagination = hasPrevious || hasNext

  return (
    <div>
      <MonoLabel style={{ marginBottom: 12 }}>Sessions</MonoLabel>

      {sessions.length === 0 ? (
        <p style={emptyNote}>No completed sessions yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sessions.map((s) => (
            <Row key={s.id} s={s} unit={unit} onOpen={() => onOpen(s.id)} />
          ))}
        </div>
      )}

      {showPagination && (
        <nav aria-label="Session pages" style={pagination}>
          <button
            type="button"
            onClick={onPrevious}
            disabled={!hasPrevious || loadingPage}
            style={{
              ...pageButton,
              cursor: !hasPrevious || loadingPage ? 'default' : 'pointer',
              opacity: !hasPrevious || loadingPage ? 0.45 : 1,
            }}
          >
            Previous
          </button>
          <span aria-live="polite" aria-atomic="true" style={pageStatus}>
            {loadingPage && <Loader2 size={12} className="gym-spin" aria-hidden="true" />}
            {loadingPage ? 'Loading sessions…' : `Page ${page}`}
          </span>
          <button
            type="button"
            onClick={onNext}
            disabled={!hasNext || loadingPage}
            style={{
              ...pageButton,
              cursor: !hasNext || loadingPage ? 'default' : 'pointer',
              opacity: !hasNext || loadingPage ? 0.45 : 1,
            }}
          >
            Next
          </button>
        </nav>
      )}
      <style>{`@keyframes gym-spin { to { transform: rotate(360deg); } } .gym-spin { animation: gym-spin .8s linear infinite; }`}</style>
    </div>
  )
}

function Row({ s, unit, onOpen }: { s: SessionRow; unit: 'lb' | 'kg'; onOpen: () => void }) {
  const displayName = normalizeGeneratedWorkoutName(s.name ?? 'Workout')
  const meta = [
    duration(s.durationSeconds),
    `${s.exerciseCount} ex`,
    `${s.setCount} sets`,
    volume(s.volume ?? s.volumeLb, unit),
  ]
    .filter((x) => x !== '—')
    .join(' · ')

  return (
    <HCard pad={12} onClick={onOpen} hover ariaLabel={`Open ${displayName} from ${shortDay(s.date)}`}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={rowName}>{displayName}</span>
            {s.templateName && <span style={tplChip}>{titleCase(s.templateName)}</span>}
            {s.prCount != null && s.prCount > 0 && (
              <span style={prBadge}>
                {s.prCount} PR{s.prCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {meta && <div style={rowMeta}>{meta}</div>}
        </div>
        <span style={rowDate}>{shortDay(s.date)}</span>
      </div>
    </HCard>
  )
}

// ── styles ─────────────────────────────────────────────────────────────────
const rowName: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 14.5,
  color: 'var(--fg)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
const tplChip: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-muted)',
  borderRadius: 5,
  padding: '1.5px 6px',
  flexShrink: 0,
  whiteSpace: 'nowrap',
}
const prBadge: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  fontWeight: 600,
  letterSpacing: '0.04em',
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  borderRadius: 5,
  padding: '1.5px 6px',
  flexShrink: 0,
}
const rowMeta: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-subtle)',
  marginTop: 5,
}
const rowDate: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}
const pagination: React.CSSProperties = {
  marginTop: 10,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
  alignItems: 'center',
  gap: 8,
}
const pageButton: React.CSSProperties = {
  minWidth: 0,
  padding: '9px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.05em',
  color: 'var(--fg-muted)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
}
const pageStatus: React.CSSProperties = {
  minWidth: 68,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
}
const emptyNote: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13,
  color: 'var(--fg-subtle)',
}
