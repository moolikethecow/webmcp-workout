'use client'

/**
 * Scrubbable metric chart. Everything responds to the cursor: scrub the chart
 * and the readout follows. Dependency-free SVG, themed via the app's CSS vars.
 *
 * Touch: scrub charts set `touchAction: pan-y` and attach a NON-passive native
 * touchmove listener (React's root touch listeners are passive, so a synthetic
 * handler can't preventDefault) — horizontal drags scrub, vertical still
 * scrolls the page.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { ArrowUp } from 'lucide-react'

import { usePrefersReducedMotion } from './MuscleFigure'
import { nf, niceDate } from './format'

/** One point on a plotted series: an ISO day and its value. */
export interface SeriesPoint {
  date: string
  value: number
}

// ── the workhorse: scrubbable metric chart ──────────────────────────────────
export interface MetricChartProps {
  series: SeriesPoint[]
  type?: 'area' | 'line' | 'bar'
  height?: number
  color?: string
  baseline?: [number, number] | null
  goal?: number | null
  round?: number
  unit?: string
  chip?: boolean
  onHover?: (point: SeriesPoint, index: number, hovering: boolean) => void
  dateFmt?: (d: string) => string
  valueFmt?: ((v: number) => string) | null
}

export function MetricChart({
  series,
  type = 'area',
  height = 96,
  color = 'var(--accent)',
  baseline = null,
  goal = null,
  round = 0,
  unit = '',
  chip = true,
  onHover,
  dateFmt = niceDate,
  valueFmt,
}: MetricChartProps) {
  const n = series.length
  const band = type === 'bar'
  const ref = useRef<HTMLDivElement>(null)
  const [hi, setHi] = useState<number | null>(null)
  // useId emits `:r0:` — strip the colons so url(#…) fragment refs stay clean.
  const uid = useId().replace(/:/g, 'h')

  // Keep the latest scrub math in a ref so the native touch listener never
  // needs re-attaching.
  const scrubRef = useRef<(clientX: number) => void>(() => undefined)
  scrubRef.current = (clientX: number) => {
    const el = ref.current
    if (!el || n === 0) return
    const rect = el.getBoundingClientRect()
    if (!rect.width) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const idx = band ? Math.min(n - 1, Math.floor(ratio * n)) : Math.round(ratio * (n - 1))
    setHi(idx)
    onHover?.(series[idx]!, idx, true)
  }
  const reset = useCallback(() => {
    setHi(null)
    if (n > 0) onHover?.(series[n - 1]!, n - 1, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, series])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onTouch = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault()
      const t = e.touches[0]
      if (t) scrubRef.current(t.clientX)
    }
    el.addEventListener('touchstart', onTouch, { passive: false })
    el.addEventListener('touchmove', onTouch, { passive: false })
    return () => {
      el.removeEventListener('touchstart', onTouch)
      el.removeEventListener('touchmove', onTouch)
    }
  }, [])

  if (n === 0) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--fg-subtle)',
        }}
      >
        no data
      </div>
    )
  }

  const active = hi == null ? n - 1 : Math.min(hi, n - 1)
  const vals = series.map((p) => p.value)
  let lo = Math.min(...vals)
  let up = Math.max(...vals)
  if (baseline) {
    lo = Math.min(lo, baseline[0])
    up = Math.max(up, baseline[1])
  }
  if (goal != null) {
    lo = Math.min(lo, goal)
    up = Math.max(up, goal)
  }
  const pad = (up - lo) * 0.12 || 1
  lo -= pad
  up += pad
  const VW = 1000
  const VH = 100
  const x = (i: number) => (band ? ((i + 0.5) / n) * VW : n > 1 ? (i / (n - 1)) * VW : VW / 2)
  const y = (v: number) => VH - ((v - lo) / (up - lo)) * VH

  const linePath = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(2)}`).join(' ')
  const areaPath = `${linePath} L${x(n - 1)},${VH} L${x(0)},${VH} Z`

  const ax = x(active)
  const axPct = (ax / VW) * 100
  const chipLeft = Math.max(8, Math.min(92, axPct))
  const ap = series[active]!
  const showVal = valueFmt ? valueFmt(ap.value) : `${nf(ap.value, round)}${unit ? ' ' + unit : ''}`

  return (
    <div
      ref={ref}
      style={{ position: 'relative', width: '100%', height, touchAction: 'pan-y', cursor: 'crosshair' }}
      onMouseMove={(e) => scrubRef.current(e.clientX)}
      onMouseLeave={reset}
      onTouchEnd={reset}
      onTouchCancel={reset}
    >
      {chip && hi != null && (
        <div
          style={{
            position: 'absolute',
            top: -2,
            left: `${chipLeft}%`,
            transform: 'translateX(-50%)',
            zIndex: 3,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '3px 8px',
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 14px rgba(0,0,0,.35)',
            pointerEvents: 'none',
          }}
        >
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.04em', color: 'var(--fg-subtle)' }}>
            {dateFmt(ap.date)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums', marginTop: 1 }}>
            {showVal}
          </div>
        </div>
      )}
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        style={{ display: 'block', overflow: 'visible' }}
        aria-hidden
      >
        <defs>
          <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {baseline && (
          <rect
            x="0"
            y={y(baseline[1])}
            width={VW}
            height={Math.max(0, y(baseline[0]) - y(baseline[1]))}
            fill="var(--fg)"
            opacity="0.05"
          />
        )}
        {goal != null && (
          <line
            x1="0"
            y1={y(goal)}
            x2={VW}
            y2={y(goal)}
            stroke="var(--fg-subtle)"
            strokeWidth="1"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
            opacity="0.6"
          />
        )}
        {type === 'bar' ? (
          series.map((p, i) => {
            const on = i === active
            const bw = (VW / n) * 0.6
            const hit = goal != null && p.value >= goal
            return (
              <rect
                key={i}
                x={x(i) - bw / 2}
                y={y(p.value)}
                width={bw}
                height={VH - y(p.value)}
                rx="1.5"
                fill={on ? color : hit ? color : 'var(--border)'}
                opacity={on ? 1 : hit ? 0.8 : 0.85}
                style={{ transition: 'opacity .12s' }}
              />
            )
          })
        ) : (
          <>
            {type === 'area' && <path d={areaPath} fill={`url(#${uid})`} />}
            <path
              d={linePath}
              fill="none"
              stroke={color}
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </>
        )}
        {hi != null && type !== 'bar' && (
          <line x1={ax} y1="0" x2={ax} y2={VH} stroke="var(--fg-muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity="0.4" />
        )}
        {type !== 'bar' && (
          <circle
            cx={ax}
            cy={y(ap.value)}
            r={hi != null ? 4 : 3}
            fill={color}
            stroke="var(--bg)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  )
}
