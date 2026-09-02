'use client'

/**
 * Anatomical human muscle figure (front + back) for the /health muscle map.
 * Body artwork vendored from react-native-body-highlighter (MIT, Hicham
 * ELABBASSI) — see body-paths.ts + body-art.LICENSE.txt. This component is the
 * presentation layer only: it paints each canonical muscle region
 * (lib/fitness/muscles) by its training-state color on a dark duotone body.
 *
 * Interaction is split (#1040): a tap/Enter/Space fires `onSelect` (the parent
 * treats this as a hold-toggle — it LOCKS the info panel), while hover and focus
 * fire `onHoverRegion` (preview only — never locks). `selected` is the held
 * region: it keeps a persistent ring and stays lifted even while another muscle
 * is hovered.
 *
 * Motion (all disabled under prefers-reduced-motion):
 *   - front↔back flips with a fast crossfade + subtle 3D y-rotation
 *   - hovered/held muscles lift with a soft glow in their state color
 *     while sibling muscles dim (the held muscle never dims)
 *   - the held muscle also carries a persistent accent ring
 *   - "recovering" muscles breathe (slow 2.7s opacity pulse)
 *   - state-color changes ease over ~450ms instead of snapping
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

import type { MuscleRegion } from '@/lib/fitness/muscles'
import { REGION_LABELS } from '@/lib/fitness/muscles'
import type { MuscleTrainingState } from '@/lib/fitness/muscle-state'
import { BODY_BACK, BODY_FRONT } from './body-paths'

export interface RegionPaint {
  /** Raw state color token (e.g. `var(--danger)`) — drives fill mix + glow. */
  color: string
  /** Training state — drives the breathing pulse / desaturated looks. */
  state: MuscleTrainingState
}

interface Props {
  view: 'front' | 'back'
  /** region id → paint. Missing regions render as untrained body tone. */
  paint: Partial<Record<MuscleRegion, RegionPaint>>
  /** The HELD region (locked by an explicit tap/Enter). Persistent ring + lift. */
  selected: MuscleRegion | null
  /** Tap / Enter / Space — the parent treats this as a hold-toggle (lock). */
  onSelect: (region: MuscleRegion) => void
  /** Hover / focus preview — fires the hovered region (or null on leave/blur).
   *  Never locks; the parent feeds it into the panel only when nothing is held. */
  onHoverRegion?: (region: MuscleRegion | null) => void
  /** Mobility lens (GYM_PLAN §10b.9): also promote the joint regions
   *  (neck/knees/wrists/ankles) from inert anatomy to tappable, painted regions.
   *  Off on the strength lens — those joints stay inert there. */
  mobilityRegions?: boolean
}

/** Muscle fill for a state — duotone mixes into the dark body rather than flat
 *  token slabs. Exported so the legend (MuscleMap) can show the same swatch. */
export function muscleFill(paint: RegionPaint | undefined, emphasized: boolean): string {
  if (!paint || paint.state === 'untrained') {
    return 'color-mix(in oklch, var(--accent) 13%, var(--bg-elevated))'
  }
  if (paint.state === 'undertrained') {
    // faint + desaturated — reads as "needs attention", not celebration
    return `color-mix(in oklch, var(--fg-subtle) ${emphasized ? 52 : 36}%, var(--bg-elevated))`
  }
  return `color-mix(in oklch, ${paint.color} ${emphasized ? 94 : 72}%, var(--bg-elevated))`
}

/** Glow color for the hover/selection ring — state color, accent when neutral. */
function glowColor(paint: RegionPaint | undefined): string {
  if (!paint || paint.state === 'untrained' || paint.state === 'undertrained') {
    return 'color-mix(in oklch, var(--accent) 70%, transparent)'
  }
  return `color-mix(in oklch, ${paint.color} 75%, transparent)`
}

