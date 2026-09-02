'use client'

/**
 * StartNoticesBanner (#1790) — what the START path changed or flagged, said out
 * loud in the Train tab.
 *
 * Two things reach here, and they are deliberately different in kind:
 *
 *  - EASED weights. The return-to-training ramp lowered today's targets after
 *    time away. This is offered as a default, not imposed: "Use template
 *    weights" puts them straight back. The safe direction is what happens
 *    without a tap, which is the right asymmetry for something injury-adjacent
 *    — but a weight that changed under the user without a word is exactly the silent
 *    change this whole feature exists to remove, so it is never not shown.
 *  - INJURY conflicts. Informational only. The exercise is flagged, NOT removed:
 *    silently dropping something is its own surprise, and a physio-cleared
 *    movement carries injury_override precisely so it survives. The user decides.
 *
 * Deliberately not a modal. Blocking the gap between "start" and "training" is
 * where a gym tool stops getting used.
 */
import { useState } from 'react'

import type { StartNotices } from '@/lib/gym/active-workout'

export function StartNoticesBanner({
  notices,
  onRestored,
}: {
  notices: StartNotices | null | undefined
  onRestored?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!notices) return null
  const eased = notices.eased ?? []
  const injuries = notices.injuries ?? []
  if (eased.length === 0 && injuries.length === 0) return null

  async function restore() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/gym/workouts/active/restore-weights', { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? 'Could not restore the template weights.')
        return
      }
      onRestored?.()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="start-notices" style={wrap}>
      {eased.length > 0 && (
        <div style={row}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={title}>Eased for today</div>
            <div style={body}>
              {eased
                .map((e) => `${e.exercise} ${e.from ?? '—'}→${e.to}${e.unit}`)
                .join(' · ')}
            </div>
            {eased[0]?.reason ? <div style={sub}>{eased[0].reason}</div> : null}
            <div style={sub}>Your template is unchanged.</div>
          </div>
          <button
            type="button"
            onClick={() => void restore()}
            disabled={busy}
            style={action}
          >
            {busy ? 'Restoring…' : 'Use template weights'}
          </button>
        </div>
      )}

      {injuries.length > 0 && (
        <div style={{ ...row, ...(eased.length > 0 ? divider : null) }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={title}>Injury conflict</div>
            <div style={body}>{injuries.map((i) => i.exercise).join(' · ')}</div>
            <div style={sub}>{injuries[0]?.reason}</div>
          </div>
        </div>
      )}

      {error ? <div style={{ ...sub, color: 'var(--danger, #c0392b)' }}>{error}</div> : null}
    </div>
  )
}

const wrap: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 12,
  background: 'var(--surface-2, var(--surface))',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}
const row: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'flex-start' }
const divider: React.CSSProperties = { borderTop: '1px solid var(--border)', paddingTop: 10 }
const title: React.CSSProperties = { fontSize: 13, fontWeight: 600 }
const body: React.CSSProperties = { fontSize: 13, marginTop: 2 }
const sub: React.CSSProperties = { fontSize: 12, opacity: 0.75, marginTop: 2 }
const action: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 12,
  fontWeight: 600,
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  cursor: 'pointer',
}
