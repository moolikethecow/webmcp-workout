'use client'

/**
 * RestTimerBar (GYM_PLAN §4 "Rest timer (honest iOS story)", P2b) — the sticky bar
 * that sits ABOVE the Finish bar while a rest countdown runs. Timestamp-math drives
 * it (the store holds `endsAt`; we derive remaining from `store.nowMs` each tick),
 * so a throttled/backgrounded tab still shows the right number the instant it wakes.
 *
 * Honest-iOS rules (§4, §2.7b — this agent owns the CLIENT half; a sibling owns Web
 * Push, which is NOT built here):
 *   - A `navigator.wakeLock('screen')` is held while a workout is active and
 *     re-acquired on visibilitychange (feature-detected, silent when unsupported).
 *   - The primary alert is a FOREGROUND chime through the gesture-primed AudioContext
 *     (playTimerChime, unlocked on the first ✓). At zero we also fire a best-effort
 *     Notification when the doc is hidden AND permission is already granted — never a
 *     mid-workout prompt.
 *
 * Controls: countdown ring + mm:ss, +30s / −15s / skip, tap-to-expand into a larger
 * sheet. Reload mid-rest loses the countdown (in-memory only) — accepted (§7).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Minus, Plus, X } from 'lucide-react'

import { useActiveWorkoutStore } from '@/lib/gym-client/active-workout-store'
import { playTimerChime } from '@/lib/timers/chime'
import {
  formatRest,
  isRestDone,
  remainingSeconds,
  ringFraction,
} from '@/lib/gym-client/rest-timer'
import {
  useAppChromeBounds,
  WORKOUT_FINISH_BAR_RESERVE_PX,
  WORKOUT_REST_TIMER_RESERVE_PX,
} from './fixed-chrome'

export function RestTimerBar() {
  const store = useActiveWorkoutStore()
  const { restTimer, nowMs, workout } = store
  const [expanded, setExpanded] = useState(false)
  const chrome = useAppChromeBounds()

  // Hold a screen wake-lock for the whole active workout (re-acquire on wake).
  useScreenWakeLock(Boolean(workout))
  // Fire the chime + best-effort notification exactly once when the timer hits 0.
  useRestCompletionAlert(restTimer, nowMs)

  const secs = remainingSeconds(restTimer, nowMs)
  const frac = ringFraction(restTimer, nowMs)
  const exerciseName = useMemo(() => {
    if (!restTimer || !workout) return null
    return workout.exercises.find((e) => e.exerciseId === restTimer.exerciseId)?.name ?? null
  }, [restTimer, workout])

  if (!restTimer) return null
  const done = isRestDone(restTimer, nowMs)

  return (
    <>
      <div
        style={{
          ...bar,
          left: chrome.left + 12,
          right: chrome.right + 12,
          bottom: chrome.bottom + WORKOUT_FINISH_BAR_RESERVE_PX,
        }}
        role="timer"
        aria-label={`Rest ${formatRest(secs)}`}
      >
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="Expand rest timer"
          style={ringBtn}
        >
          <Ring fraction={frac} done={done} size={38} stroke={4}>
            <span style={ringText}>{formatRest(secs)}</span>
          </Ring>
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={restLabel}>{done ? 'Rest done' : 'Resting'}</div>
          {exerciseName && <div style={restEx}>after {exerciseName}</div>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" onClick={() => store.adjustRest(-15)} style={adjBtn} aria-label="Subtract 15 seconds">
            <Minus size={12} strokeWidth={2.4} />15
          </button>
          <button type="button" onClick={() => store.adjustRest(30)} style={adjBtn} aria-label="Add 30 seconds">
            <Plus size={12} strokeWidth={2.4} />30
          </button>
          <button type="button" onClick={() => store.skipRest()} style={skipBtn} aria-label="Skip rest">
            Skip
          </button>
        </div>
      </div>

      {expanded && (
        <RestSheet
          seconds={secs}
          fraction={frac}
          done={done}
          exerciseName={exerciseName}
          onAdjust={(d) => store.adjustRest(d)}
          onSkip={() => {
            store.skipRest()
            setExpanded(false)
          }}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  )
}

// ── expanded sheet ────────────────────────────────────────────────────────────
function RestSheet({
  seconds,
  fraction,
  done,
  exerciseName,
  onAdjust,
  onSkip,
  onClose,
}: {
  seconds: number
  fraction: number
  done: boolean
  exerciseName: string | null
  onAdjust: (deltaSeconds: number) => void
  onSkip: () => void
  onClose: () => void
}) {
  return createPortal(
    <div style={sheetScrim} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Rest timer" style={sheet}>
        <button type="button" onClick={onClose} aria-label="Close rest timer" style={sheetClose}>
          <X size={16} color="var(--fg-muted)" />
        </button>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 14px' }}>
          <Ring fraction={fraction} done={done} size={168} stroke={12}>
            <span style={sheetTime}>{formatRest(seconds)}</span>
          </Ring>
        </div>
        <div style={sheetLabel}>{done ? 'Rest done — next set' : `Resting${exerciseName ? ` after ${exerciseName}` : ''}`}</div>
        <div style={sheetControls}>
          <button type="button" onClick={() => onAdjust(-15)} style={sheetAdj} aria-label="Subtract 15 seconds">
            −15s
          </button>
          <button type="button" onClick={() => onAdjust(30)} style={sheetAdj} aria-label="Add 30 seconds">
            +30s
          </button>
        </div>
        <button type="button" onClick={onSkip} style={sheetSkip}>
          Skip rest
        </button>
      </div>
    </div>,
    document.body,
  )
}

// ── countdown ring (pure SVG) ───────────────────────────────────────────────────
function Ring({
  fraction,
  done,
  size,
  stroke,
  children,
}: {
  fraction: number
  done: boolean
  size: number
  stroke: number
  children: React.ReactNode
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const color = done ? 'var(--success, var(--accent))' : 'var(--accent)'
  return (
    <span style={{ position: 'relative', width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-muted)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - fraction)}
          style={{ transition: 'stroke-dashoffset .9s linear, stroke .3s' }}
        />
      </svg>
      <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </span>
    </span>
  )
}

// ── hooks ────────────────────────────────────────────────────────────────────

/** Hold a screen wake-lock while `active`; re-acquire on visibilitychange; release
 *  on inactive/unmount. Feature-detected — a no-op (silent) where unsupported. */
