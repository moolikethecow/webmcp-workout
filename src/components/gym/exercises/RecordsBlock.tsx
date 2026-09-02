'use client'

/**
 * RecordsBlock — the per-exercise personal-records panel (GYM_PLAN §3a): best
 * weight, best e1RM, best set volume, a rep-max table, plus optional best
 * duration/distance for timed/cardio movements. Null-safe by construction: any
 * absent record renders an em-dash tile, and `excludedFromE1rm` swaps the e1RM
 * tile for a one-line note ("e1RM not computed for assisted movements").
 *
 * Split out from ExerciseDetailSheet so its null-handling is unit-testable
 * without mounting the whole sheet.
 */
import type { ExerciseRecords } from '@/lib/gym-client/types'
import { formatPace, paceBasisForDistanceUnit, type DistanceUnit } from '@/lib/units/system'
import { mmss, meters, num, shortStamp } from './format'

export function RecordsBlock({
  records,
  distanceUnit = 'm',
  perSide = false,
}: {
  records: ExerciseRecords
  distanceUnit?: DistanceUnit
  perSide?: boolean
}) {
  const { bestWeight, bestE1rm, bestSetVolume, repMaxes, excludedFromE1rm, bestDuration, bestDistance } = records
  const loadUnit = (unit: string) => `${unit}${perSide ? '/side' : ''}`

  const hasAny =
    bestWeight ||
    (bestE1rm && !excludedFromE1rm) ||
    bestSetVolume ||
    (repMaxes && repMaxes.length > 0) ||
    bestDuration ||
    bestDistance

  return (
    <div>
      <div style={grid}>
        <Tile
          label="Best weight"
          value={bestWeight ? `${num(bestWeight.value)} ${loadUnit(bestWeight.unit)}` : null}
          sub={bestWeight ? `× ${bestWeight.reps} · ${shortStamp(bestWeight.date)}` : undefined}
        />
        {excludedFromE1rm ? (
          <Tile label="Best e1RM" value="—" sub="not computed for assisted" muted />
        ) : (
          <Tile
            label="Best e1RM"
            value={bestE1rm ? `${num(bestE1rm.value)} ${loadUnit(bestE1rm.unit)}` : null}
            sub={bestE1rm ? `${num(bestE1rm.weight)} ${loadUnit(bestE1rm.unit)} × ${bestE1rm.reps} · ${shortStamp(bestE1rm.date)}` : undefined}
          />
        )}
        <Tile
          label="Best set volume"
          value={bestSetVolume ? `${num(bestSetVolume.value)} ${bestSetVolume.unit}` : null}
          sub={bestSetVolume ? `${num(bestSetVolume.weight)} ${loadUnit(bestSetVolume.unit)} × ${bestSetVolume.reps} · ${shortStamp(bestSetVolume.date)}` : undefined}
        />
        {bestDuration != null && (
          <Tile label="Best duration" value={mmss(bestDuration.value)} sub={shortStamp(bestDuration.date)} />
        )}
        {bestDistance != null && (
          <Tile
            label="Best distance"
            value={meters(bestDistance.value, distanceUnit)}
            sub={`${bestDistance.paceSecPerM != null ? `${formatPace(bestDistance.paceSecPerM * bestDistance.value, bestDistance.value, paceBasisForDistanceUnit(distanceUnit))} · ` : ''}${shortStamp(bestDistance.date)}`}
          />
        )}
      </div>

      {excludedFromE1rm && (
        <p style={note}>e1RM not computed for assisted movements.</p>
      )}

      {repMaxes && repMaxes.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={repHead}>Rep maxes</div>
          <div style={repTable}>
            {repMaxes.map((rm) => (
              <div key={rm.reps} style={repRow}>
                <span style={repReps}>{rm.reps}RM</span>
                <span style={repWeight}>
                  {num(rm.weight)} {loadUnit(rm.unit)}
                </span>
                <span style={repDate}>{shortStamp(rm.date)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!hasAny && <p style={note}>No records yet — log a set to set your first.</p>}
    </div>
  )
}

function Tile({
  label,
  value,
  sub,
  muted,
}: {
  label: string
  value: string | null
  sub?: string
  muted?: boolean
}) {
  const empty = value == null
  return (
    <div style={tile}>
      <div style={tileLabel}>{label}</div>
      <div style={{ ...tileValue, color: empty || muted ? 'var(--fg-subtle)' : 'var(--fg)' }}>
        {value ?? '—'}
      </div>
      {sub && <div style={tileSub}>{sub}</div>}
    </div>
  )
}

// ── styles ─────────────────────────────────────────────────────────────────
const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: 8,
}
const tile: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  padding: '10px 12px',
  minWidth: 0,
}
const tileLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const tileValue: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  marginTop: 3,
  letterSpacing: '-0.01em',
}
const tileSub: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  color: 'var(--fg-subtle)',
  marginTop: 3,
}
const note: React.CSSProperties = {
  margin: '10px 0 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 12,
  color: 'var(--fg-subtle)',
}
const repHead: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  marginBottom: 7,
}
const repTable: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const repRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '48px 1fr auto',
  alignItems: 'baseline',
  gap: 8,
  padding: '4px 0',
  borderBottom: '1px solid var(--border-muted)',
}
const repReps: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)' }
const repWeight: React.CSSProperties = { fontSize: 13, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }
const repDate: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-subtle)' }
