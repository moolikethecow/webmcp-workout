'use client'

/**
 * MiniMuscleMap — a compact, read-only wrapper around the house MuscleFigure
 * (imported, NEVER copied) that lights a set of {region, weight} at small size.
 * Primary movers (weight 1) paint in full accent; secondaries (weight 0.5) paint
 * dimmed. Used as the list thumbnail fallback, the ExerciseImage fallback, and
 * the detail-sheet muscle diagram / muscle-SVG hero.
 *
 * Front + back are BOTH shown when the exercise credits back-only regions, so a
 * lat-pulldown mini map isn't blank up front. A tiny front/back toggle appears
 * only in the labeled (detail-hero) mode; the compact thumbnail picks the single
 * side with the most credit and never renders controls.
 */
import { useMemo, useState } from 'react'

import type { MuscleRegion } from '@/lib/fitness/muscles'
import { REGION_LABELS } from '@/lib/fitness/muscles'
import { MuscleFigure, type RegionPaint } from '@/components/health/MuscleFigure'
import type { ExerciseRegionHit } from '@/lib/gym-client/types'

/** Regions that only live on the BACK of the figure (front view shows nothing). */
const BACK_ONLY = new Set<MuscleRegion>(['lats', 'mid_back', 'lower_back', 'triceps', 'glutes', 'hamstrings'])

/** Weight → paint: primary = full accent, secondary = dimmed accent. Use a
 *  non-pulsing state ('fresh') so the mini map is static — the breathing pulse
 *  belongs to the /health recovery map, not an exercise diagram. */
function paintFor(weight: number): RegionPaint {
  const strong = weight >= 1
  return {
    // secondaries read as ~50% credit via a pre-mixed, dimmer accent
    color: strong ? 'var(--accent)' : 'color-mix(in oklch, var(--accent) 45%, var(--bg-elevated))',
    state: 'fresh',
  }
}

export function MiniMuscleMap({
  regions,
  size = 120,
  showLabels = false,
  /** Compact thumbnail mode: single best side, no controls, no aura scaling. */
  compact = false,
}: {
  regions: ExerciseRegionHit[]
  size?: number
  showLabels?: boolean
  compact?: boolean
}) {
  const paint = useMemo(() => {
    const out: Partial<Record<MuscleRegion, RegionPaint>> = {}
    for (const r of regions) out[r.region] = paintFor(r.weight)
    return out
  }, [regions])

  // Which side carries the most credit — used to default the toggle / pick the
  // single compact side.
  const backCredit = regions.filter((r) => BACK_ONLY.has(r.region)).reduce((a, r) => a + r.weight, 0)
  const frontCredit = regions.filter((r) => !BACK_ONLY.has(r.region)).reduce((a, r) => a + r.weight, 0)
  const bestSide: 'front' | 'back' = backCredit > frontCredit ? 'back' : 'front'
  const hasBoth = frontCredit > 0 && backCredit > 0

  const [view, setView] = useState<'front' | 'back'>(bestSide)

  // MuscleFigure is interactive by contract; the mini map is display-only, so
  // selection is a no-op and nothing is ever "selected".
  const noop = () => {}

  const primaryLabels = regions
    .filter((r) => r.weight >= 1)
    .map((r) => r.label || REGION_LABELS[r.region])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: showLabels ? 8 : 0 }}>
      {!compact && hasBoth && (
        <div
          role="tablist"
          aria-label="Muscle map side"
          style={{ display: 'inline-flex', border: '1px solid var(--border-muted)', borderRadius: 6, overflow: 'hidden', marginBottom: 6 }}
        >
          {(['front', 'back'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              style={{
                padding: '3px 10px',
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                background: view === v ? 'var(--accent)' : 'transparent',
                color: view === v ? 'var(--accent-fg)' : 'var(--fg-subtle)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {v}
            </button>
          ))}
        </div>
      )}
      <div
        style={{ width: size, maxWidth: '100%', pointerEvents: 'none' }}
        aria-hidden={compact ? true : undefined}
      >
        <MuscleFigure
          view={compact ? bestSide : view}
          paint={paint}
          selected={null}
          onSelect={noop}
        />
      </div>
      {showLabels && primaryLabels.length > 0 && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.06em',
            color: 'var(--fg-subtle)',
            textAlign: 'center',
          }}
        >
          {primaryLabels.join(' · ')}
        </div>
      )}
    </div>
  )
}