function useScreenWakeLock(active: boolean) {
  const sentinelRef = useRef<WakeLockSentinel | null>(null)

  useEffect(() => {
    if (!active) return
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return
    let released = false

    const request = async () => {
      try {
        // Only when visible — requesting while hidden throws.
        if (document.visibilityState !== 'visible') return
        sentinelRef.current = await navigator.wakeLock.request('screen')
        sentinelRef.current.addEventListener?.('release', () => {
          sentinelRef.current = null
        })
      } catch {
        // Permission denied / unsupported / not visible — silent (§4 honest copy).
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !sentinelRef.current && !released) {
        void request()
      }
    }

    void request()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisibility)
      const s = sentinelRef.current
      sentinelRef.current = null
      void s?.release?.().catch(() => {})
    }
  }, [active])
}

/** Fire the foreground chime once when the timer reaches zero, plus a best-effort
 *  Notification when the doc is hidden AND permission is already granted (never a
 *  mid-workout prompt — the settings sheet owns the permission ask). */
function useRestCompletionAlert(
  restTimer: { endsAt: number; exerciseId: string } | null,
  nowMs: number,
) {
  // Track which timer instance (by endsAt) we've already alerted, so re-renders +
  // the ticking `nowMs` don't re-fire the chime.
  const alertedFor = useRef<number | null>(null)

  useEffect(() => {
    if (!restTimer) {
      alertedFor.current = null
      return
    }
    if (nowMs < restTimer.endsAt) return
    if (alertedFor.current === restTimer.endsAt) return
    alertedFor.current = restTimer.endsAt

    playTimerChime()

    try {
      if (
        typeof document !== 'undefined' &&
        document.hidden &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        // eslint-disable-next-line no-new -- fire-and-forget OS notification
        new Notification('Rest done', { body: 'Time for your next set.', tag: 'gym-rest' })
      }
    } catch {
      // Notification unavailable — the foreground chime already fired.
    }
  }, [restTimer, nowMs])
}

// ── styles ────────────────────────────────────────────────────────────────────
const bar: React.CSSProperties = {
  position: 'fixed',
  zIndex: 31,
  boxSizing: 'border-box',
  minHeight: WORKOUT_REST_TIMER_RESERVE_PX,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  maxWidth: 1008,
  margin: '0 auto',
  padding: '8px 12px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 12,
  boxShadow: '0 6px 22px rgba(0,0,0,.22)',
}
const ringBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  flexShrink: 0,
}
const ringText: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  fontWeight: 700,
  color: 'var(--fg)',
  fontVariantNumeric: 'tabular-nums',
}
const restLabel: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--fg)',
}
const restEx: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--fg-subtle)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const adjBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 1,
  height: 30,
  padding: '0 8px',
  borderRadius: 8,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg)',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
}
const skipBtn: React.CSSProperties = {
  height: 30,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg)',
  color: 'var(--fg-subtle)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  cursor: 'pointer',
}
const sheetScrim: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 82,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  background: 'color-mix(in oklch, var(--bg) 40%, transparent)',
}
const sheet: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  maxWidth: 340,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 18,
  boxShadow: '0 20px 60px rgba(0,0,0,.4)',
  padding: '24px 20px 20px',
}
const sheetClose: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  width: 30,
  height: 30,
  borderRadius: 8,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-elevated)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const sheetTime: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 40,
  fontWeight: 700,
  color: 'var(--fg)',
  fontVariantNumeric: 'tabular-nums',
}
const sheetLabel: React.CSSProperties = {
  textAlign: 'center',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 15,
  color: 'var(--fg-muted)',
  marginBottom: 16,
}
const sheetControls: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
  marginBottom: 10,
}
const sheetAdj: React.CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-elevated)',
  color: 'var(--fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
}
const sheetSkip: React.CSSProperties = {
  width: '100%',
  height: 44,
  borderRadius: 12,
  border: 'none',
  background: 'transparent',
  color: 'var(--fg-subtle)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
  cursor: 'pointer',
}
