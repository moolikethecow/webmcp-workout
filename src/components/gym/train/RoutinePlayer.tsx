'use client'

/**
 * RoutinePlayer (GYM_PLAN §10b.6, M3) — the hands-free full-screen player for
 * all-timed mobility/stretch routines. GOWOD/Bend's load-bearing UX: poking
 * mm:ss inputs mid-stretch is why nobody logs stretching in Strong.
 *
 * State machine (per playlist step, built once on mount from store.workout):
 *
 *   HOLD (durationS countdown) → chime → completeSet + skipRest →
 *   TRANSITION (5s, next-up preview) → next HOLD → … → DONE
 *
 * Mechanics:
 *   - Timestamp math: each phase stores `endsAtMs`; remaining is derived from
 *     Date.now() on a ~250ms tick — throttle-proof like the rest timer.
 *   - Pause snapshots remaining ms; resume re-anchors endsAtMs from now.
 *   - +15s extends the current hold (and its ring denominator).
 *   - Skip completes the current hold and jumps straight to the next one (a tap
 *     means "I'm ready" — no transition needed).
 *   - WakeLock held while mounted (same shape as RestTimerBar's hook).
 *   - Closing keeps the session + everything logged so far — nothing is lost.
 *
 * The Mobility quick-start row hands off to this player across the
 * StartSurfaces→ActiveWorkoutView remount via the module-level autoplay latch
 * below (the Train tab's parent isn't in this seam, so the signal can't ride a
 * prop through it).
 */
import { useEffect, useRef, useState } from 'react'
import { FastForward, Pause, Play, Plus, X } from 'lucide-react'

import { useActiveWorkoutStore } from '@/lib/gym-client/active-workout-store'
import { playTimerChime } from '@/lib/timers/chime'
import { mmss } from '@/components/gym/exercises/format'

import {
  buildPlaylist,
  TRANSITION_SECONDS,
  type PlaylistStep,
} from './routine-playlist'

// ── autoplay latch (StartSurfaces ▶ → ActiveWorkoutView auto-open) ────────────
// Consume-once with a short TTL so a failed/abandoned start can never pop the
// player open on an unrelated later session.

const AUTOPLAY_TTL_MS = 30_000
let autoplayRequestedAtMs: number | null = null

/** Arm the auto-open latch (call right before store.start on a mobility ▶). */
export function requestRoutineAutoplay(): void {
  autoplayRequestedAtMs = Date.now()
}

/** Disarm the latch (call when the start that armed it failed). */
export function clearRoutineAutoplay(): void {
  autoplayRequestedAtMs = null
}

/** Consume the latch: true exactly once, and only within the TTL. */
export function consumeRoutineAutoplay(): boolean {
  const fresh =
    autoplayRequestedAtMs != null &&
    Date.now() - autoplayRequestedAtMs < AUTOPLAY_TTL_MS
  autoplayRequestedAtMs = null
  return fresh
}

// ── phase machine ─────────────────────────────────────────────────────────────

type Phase =
  /** Counting down the hold at playlist[stepIndex]. */
  | { kind: 'hold'; stepIndex: number; endsAtMs: number; totalMs: number }
  /** 5s get-ready window BEFORE playlist[stepIndex] starts. */
  | { kind: 'transition'; stepIndex: number; endsAtMs: number; totalMs: number }
  /** doneAtMs freezes the "X min" stamp — the done screen can sit open. */
  | { kind: 'done'; doneAtMs: number }

function holdPhase(playlist: PlaylistStep[], stepIndex: number): Phase {
  const ms = playlist[stepIndex].durationS * 1000
  return { kind: 'hold', stepIndex, endsAtMs: Date.now() + ms, totalMs: ms }
}

function transitionPhase(stepIndex: number): Phase {
  const ms = TRANSITION_SECONDS * 1000
  return { kind: 'transition', stepIndex, endsAtMs: Date.now() + ms, totalMs: ms }
}

function donePhase(): Phase {
  return { kind: 'done', doneAtMs: Date.now() }
}

