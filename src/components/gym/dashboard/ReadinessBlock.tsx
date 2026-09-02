'use client'

/**
 * ReadinessBlock — the dashboard's muscle readiness figure.
 *
 * Same artwork and the same state colours as the Body tab's MuscleMap, fed by
 * GET /api/gym/agent/readiness (the payload the agent reads), so the person and
 * the agent are looking at one number. Readiness is a training-volume statement
 * — days since the region was worked plus recent working sets — and the caption
 * says so rather than implying a recovery score.
 */
import { useMemo, useState } from 'react'

import { MuscleFigure, type RegionPaint } from '@/components/health/MuscleFigure'
import { STATE_COLOR } from '@/components/health/MuscleMap'
import type { MuscleRegion } from '@/lib/fitness/muscles'
import type { MuscleTrainingState } from '@/lib/fitness/muscle-state'

export interface RegionReadinessRow {
  region: MuscleRegion
  label: string
  status: MuscleTrainingState
  lastTrainedDaysAgo: number | null
  recentWorkingSets: number
  note: string
}

const FRESHEST_SHOWN = 4

export function ReadinessBlock({ regions }: { regions: RegionReadinessRow[] }) {
  const [view, setView] = useState<'front' | 'back'>('front')
  const [selected, setSelected] = useState<MuscleRegion | null>(null)

  const paint = useMemo(() => {
    const out: Partial<Record<MuscleRegion, RegionPaint>> = {}
    for (const row of regions) {
      out[row.region] = { color: STATE_COLOR[row.status], state: row.status }
    }
    return out
  }, [regions])

  if (regions.length === 0) {
    return <p style={note}>Readiness needs some logged sets first.</p>
  }

  const active = selected ? regions.find((row) => row.region === selected) ?? null : null
  // The payload is already sorted freshest-first.
  const freshest = regions.slice(0, FRESHEST_SHOWN)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        {(['front', 'back'] as const).map((side) => (
          <button
            key={side}
            type="button"
            onClick={() => setView(side)}
            aria-pressed={view === side}
            style={{
              ...toggleBtn,
              color: view === side ? 'var(--fg)' : 'var(--fg-subtle)',
              borderColor: view === side ? 'var(--accent)' : 'var(--border-muted)',
            }}
          >
            {side}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 300, width: '100%', margin: '0 auto' }}>
        <MuscleFigure
          view={view}
          paint={paint}
          selected={selected}
          onSelect={(region) => setSelected((cur) => (cur === region ? null : region))}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {(active ? [active] : freshest).map((row) => (
          <div key={row.region} style={statRow}>
            <span style={{ ...swatch, background: STATE_COLOR[row.status] }} aria-hidden />
            <span style={{ fontSize: 12.5, color: 'var(--fg)', flex: 1, minWidth: 0 }}>{row.label}</span>
            <span style={statMeta}>
              {row.lastTrainedDaysAgo == null ? 'never' : `${row.lastTrainedDaysAgo}d`} ·{' '}
              {Math.round(row.recentWorkingSets)} sets/wk
            </span>
          </div>
        ))}
      </div>

      <p style={note}>
        {active ? active.note : 'Freshest regions first. Derived from logged sets, not a recovery score.'}
      </p>
    </div>
  )
}

const toggleBtn: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  background: 'transparent',
  border: '1px solid var(--border-muted)',
  borderRadius: 7,
  padding: '4px 9px',
  cursor: 'pointer',
}
const statRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '7px 0',
  borderTop: '1px solid var(--border-muted)',
}
const statMeta: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
}
const swatch: React.CSSProperties = { width: 6, height: 6, borderRadius: '50%', flexShrink: 0 }
const note: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  color: 'var(--fg-subtle)',
  margin: 0,
}
