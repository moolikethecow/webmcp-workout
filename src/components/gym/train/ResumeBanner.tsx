'use client'

/**
 * ResumeBanner (GYM_PLAN §4 "Tab: Train / Resume banner"). When probe() finds an
 * active workout that's gone stale — started >30 min ago with no recently-logged
 * set — the app can't assume it's still live (the user may have closed the tab mid-
 * session, or abandoned it). The banner sits ABOVE the active-workout view and
 * offers two honest paths:
 *
 *   - Resume  → dismiss the banner, keep logging (the workout is already loaded).
 *   - Discard → ConfirmModal (the app-wide destructive gate) → store.discard().
 *
 * "No recent set" is judged by the most-recent completed set's timestamp; since
 * the read model doesn't carry per-set updated_at, we approximate staleness from
 * the workout's elapsed time vs a threshold and the absence of any completed set
 * — a >30-min-old workout with zero completed sets is the clearest stale case.
 * The parent decides whether to render this (passes `stale`); the banner is pure
 * presentation + the confirm flow.
 */
import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'

import { ConfirmModal } from '@/components/ui/ConfirmModal'

export function ResumeBanner({
  minutesAgo,
  onResume,
  onDiscard,
}: {
  /** How long ago the workout started (whole minutes), for the copy. */
  minutesAgo: number
  /** Dismiss the banner and keep the workout (no network). */
  onResume: () => void
  /** Discard the workout (store.discard). Rejects → the parent toasts. */
  onDiscard: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [discarding, setDiscarding] = useState(false)

  async function handleDiscard() {
    setDiscarding(true)
    try {
      await onDiscard()
      // On success the parent clears the workout → this whole subtree unmounts.
    } finally {
      setDiscarding(false)
      setConfirming(false)
    }
  }

  return (
    <>
      <div style={banner} role="status">
        <span style={icon}>
          <AlertTriangle size={15} strokeWidth={1.9} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={title}>You have an unfinished workout</div>
          <div style={sub}>
            Started {minutesAgo} min ago. Pick up where you left off, or discard it.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button type="button" onClick={() => setConfirming(true)} style={discardBtn}>
            Discard
          </button>
          <button type="button" onClick={onResume} style={resumeBtn}>
            Resume
          </button>
        </div>
      </div>

      {confirming && (
        <ConfirmModal
          title="Discard this workout?"
          description="This deletes the unfinished session and any sets you logged in it. This can't be undone."
          confirmLabel="Discard workout"
          loading={discarding}
          onConfirm={() => void handleDiscard()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────
const banner: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 14px',
  borderRadius: 12,
  background: 'color-mix(in oklch, var(--warning) 10%, var(--bg-elevated))',
  border: '1px solid color-mix(in oklch, var(--warning) 40%, var(--border-muted))',
  marginBottom: 14,
  flexWrap: 'wrap',
}
const icon: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--warning)',
  flexShrink: 0,
}
const title: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--fg)',
}
const sub: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-muted)',
  marginTop: 2,
}
const resumeBtn: React.CSSProperties = {
  padding: '7px 14px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
}
const discardBtn: React.CSSProperties = {
  padding: '7px 14px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  color: 'var(--fg-muted)',
  background: 'transparent',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  cursor: 'pointer',
}