// ── component ─────────────────────────────────────────────────────────────────

export function RoutinePlayer({
  onClose,
  onRequestFinish,
}: {
  /** Close the player; the session keeps its logged progress. */
  onClose: () => void
  /** Route to the SAME finish flow ActiveWorkoutView already uses. */
  onRequestFinish: () => void
}) {
  const store = useActiveWorkoutStore()

  // Playlist is built ONCE from the workout at mount (useState initializer —
  // never rebuilt, so optimistic completeSet updates don't reshuffle the run).
  const [playlist] = useState<PlaylistStep[]>(() =>
    buildPlaylist(store.workout?.exercises ?? []),
  )
  const [phase, setPhase] = useState<Phase>(() =>
    playlist.length > 0 ? holdPhase(playlist, 0) : donePhase(),
  )
  /** Non-null ⇔ paused; holds the frozen remaining ms of the current phase. */
  const [pausedRemainingMs, setPausedRemainingMs] = useState<number | null>(null)
  const paused = pausedRemainingMs != null

  const startedAtMsRef = useRef(Date.now())
  const reduced = usePrefersReducedMotion()
  useScreenWakeLock(true)

  // ~250ms tick while running (paused/done stops the interval entirely).
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (paused || phase.kind === 'done') return
    const id = window.setInterval(() => setNowMs(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [paused, phase.kind])

  // Advance the machine when the current phase's deadline passes. The ref keyed
  // on endsAtMs guarantees the side effects (chime + completeSet) fire once per
  // phase even if a tick lands before the setState commits.
  const firedForRef = useRef<number | null>(null)
  useEffect(() => {
    if (paused || phase.kind === 'done') return
    if (nowMs < phase.endsAtMs) return
    if (firedForRef.current === phase.endsAtMs) return
    firedForRef.current = phase.endsAtMs

    if (phase.kind === 'hold') {
      const step = playlist[phase.stepIndex]
      playTimerChime()
      store.completeSet(step.workoutExerciseId, step.clientSetId)
      store.skipRest() // the player supersedes the store's auto rest countdown
      const next = phase.stepIndex + 1
      setPhase(next >= playlist.length ? donePhase() : transitionPhase(next))
    } else {
      setPhase(holdPhase(playlist, phase.stepIndex))
    }
  }, [nowMs, paused, phase, playlist, store])

  // ── controls (every handler primes audio — a click IS a gesture) ──
  function handlePauseToggle() {
    store.primeAudio()
    if (phase.kind === 'done') return
    if (pausedRemainingMs != null) {
      setPhase({ ...phase, endsAtMs: Date.now() + pausedRemainingMs })
      setPausedRemainingMs(null)
    } else {
      setPausedRemainingMs(Math.max(0, phase.endsAtMs - Date.now()))
    }
  }

  function handleExtend() {
    store.primeAudio()
    if (phase.kind !== 'hold') return
    if (pausedRemainingMs != null) {
      setPausedRemainingMs(pausedRemainingMs + 15_000)
      setPhase({ ...phase, totalMs: phase.totalMs + 15_000 })
    } else {
      setPhase({
        ...phase,
        endsAtMs: phase.endsAtMs + 15_000,
        totalMs: phase.totalMs + 15_000,
      })
    }
  }

  function handleSkip() {
    store.primeAudio()
    if (phase.kind === 'done') return
    setPausedRemainingMs(null)
    if (phase.kind === 'hold') {
      const step = playlist[phase.stepIndex]
      store.completeSet(step.workoutExerciseId, step.clientSetId)
      store.skipRest()
      const next = phase.stepIndex + 1
      setPhase(next >= playlist.length ? donePhase() : holdPhase(playlist, next))
    } else {
      // Skipping the get-ready window starts the pending hold now.
      setPhase(holdPhase(playlist, phase.stepIndex))
    }
  }

  function handleClose() {
    store.primeAudio()
    onClose()
  }

  // ── derived render state ──
  const remainingMs =
    phase.kind === 'done'
      ? 0
      : Math.max(0, pausedRemainingMs ?? phase.endsAtMs - nowMs)
  const fraction =
    phase.kind === 'done' || phase.totalMs <= 0
      ? 0
      : Math.min(1, Math.max(0, remainingMs / phase.totalMs))
  const step = phase.kind === 'done' ? null : playlist[phase.stepIndex]
  const overallDone =
    phase.kind === 'done' ? playlist.length : phase.stepIndex
  const elapsedMin =
    phase.kind === 'done'
      ? Math.max(1, Math.round((phase.doneAtMs - startedAtMsRef.current) / 60_000))
      : 0

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Routine player">
      {/* ── overall progress hairline ── */}
      <div style={progressTrack} aria-hidden>
        <div
          style={{
            ...progressFill,
            width: `${playlist.length > 0 ? (overallDone / playlist.length) * 100 : 0}%`,
            transition: reduced ? 'none' : 'width .4s ease',
          }}
        />
      </div>

      {/* ── top bar ── */}
      <div style={topBar}>
        <span style={modeLabel}>
          Routine{playlist.length > 0 ? ` · ${overallDone}/${playlist.length}` : ''}
        </span>
        <button type="button" onClick={handleClose} aria-label="Close player" style={closeBtn}>
          <X size={18} strokeWidth={2} />
        </button>
      </div>

      {/* ── center stage ── */}
      {phase.kind === 'done' ? (
        <div style={stage}>
          <span style={doneLabel}>Routine complete</span>
          <span style={doneTitle}>
            {elapsedMin} min{playlist.length > 0 ? ` · ${playlist.length} holds` : ''}
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 340, marginTop: 26 }}>
            <button type="button" onClick={onRequestFinish} style={finishBtn}>
              Finish workout
            </button>
            <button type="button" onClick={onClose} style={keepOpenBtn}>
              Keep session open
            </button>
          </div>
        </div>
      ) : (
        <div style={stage}>
          {phase.kind === 'transition' ? (
            <>
              <span style={nextUpLabel}>Next up</span>
              <span style={exerciseName}>{step?.exerciseName}</span>
              <div style={metaLine}>
                {step?.side && <SideBadge side={step.side} />}
                <span style={holdCountLabel}>
                  hold {step?.indexInExercise} of {step?.totalInExercise}
                </span>
              </div>
              <CountRing fraction={fraction} reduced={reduced} size={148} accent="var(--warning)">
                <span style={{ ...bigClock, fontSize: 44 }}>
                  {Math.ceil(remainingMs / 1000)}
                </span>
              </CountRing>
              <span style={hint}>get into position…</span>
            </>
          ) : (
            <>
              <span style={exerciseName}>{step?.exerciseName}</span>
              <div style={metaLine}>
                {step?.side && <SideBadge side={step.side} />}
                <span style={holdCountLabel}>
                  hold {step?.indexInExercise} of {step?.totalInExercise}
                </span>
              </div>
              <CountRing fraction={fraction} reduced={reduced} size={230} accent="var(--accent)">
                <span style={bigClock}>{mmss(Math.ceil(remainingMs / 1000))}</span>
              </CountRing>
              {paused && <span style={hint}>paused</span>}
            </>
          )}
        </div>
      )}

      {/* ── controls ── */}
      {phase.kind !== 'done' && (
        <div style={controls}>
          <button
            type="button"
            onClick={handleExtend}
            disabled={phase.kind !== 'hold'}
            aria-label="Add 15 seconds to this hold"
            style={{ ...sideCtl, opacity: phase.kind === 'hold' ? 1 : 0.35 }}
          >
            <Plus size={15} strokeWidth={2} /> 15s
          </button>
          <button
            type="button"
            onClick={handlePauseToggle}
            aria-label={paused ? 'Resume' : 'Pause'}
            style={mainCtl}
          >
            {paused ? (
              <Play size={26} strokeWidth={2} fill="currentColor" />
            ) : (
              <Pause size={26} strokeWidth={2} fill="currentColor" />
            )}
          </button>
          <button
            type="button"
            onClick={handleSkip}
            aria-label={phase.kind === 'hold' ? 'Skip this hold' : 'Start next hold now'}
            style={sideCtl}
          >
            <FastForward size={15} strokeWidth={2} /> skip
          </button>
        </div>
      )}
    </div>
  )
}

