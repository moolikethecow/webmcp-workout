'use client'

/**
 * RemovalReasonChips (GYM_PLAN §4 / §6 dislike-learning) — the one-tap optional
 * reason chip row that appears when an exercise is removed or replaced in the
 * logger. Non-blocking: a fixed bottom toast that self-dismisses after ~6s (or on
 * tap), each chip firing a DISTINCT learning write. ONLY the explicit "Don't like
 * it" chip writes a hard dislike; the rest are soft/temporary.
 *
 * Routing (chip → call):
 *   Don't like it     → PATCH /api/gym/exercises/{id}   { disliked:true }      (hard, permanent)
 *   Bored of it       → PATCH /api/gym/exercises/{id}   { snoozeDays:14 }      (soft cooldown; pools skip it)
 *   Not available here → POST  /api/gym/gyms             { excludeExercise }    (per-default-gym exclusion)
 *   Tweaked           → POST  /api/gym/injuries         { tweak:{region,days:7} } (auto-expiring soft region flag)
 *   Preferred it      → PATCH /api/gym/exercises/{replacementId} { preferred:true } (#1876 — REPLACE only;
 *                        marks the exercise the user swapped IN, so future drafting/replacement ranking can bias
 *                        toward it. Only offered when there is a replacement to mark.)
 *   Skip              → (nothing)
 *
 * SELF-MOUNTING: the only public API is the imperative `showRemovalReason(info)`.
 * It lazily attaches its own React root to <body> (outside the app tree), so the
 * toast survives the removed card unmounting and the caller needs exactly one
 * render-free function call — no `<Component/>` to mount, no lifecycle coupling.
 * Writes are fire-and-forget optimistic; a failure only console-warns (§4: "every
 * write optimistic + toast on fail; skip does nothing").
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { musclesForExercise, type MuscleRegion } from '@/lib/fitness/muscles'

/** How long the chip row lingers before auto-dismissing (§4 "~6s or until tap"). */
const LINGER_MS = 6000
/** Default cooldown for "Bored of it" (days). */
const BORED_SNOOZE_DAYS = 14
/** Auto-expiry window for a "Tweaked" soft injury flag (days). */
const TWEAK_DAYS = 7

export interface RemovalReasonInfo {
  /** The exercise catalog id (for the PATCH). */
  exerciseId: string
  /** Display name — used for the toast label + the per-gym exclusion write. */
  exerciseName: string
  /** Whether the exercise was replaced (vs plain removed) — copy only. */
  replaced?: boolean
  /** The exercise the user swapped IN, when this toast follows a replace (#1876).
   *  Only present alongside `replaced: true` — a plain remove has no pick to
   *  mark preferred, so the "Preferred it" chip is withheld without it. */
  replacementExerciseId?: string
  replacementExerciseName?: string
}

type Reason = 'dislike' | 'bored' | 'unavailable' | 'tweaked' | 'preference' | 'skip'

interface Chip {
  reason: Reason
  label: string
}

const CHIPS: Chip[] = [
  { reason: 'dislike', label: "Don't like it" },
  { reason: 'bored', label: 'Bored of it' },
  { reason: 'unavailable', label: 'Not available here' },
  { reason: 'tweaked', label: 'Tweaked' },
  { reason: 'preference', label: 'Preferred it' },
  { reason: 'skip', label: 'Skip' },
]

/** The primary muscle region of an exercise (for the "Tweaked" injury), or null. */
function primaryRegionOf(name: string): MuscleRegion | null {
  const hits = musclesForExercise(name)
  const primary = hits.find((h) => h.weight === 1) ?? hits[0]
  return primary?.region ?? null
}

/** Fire the write for a chosen reason. Fire-and-forget; only warns on failure so a
 *  dead network never blocks the (already-committed) removal. Exported for tests. */
