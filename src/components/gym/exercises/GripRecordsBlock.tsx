'use client'

/**
 * Per-handle bests on the exercise detail sheet.
 *
 * A wide-grip pulldown and one on the MAG handle are not equally hard, so a
 * single "best set" quietly rewards whichever was easier. This shows one row
 * per way the movement has actually been held — while the exercise keeps ONE
 * history above, because splitting it would break the trend line the moment the
 * handle changed.
 *
 * Renders nothing at all when there is nothing to compare: most exercises are
 * done one way, and every set logged before grip existed has no handle
 * recorded. An empty panel saying "no grip data" would be noise on almost every
 * exercise in the catalog.
 *
 * Stat-strip house style — borderless rows, hairline dividers, one terse token
 * per row — rather than the bordered tiles above, so it reads as a breakdown of
 * the records rather than a second, competing set of them.
 */
import type { GripRecordsSummary } from '@/lib/gym-client/types'
import { meters, mmss } from './format'

export function GripRecordsBlock({
  gripRecords,
  perSide = false,
}: {
  gripRecords?: GripRecordsSummary[]
  perSide?: boolean
}) {
  if (!gripRecords || gripRecords.length === 0) return null

  return (
    <section style={wrap} aria-label="Bests by grip">
      <div style={heading}>By grip</div>
      <div>
        {gripRecords.map((g) => (
          <div key={g.key} style={row}>
            <div style={nameCell}>
              {/* A null label is the bucket of sets logged before the handle was
                  recorded — real work, honestly not comparable. */}
              {g.label ?? <span style={unspecified}>Grip not recorded</span>}
            </div>
            <div style={valueCell}>{bestLine(g, perSide) ?? '—'}</div>
            <div style={countCell}>
              {g.sets} set{g.sets === 1 ? '' : 's'} · {g.sessions} session
              {g.sessions === 1 ? '' : 's'}
            </div>
          </div>
        ))}
      </div>
      <p style={foot}>
        Shown once a grip has at least 6 sets across 2 sessions — below that it is one good day,
        not a record.
      </p>
    </section>
  )
}

/** The single most useful number for this track, or null if there isn't one. */
function bestLine(g: GripRecordsSummary, perSide: boolean): string | null {
  const r = g.records
  if (r.bestWeight) {
    const unit = `${r.bestWeight.unit}${perSide ? '/side' : ''}`
    return `${r.bestWeight.value} ${unit} × ${r.bestWeight.reps}`
  }
  if (r.bestDuration) return mmss(r.bestDuration.value)
  if (r.bestDistance) return meters(r.bestDistance.value)
  const top = r.repMaxes?.[r.repMaxes.length - 1]
  return top ? `${top.reps} reps` : null
}

const wrap: React.CSSProperties = { marginTop: 16 }

const heading: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  marginBottom: 4,
}

const row: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) auto',
  gap: 10,
  alignItems: 'baseline',
  padding: '8px 0',
  borderTop: '1px solid var(--border-muted)',
}

const nameCell: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--fg)',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const unspecified: React.CSSProperties = { color: 'var(--fg-subtle)', fontStyle: 'italic' }

const valueCell: React.CSSProperties = {
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg)',
}

const countCell: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  color: 'var(--fg-subtle)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const foot: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-subtle)',
  margin: '8px 0 0',
  lineHeight: 1.45,
}