// ── pieces ────────────────────────────────────────────────────────────────────

function SideBadge({ side }: { side: 'left' | 'right' }) {
  return <span style={sideBadge}>{side}</span>
}

/** Thin countdown ring; `fraction` = remaining/total (1 → full, 0 → empty). */
function CountRing({
  fraction,
  reduced,
  size,
  accent,
  children,
}: {
  fraction: number
  reduced: boolean
  size: number
  accent: string
  children: React.ReactNode
}) {
  const stroke = 5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <span
      style={{ position: 'relative', width: size, height: size, display: 'inline-flex', marginTop: 28 }}
      aria-hidden
    >
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--border-muted)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={accent}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - fraction)}
          style={{ transition: reduced ? 'none' : 'stroke-dashoffset .3s linear' }}
        />
      </svg>
      <span
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </span>
    </span>
  )
}

// ── hooks (local replicas of codebase precedents) ─────────────────────────────

/** Hold a screen wake-lock while `active`; re-acquire on visibilitychange;
 *  release on unmount. Feature-detected — silent no-op where unsupported.
 *  (Replica of RestTimerBar's hook — it isn't exported.) */
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
        // Permission denied / unsupported / not visible — silent.
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

/** prefers-reduced-motion (replica of the MuscleFigure hook). */
function usePrefersReducedMotion(): boolean {
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

// ── styles ────────────────────────────────────────────────────────────────────
const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 90, // above the numeric pad (80) + finish bar (30) — the player owns the screen
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg)',
  padding:
    'calc(10px + env(safe-area-inset-top, 0px)) 20px calc(24px + env(safe-area-inset-bottom, 0px))',
}
const progressTrack: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: 3,
  background: 'var(--border-muted)',
}
const progressFill: React.CSSProperties = {
  height: '100%',
  background: 'var(--accent)',
}
const topBar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  paddingTop: 6,
}
const modeLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const closeBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 36,
  height: 36,
  borderRadius: 10,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
}
const stage: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  gap: 10,
  minHeight: 0,
}
const exerciseName: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 26,
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '-0.01em',
  color: 'var(--fg)',
  maxWidth: '18ch',
}
const metaLine: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}
const holdCountLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const sideBadge: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  background: 'color-mix(in oklch, var(--accent) 14%, transparent)',
  border: '1px solid color-mix(in oklch, var(--accent) 35%, transparent)',
  borderRadius: 999,
  padding: '3px 9px',
}
const nextUpLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--warning)',
}
const bigClock: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 56,
  fontWeight: 600,
  color: 'var(--fg)',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '-0.02em',
}
const hint: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13.5,
  color: 'var(--fg-subtle)',
  marginTop: 6,
}
const controls: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 22,
  paddingBottom: 8,
}
const mainCtl: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 72,
  height: 72,
  borderRadius: '50%',
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
  border: 'none',
  cursor: 'pointer',
}
const sideCtl: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
  minWidth: 76,
  padding: '11px 14px',
  borderRadius: 999,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
}
const doneLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--success)',
}
const doneTitle: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 28,
  fontWeight: 600,
  color: 'var(--fg)',
  marginTop: 6,
}
const finishBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '14px 16px',
  fontFamily: 'var(--font-sans)',
  fontSize: 15.5,
  fontWeight: 600,
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  border: 'none',
  borderRadius: 12,
  cursor: 'pointer',
}
const keepOpenBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '12px 16px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13.5,
  fontWeight: 500,
  color: 'var(--fg-muted)',
  background: 'transparent',
  border: '1px solid var(--border-muted)',
  borderRadius: 12,
  cursor: 'pointer',
}