const BODY_TONE = 'color-mix(in oklch, var(--accent) 8%, var(--bg-elevated))'
const OUTLINE_TONE = 'color-mix(in oklch, var(--accent) 36%, var(--border))'
const EASE_LIFT = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** Live prefers-reduced-motion flag. Own hook (not motion's useReducedMotion)
 *  so the value tracks the media query deterministically — motion's version is
 *  a module singleton that caches its first read. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

export function MuscleFigure({ view, paint, selected, onSelect, onHoverRegion, mobilityRegions = false }: Props) {
  const reduced = usePrefersReducedMotion()
  const [hovered, setHovered] = useState<MuscleRegion | null>(null)
  // The held region always lifts; a live hover/focus preview takes visual priority.
  const active = hovered ?? selected

  // Hover/focus updates the local glow AND bubbles a preview to the parent (which
  // only shows it when nothing is held). Explicit activation stays with onSelect.
  const handleHover = (region: MuscleRegion | null) => {
    setHovered(region)
    onHoverRegion?.(region)
  }

  const body = view === 'front' ? BODY_FRONT : BODY_BACK
  const [vbX, , vbW] = body.viewBox.split(' ').map(Number)
  const cx = vbX + vbW / 2

  return (
    <div style={{ perspective: 900 }}>
      {/* Breathing pulse for "recovering" muscles — CSS animation (reliable on
          SVG groups, unlike mount-time motion keyframes). Not applied when
          prefers-reduced-motion. */}
      <style>{'@keyframes mm-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.66; } }'}</style>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view}
          initial={reduced ? false : { opacity: 0, rotateY: view === 'front' ? -16 : 16, scale: 0.985 }}
          animate={{
            opacity: 1,
            rotateY: 0,
            scale: 1,
            transition: reduced ? { duration: 0 } : { duration: 0.16, ease: [0.2, 0.8, 0.2, 1] },
          }}
          exit={
            reduced
              ? { opacity: 0, transition: { duration: 0 } }
              : {
                  opacity: 0,
                  rotateY: view === 'front' ? 16 : -16,
                  scale: 0.985,
                  transition: { duration: 0.13, ease: 'easeIn' },
                }
          }
          style={{ transformStyle: 'preserve-3d' }}
        >
          <svg
            viewBox={body.viewBox}
            style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
            role="img"
            aria-label={`${view} muscle map`}
          >
            <defs>
              <radialGradient id={`mm-aura-${view}`} cx="50%" cy="42%" r="58%">
                <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.13 }} />
                <stop offset="70%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.04 }} />
                <stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
              </radialGradient>
              <radialGradient id={`mm-ground-${view}`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.22 }} />
                <stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
              </radialGradient>
            </defs>

            {/* Decorative + inert layers never swallow taps meant for muscles. */}
            <g aria-hidden="true" style={{ pointerEvents: 'none' }}>
              {/* Ambient stage: soft accent aura behind the body + a ground pool. */}
              <ellipse cx={cx} cy={620} rx={330} ry={430} fill={`url(#mm-aura-${view})`} />
              <ellipse cx={cx} cy={1350} rx={210} ry={20} fill={`url(#mm-ground-${view})`} />

              {/* Silhouette contour — thin line art around the whole body. */}
              <path
                d={body.outline}
                fill="none"
                stroke={OUTLINE_TONE}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.85}
              />

              {/* Inert anatomy (head, neck, hands, knees, feet…). */}
              {body.body.map((d, i) => (
                <path key={i} d={d} fill={BODY_TONE} stroke="var(--bg)" strokeWidth={1.5} opacity={0.95} />
              ))}
            </g>

            {/* Tappable muscle regions, plus the joint regions on the mobility
                lens (drawn over their inert copies in `body.body`). */}
            {[...body.regions, ...(mobilityRegions ? body.mobilityRegions : [])].map((shape) => (
              <Region
                key={shape.region}
                region={shape.region}
                paths={shape.paths}
                paint={paint[shape.region]}
                isActive={active === shape.region}
                isHeld={selected === shape.region}
                // The held muscle never dims, even while another is hovered.
                isDimmed={active != null && active !== shape.region && selected !== shape.region}
                reduced={reduced}
                onSelect={onSelect}
                onHover={handleHover}
              />
            ))}
          </svg>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

interface RegionProps {
  region: MuscleRegion
  paths: readonly string[]
  paint: RegionPaint | undefined
  isActive: boolean
  /** This region is the HELD (locked) one — persistent ring + lift. */
  isHeld: boolean
  isDimmed: boolean
  reduced: boolean
  /** Explicit activation (tap / Enter / Space) — hold-toggle at the parent. */
  onSelect: (region: MuscleRegion) => void
  /** Hover/focus preview (or null on leave/blur) — never locks. */
  onHover: (region: MuscleRegion | null) => void
}

function Region({ region, paths, paint, isActive, isHeld, isDimmed, reduced, onSelect, onHover }: RegionProps) {
  const fill = muscleFill(paint, isActive || isHeld)
  const glow = glowColor(paint)
  const breathing = !reduced && paint?.state === 'recovering'

  return (
    <motion.g
      role="button"
      tabIndex={0}
      aria-label={REGION_LABELS[region]}
      // Pressed tracks the HELD (locked) state — not incidental hover/focus.
      aria-pressed={isHeld}
      data-region={region}
      data-held={isHeld ? 'true' : undefined}
      onClick={() => onSelect(region)}
      // Hover + focus PREVIEW only (bubble up + drive the local glow); they no
      // longer call onSelect, so an incidental hover can't steal a held panel.
      onMouseEnter={() => onHover(region)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(region)}
      onBlur={() => onHover(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(region)
        }
      }}
      animate={{ opacity: isDimmed ? 0.42 : 1 }}
      transition={{ duration: reduced ? 0 : 0.22, ease: 'easeOut' }}
      style={{
        cursor: 'pointer',
        outline: 'none',
        // lift from the muscle's own center, not the SVG origin
        transformBox: 'fill-box',
        transformOrigin: 'center',
        transform: (isActive || isHeld) && !reduced ? 'scale(1.03)' : 'scale(1)',
        // transparent shadow when idle so the glow INTERPOLATES instead of popping
        filter:
          isActive || isHeld
            ? `drop-shadow(0 0 14px ${glow}) drop-shadow(0 0 3px ${glow})`
            : 'drop-shadow(0 0 14px transparent) drop-shadow(0 0 3px transparent)',
        transition: reduced ? undefined : `transform 200ms ${EASE_LIFT}, filter 240ms ease`,
      }}
    >
      <g style={breathing ? { animation: 'mm-breathe 2.7s ease-in-out infinite' } : undefined}>
        {paths.map((d, i) => (
          <path
            key={i}
            d={d}
            fill={fill}
            stroke="var(--bg)"
            strokeWidth={2.2}
            strokeLinejoin="round"
            style={reduced ? undefined : { transition: 'fill 450ms ease' }}
          />
        ))}
      </g>
      {/* Persistent "held" ring — a crisp accent outline that stays put after
          mouse-out, so the locked muscle reads as pinned even while another is
          hovered. Distinct from the soft hover glow; static, so nothing to
          disable under reduced motion. Non-interactive so it never eats taps. */}
      {isHeld && (
        <g aria-hidden="true" style={{ pointerEvents: 'none' }}>
          {paths.map((d, i) => (
            <path
              key={`held-ring-${i}`}
              d={d}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={2.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={0.95}
            />
          ))}
        </g>
      )}
    </motion.g>
  )
}
