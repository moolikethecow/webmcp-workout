'use client'

/**
 * Page-level primitives for the /health redesign, ported from the design
 * prototype (`health/rail.jsx`): Card shell, mono label, numbered section
 * head, page head, breadcrumb — plus the responsive style overlay (the app is
 * inline-styled; media-query behavior rides on `.hlth-*` classes, mirroring
 * the global mobile-overlay pattern in globals.css).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'

// ── card shell ──────────────────────────────────────────────────────────────
export function HCard({
  children,
  style,
  pad = 16,
  onClick,
  hover,
  className,
  ariaLabel,
}: {
  children: ReactNode
  style?: CSSProperties
  pad?: number | string
  onClick?: () => void
  hover?: boolean
  className?: string
  ariaLabel?: string
}) {
  const [h, setH] = useState(false)
  const clickable = Boolean(onClick)
  return (
    <div
      className={className}
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? ariaLabel : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
      style={{
        background: 'var(--bg-elevated)',
        border: `1px solid ${h && (hover || clickable) ? 'var(--border)' : 'var(--border-muted)'}`,
        borderRadius: 'var(--radius)',
        padding: pad,
        cursor: clickable ? 'pointer' : 'default',
        transition: 'border-color .14s, transform .14s, box-shadow .14s',
        transform: h && clickable ? 'translateY(-2px)' : 'none',
        boxShadow: h && clickable ? '0 8px 24px rgba(0,0,0,.22)' : 'none',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

// ── labels + headers ────────────────────────────────────────────────────────
export function MonoLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        fontWeight: 500,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--fg-subtle)',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** Numbered section header: accent number + uppercase label + hairline + right hint. */
export function SecHead({ children, right, num }: { children: ReactNode; right?: ReactNode; num?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 14px' }}>
      {num && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600, color: 'var(--accent)' }}>
          {num}
        </span>
      )}
      <MonoLabel style={{ fontSize: 10.5, letterSpacing: '0.14em' }}>{children}</MonoLabel>
      <div style={{ flex: 1, height: 1, background: 'var(--border-muted)' }} />
      {right}
    </div>
  )
}

/** Small mono hint for a SecHead's right slot. */
export function SecHint({ children }: { children: ReactNode }) {
  return (
    <span className="hlth-sechint" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-subtle)' }}>
      {children}
    </span>
  )
}

export function PageHead({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
      <div>
        <h1
          style={{
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontWeight: 400,
            // 28 = the app-wide page-header standard (#812); this was the
            // lone 30px outlier.
            fontSize: 28,
            letterSpacing: '-0.01em',
            margin: 0,
            color: 'var(--fg)',
          }}
        >
          {title}
        </h1>
        {sub && (
          <p
            style={{
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              fontWeight: 300,
              fontSize: 15,
              lineHeight: 1.5,
              color: 'var(--fg-muted)',
              margin: '8px 0 0',
              maxWidth: '54ch',
            }}
          >
            {sub}
          </p>
        )}
      </div>
      {right}
    </div>
  )
}

/** '‹ {parentLabel} / {title}' back bar for drill-ins. */
export function Breadcrumb({
  title,
  onBack,
  parentLabel = 'Health',
}: {
  title: string
  onBack: () => void
  parentLabel?: string
}) {
  return (
    <button
      onClick={onBack}
      aria-label={`Back to ${parentLabel}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--fg-subtle)',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        alignSelf: 'flex-start',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 7,
          border: '1px solid var(--border-muted)',
          background: 'var(--bg-elevated)',
        }}
      >
        <ChevronLeft size={13} color="var(--fg-muted)" />
      </span>
      <span style={{ color: 'var(--fg-muted)' }}>{parentLabel}</span>
      <span style={{ opacity: 0.4 }}>/</span>
      <span style={{ color: 'var(--fg)' }}>{title}</span>
    </button>
  )
}

// ── responsive hooks ────────────────────────────────────────────────────────

/** True below the app's 700px mobile breakpoint (false during SSR). */
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 700px)')
    const update = () => setNarrow(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return narrow
}

// ── responsive style overlay ────────────────────────────────────────────────
// Classes need !important below 700px to beat the inline styles (established
// app pattern — see the mobile overlay section of globals.css).
const HLTH_CSS = `
.hlth-sections { display: flex; flex-direction: column; gap: 30px; }
.hlth-grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.hlth-grid2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.hlth-split { display: grid; grid-template-columns: 1.15fr 1fr; gap: 12px; }
.hlth-detail { display: grid; grid-template-columns: 1.35fr 1fr; gap: 26px; align-items: start; }
.hlth-manage { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.hlth-stages4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.hlth-hero { display: flex; gap: 26px; align-items: center; }
.hlth-hero-main { flex: 1; min-width: 0; }
.hlth-hero-side { width: 132px; flex-shrink: 0; align-self: stretch; display: flex; flex-direction: column; justify-content: flex-end; gap: 6px; }
.hlth-hero-msent { display: none; }
.hlth-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.hlth-syschev { display: none; }
.hlth-trendinline { display: none; }

@media (max-width: 700px) {
  .hlth-sections { gap: 20px; }
  .hlth-grid3, .hlth-grid2, .hlth-split, .hlth-detail, .hlth-stages4 { grid-template-columns: 1fr !important; }
  .hlth-stages4 { grid-template-columns: 1fr 1fr !important; }
  .hlth-detail { gap: 18px; }
  /* hero: centered ring + short sentence (mobile.jsx) */
  .hlth-hero { flex-direction: column; align-items: center; gap: 12px !important; padding: 16px 16px 18px !important; }
  .hlth-hero-main, .hlth-hero-side { display: none !important; }
  .hlth-hero-msent { display: block; }
  /* system cards: chevron affordance + inline trend next to the value */
  .hlth-syschev { display: inline-flex; }
  .hlth-syscard { min-height: 0 !important; }
  .hlth-syspill { margin-left: 0 !important; }
  .hlth-trendinline { display: inline-flex; }
  .hlth-trendrow { display: none !important; }
  /* compact type (mobile.jsx sizes) */
  .hlth-sysnum { font-size: 26px !important; }
  .hlth-scrubnum { font-size: 21px !important; }
  .hlth-expnum { font-size: 32px !important; }
  .hlth-scrubbadge { display: none; }
  .hlth-expblurb { display: none !important; }
  /* explorer chips scroll horizontally instead of wrapping */
  .hlth-chips { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; -webkit-overflow-scrolling: touch; }
  .hlth-chips > button { flex-shrink: 0; }
}
`

/** Mount once at the page root. */
export function HealthStyles() {
  return <style dangerouslySetInnerHTML={{ __html: HLTH_CSS }} />
}