export async function fireRemovalReason(info: RemovalReasonInfo, reason: Reason): Promise<void> {
  try {
    if (reason === 'skip') return
    if (reason === 'dislike') {
      await fetch(`/api/gym/exercises/${info.exerciseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disliked: true }),
      })
      return
    }
    if (reason === 'bored') {
      await fetch(`/api/gym/exercises/${info.exerciseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snoozeDays: BORED_SNOOZE_DAYS }),
      })
      return
    }
    if (reason === 'unavailable') {
      await fetch('/api/gym/gyms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excludeExercise: info.exerciseName }),
      })
      return
    }
    if (reason === 'tweaked') {
      const region = primaryRegionOf(info.exerciseName)
      if (!region) return // no region resolvable → nothing to flag
      await fetch('/api/gym/injuries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tweak: { region, days: TWEAK_DAYS } }),
      })
      return
    }
    if (reason === 'preference') {
      // #1876: marks the exercise the user swapped IN, not the one that left — this
      // chip has nothing to write without a replacement to point at.
      if (!info.replacementExerciseId) return
      await fetch(`/api/gym/exercises/${info.replacementExerciseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferred: true }),
      })
      return
    }
  } catch (err) {
    console.warn('[RemovalReasonChips] write failed:', err instanceof Error ? err.message : err)
  }
}

/** The toast body (a fixed bottom chip row). Self-times-out; a tap fires + closes. */
function ReasonToast({ info, onClose }: { info: RemovalReasonInfo; onClose: () => void }) {
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const close = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setClosing(true)
    // Let the fade run, then unmount.
    setTimeout(onClose, 180)
  }, [onClose])

  const pick = useCallback(
    (reason: Reason) => {
      void fireRemovalReason(info, reason)
      close()
    },
    [info, close],
  )

  useEffect(() => {
    timerRef.current = setTimeout(close, LINGER_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [close])

  return (
    <div
      role="group"
      aria-label={`Why did you ${info.replaced ? 'replace' : 'remove'} ${info.exerciseName}?`}
      style={{ ...wrap, opacity: closing ? 0 : 1 }}
    >
      <div style={prompt}>
        {info.replaced ? 'Replaced' : 'Removed'} <span style={promptName}>{info.exerciseName}</span>
      </div>
      <div style={chipRow}>
        {CHIPS.filter((c) => c.reason !== 'preference' || info.replacementExerciseId).map((c) => (
          <button
            key={c.reason}
            type="button"
            onClick={() => pick(c.reason)}
            style={c.reason === 'skip' ? skipChip : c.reason === 'dislike' ? dislikeChip : chip}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Self-mounting imperative API
// ---------------------------------------------------------------------------

let host: HTMLDivElement | null = null
let root: Root | null = null

function ensureRoot(): Root | null {
  if (typeof document === 'undefined') return null
  if (!host) {
    host = document.createElement('div')
    host.setAttribute('data-removal-reason-host', '')
    document.body.appendChild(host)
  }
  if (!root) root = createRoot(host)
  return root
}

/**
 * Show the reason-chip toast for a just-removed/replaced exercise. Imperative +
 * self-mounting — call it from the logger's remove/replace flow; nothing else to
 * wire. A second call replaces the currently-shown toast.
 */
export function showRemovalReason(info: RemovalReasonInfo): void {
  const r = ensureRoot()
  if (!r) return
  const close = () => r.render(null)
  r.render(<ReasonToast info={info} onClose={close} />)
}

/** Test-only: tear down the self-mounted host between cases. */
export function __resetRemovalReasonHostForTests(): void {
  if (root) {
    root.unmount()
    root = null
  }
  if (host) {
    host.remove()
    host = null
  }
}

// ── styles ────────────────────────────────────────────────────────────────────
const wrap: React.CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)',
  transform: 'translateX(-50%)',
  zIndex: 70,
  width: 'min(440px, calc(100vw - 24px))',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 14px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  boxShadow: '0 10px 34px rgba(0,0,0,.34)',
  transition: 'opacity .18s ease',
}
const prompt: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 12.5,
  color: 'var(--fg-subtle)',
}
const promptName: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  color: 'var(--fg-muted)',
}
const chipRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
}
const chip: React.CSSProperties = {
  padding: '6px 11px',
  fontFamily: 'var(--font-sans)',
  fontSize: 12.5,
  color: 'var(--fg-muted)',
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 999,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const dislikeChip: React.CSSProperties = {
  ...chip,
  color: 'var(--danger)',
  borderColor: 'color-mix(in oklch, var(--danger) 40%, var(--border-muted))',
}
const skipChip: React.CSSProperties = {
  ...chip,
  color: 'var(--fg-subtle)',
  background: 'transparent',
  border: '1px dashed var(--border-muted)',
}
