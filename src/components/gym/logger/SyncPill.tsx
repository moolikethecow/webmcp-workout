'use client'

/**
 * SyncPill (GYM_PLAN §2.4, §4) — the header sync chip. Reads syncState +
 * pendingCount off the store. NEVER blocks anything; it only reflects the write
 * queue's state:
 *   - saved   → green dot "Saved"
 *   - pending → amber "N pending"
 *   - offline → red "Offline — saved locally"
 *
 * A3 places this in its workout header; it self-sources from the store.
 */

import { useActiveWorkoutStore } from '@/lib/gym-client/active-workout-store'

export function SyncPill() {
  const { syncState, pendingCount } = useActiveWorkoutStore()

  const cfg =
    syncState === 'conflict'
      ? { color: 'var(--warning)', label: 'Merging changes…', pulse: true }
      : syncState === 'offline'
      ? { color: 'var(--danger)', label: 'Offline — saved locally', pulse: true }
      : syncState === 'pending'
        ? { color: 'var(--warning)', label: `${pendingCount} pending`, pulse: true }
        : { color: 'var(--success, var(--accent))', label: 'Saved', pulse: false }

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Sync: ${cfg.label}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 9px',
        borderRadius: 999,
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        letterSpacing: '0.03em',
        color: 'var(--fg-muted)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-muted)',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: cfg.color,
          boxShadow: cfg.pulse ? `0 0 0 0 ${cfg.color}` : 'none',
          animation: cfg.pulse ? 'gym-pill-pulse 1.6s ease-out infinite' : 'none',
          flexShrink: 0,
        }}
      />
      {cfg.label}
      <style>{PILL_CSS}</style>
    </span>
  )
}

const PILL_CSS = `
@keyframes gym-pill-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in oklch, currentColor 60%, transparent); }
  70% { box-shadow: 0 0 0 5px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@media (prefers-reduced-motion: reduce) { span[aria-hidden] { animation: none !important; } }
`
