'use client'

/**
 * ActiveWorkoutView (GYM_PLAN §4 "Tab: Train / Active workout") — the shell around
 * the logger while a workout is live. This agent (P2a-A3) owns the CHROME; the set
 * table + numeric pad are A2's `<LoggerExerciseList />` + `<NumericPadHost />`,
 * mounted here.
 *
 * Layout (top → bottom), the whole thing wrapped in A2's <NumericPadHost> (it is
 * a Provider + the single portal host — the logger's set fields open the pad via
 * usePad(), which requires this ancestor):
 *   - Header: editable workout name (inline input via store.updateHeader), elapsed
 *     timer (mm:ss, rolling over to "1h 5m" past an hour — from store.elapsedSeconds),
 *     <SyncPill/> (self-sources the store), overflow → Discard (ConfirmModal).
 *   - <LoggerExerciseList/> — A2's logger core.
 *   - Sticky bottom bar: [Finish] primary; disabled with a tooltip when zero
 *     completed sets. finish() flushes the queue then resolves the summary; the
 *     parent (TrainTab) opens the FinishSheet.
 *
 * The store is consumed via A2's `useActiveWorkoutStore()` (imported by TrainTab
 * and passed down as `store`), so this component stays presentational + testable.
 */
import { useEffect, useMemo, useState } from 'react'
import { MoreVertical, Play, Sparkles, XCircle } from 'lucide-react'

import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { LoggerExerciseList, NumericPadHost, RestTimerBar, SyncPill } from '@/components/gym/logger'
import { UnitDisplayProvider } from '@/components/gym/logger/unit-context'
import {
  useAppChromeBounds,
  workoutContentBottomReserve,
} from '@/components/gym/logger/fixed-chrome'
import { elapsedClock } from '@/components/gym/exercises/format'
import type { Unit } from '@/lib/gym-client/active-types'
import { normalizeGeneratedWorkoutName } from '@/lib/gym/display-name'
import type { CurrentExercise } from '@/lib/gym-client/tune-diff'

import { RoutinePlayer, consumeRoutineAutoplay } from './RoutinePlayer'
import { buildPlaylist, isTimedRoutine } from './routine-playlist'
import { TuneSheet } from './TuneSheet'
import type { ActiveWorkout, ActiveWorkoutStore } from './store-contract'
import { StartNoticesBanner } from './StartNoticesBanner'

export function ActiveWorkoutView({
  store,
  onFinished,
  onDiscarded,
}: {
  store: ActiveWorkoutStore
  /** Called with the finish summary once finish() resolves — parent opens the sheet. */
  onFinished: (args: {
    summary: Awaited<ReturnType<ActiveWorkoutStore['finish']>>
    workoutId: string
    workoutName: string | null
    hadTemplate: boolean
  }) => void
  /** Called after a successful discard — parent returns to StartSurfaces. */
  onDiscarded: () => void
}) {
  const { workout, elapsedSeconds, syncState, restTimer } = store
  const [finishing, setFinishing] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [tuneOpen, setTuneOpen] = useState(false)
  // A template-started workout can be "Tuned for today" once (§2.7). Once tuned (or
  // explicitly dismissed) the banner + menu item go away for this session.
  const [tuned, setTuned] = useState(false)
  const chrome = useAppChromeBounds()

  // Finishing is always allowed. A session can end for reasons that have nothing
  // to do with what got logged — the gym closes, someone is hurt, the warm-up
  // said no — and trapping a person in a workout they cannot close is worse than
  // an honest empty session.
  const completedSets = useMemo(() => countCompletedSets(workout), [workout])
  const canFinish = true

  // Tune-for-today is offered only for a template-started workout that hasn't been
  // tuned yet (GYM_PLAN §2.7 — coach adjustments applied to a template in place).
  const canTune = workout?.templateId != null && !tuned

  // ── Routine player (§10b.6 M3): offered when EVERY exercise is timed and ≥1
  // playable hold remains. The Mobility ▶ quick-start arms a consume-once latch
  // before store.start(); this view mounts right after and auto-opens the player.
  const [playerOpen, setPlayerOpen] = useState(false)
  const canPlayRoutine = workout != null && isTimedRoutine(workout.exercises)
  const holdCount = useMemo(
    () => (workout && canPlayRoutine ? buildPlaylist(workout.exercises).length : 0),
    [workout, canPlayRoutine],
  )
  useEffect(() => {
    // Consume unconditionally (the latch targeted THIS session start); open only
    // when the session actually qualifies. primeAudio already ran on the ▶ tap.
    if (consumeRoutineAutoplay() && canPlayRoutine) setPlayerOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only handoff
  }, [])

  async function handleFinish() {
    if (!workout || !canFinish || finishing) return
    setFinishing(true)
    try {
      const summary = await store.finish()
      onFinished({
        summary,
        workoutId: workout.id,
        workoutName: workout.name,
        hadTemplate: workout.templateId != null,
      })
    } catch (err) {
      // Offline finish: the store rejects and keeps the workout active. Distinguish
      // the offline case so the copy is honest ("sets are saved locally").
      if (isOfflineError(err) || syncState === 'offline') {
        showError("Can't finish offline — your sets are saved locally and will sync when you reconnect.")
      } else {
        showError("Couldn't finish the workout — try again.")
      }
    } finally {
      setFinishing(false)
    }
  }

  async function handleDiscard() {
    setDiscarding(true)
    try {
      await store.discard()
      onDiscarded()
    } catch {
      showError("Couldn't discard the workout — try again.")
    } finally {
      setDiscarding(false)
      setConfirmDiscard(false)
    }
  }

  if (!workout) return null

  return (
    <NumericPadHost>
    {/* paddingBottom reserves room above the sticky finish bar (76px) — plus the
        rest timer bar's own height when it's showing, stacked above the finish
        bar, or the last set(s) scroll in underneath it and stay hidden. */}
    <div
      data-testid="active-workout-content"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        paddingBottom: workoutContentBottomReserve(Boolean(restTimer)),
      }}
    >
      {/* ── What the start path changed or flagged (#1790) ── */}
      <StartNoticesBanner
        notices={workout.startNotices}
        onRestored={() => void store.refresh()}
      />

      {/* ── Header ── */}
      <div style={header}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <NameField
            value={normalizeGeneratedWorkoutName(workout.name ?? '')}
            onCommit={(name) => void commitName(store, name)}
          />
          <div style={metaRow}>
            <span style={timer} aria-label="Elapsed time">
              {elapsedClock(elapsedSeconds)}
            </span>
            <SyncPill />
            <UnitPill
              value={store.displayUnit}
              onChange={(u) => store.setDisplayUnit(u)}
            />
          </div>
        </div>

        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Workout options"
            aria-expanded={menuOpen}
            style={iconBtn}
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <>
              <div style={menuScrim} onClick={() => setMenuOpen(false)} role="presentation" />
              <div style={menu} role="menu">
                {canTune && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      setTuneOpen(true)
                    }}
                    style={{ ...menuItem, color: 'var(--accent)' }}
                  >
                    <Sparkles size={13} /> Tune for today
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setConfirmDiscard(true)
                  }}
                  style={menuItem}
                >
                  <XCircle size={13} /> Cancel workout
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── ▶ Play routine (all-timed session — the §10b.6 hands-free player) ── */}
      {canPlayRoutine && (
        <button
          type="button"
          onClick={() => {
            // This tap is the gesture that unlocks the chime's AudioContext.
            store.primeAudio()
            setPlayerOpen(true)
          }}
          aria-label="Play routine"
          style={playRoutineBtn}
        >
          <Play size={16} strokeWidth={2} fill="currentColor" />
          Play routine
          <span style={playRoutineCount}>
            {holdCount} hold{holdCount === 1 ? '' : 's'}
          </span>
        </button>
      )}

      {/* ── Tune-for-today ✦ slim banner (template-started, not yet tuned) ── */}
      {canTune && (
        <button
          type="button"
          onClick={() => setTuneOpen(true)}
          style={tuneBanner}
          aria-label="Tune this workout for today"
        >
          <Sparkles size={14} strokeWidth={2} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={tuneBannerText}>
            Started from a template — <strong>tune it for today?</strong> Adjusts for
            recovery, constraints and boredom.
          </span>
        </button>
      )}

      {/* ── Logger core (A2), unit-toggle-aware ── */}
      <UnitDisplayProvider override={store.displayUnit} distanceUnit={workout.distanceUnit ?? 'm'}>
        <LoggerExerciseList />
      </UnitDisplayProvider>

      {/* ── Rest timer bar (above the finish bar) ── */}
      <RestTimerBar />

      {/* ── Sticky finish bar ── */}
      <div
        style={{
          ...finishBar,
          left: chrome.left,
          right: chrome.right,
          bottom: chrome.bottom,
        }}
      >
        <button
          type="button"
          onClick={() => void handleFinish()}
          disabled={!canFinish || finishing}
          title={completedSets > 0 ? undefined : 'Finish with nothing logged'}
          aria-label={completedSets > 0 ? 'Finish workout' : 'Finish workout (nothing logged)'}
          style={{
            ...finishBtn,
            opacity: canFinish && !finishing ? 1 : 0.5,
            cursor: canFinish && !finishing ? 'pointer' : 'default',
          }}
        >
          {finishing ? 'Finishing…' : 'Finish'}
        </button>
      </div>

      {confirmDiscard && (
        <ConfirmModal
          title="Cancel this workout?"
          description="This stops the workout and marks the session discarded. Its sets stay out of your history, progress, and recovery stats. This can't be undone."
          confirmLabel="Cancel workout"
          loading={discarding}
          onConfirm={() => void handleDiscard()}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}

      {tuneOpen && workout.templateId && (
        <TuneSheet
          templateId={workout.templateId}
          current={currentExercises(workout)}
          onAddExercise={store.addExercise}
          onRemoveExercise={store.removeExercise}
          onApplied={() => setTuned(true)}
          onClose={() => setTuneOpen(false)}
        />
      )}

      {playerOpen && (
        <RoutinePlayer
          onClose={() => setPlayerOpen(false)}
          onRequestFinish={() => {
            // SAME finish flow as the sticky bar — close the overlay first so the
            // FinishSheet the parent opens isn't buried under it.
            setPlayerOpen(false)
            void handleFinish()
          }}
        />
      )}
    </div>
    </NumericPadHost>
  )
}

/** Snapshot the active workout's exercises into the tune-diff's minimal shape. */
function currentExercises(w: ActiveWorkout): CurrentExercise[] {
  return w.exercises.map((ex) => ({
    workoutExerciseId: ex.workoutExerciseId,
    exerciseId: ex.exerciseId,
    name: ex.name,
  }))
}

// ── workout-level display-unit pill (lb ⇄ kg) ────────────────────────────────
function UnitPill({
  value,
  onChange,
}: {
  value: Unit | null
  onChange: (unit: Unit | null) => void
}) {
  // The pill shows the ACTIVE display unit; tapping it flips lb⇄kg (explicit
  // override). Default (null) presents as 'lb' but tapping sets an explicit unit so
  // the whole session renders in it — DISPLAY only, stored rows never change (§8).
  const active: Unit = value ?? 'lb'
  return (
    <div style={unitPill} role="group" aria-label="Display unit">
      {(['lb', 'kg'] as const).map((u) => {
        const on = active === u
        return (
          <button
            key={u}
            type="button"
            onClick={() => onChange(u)}
            aria-pressed={on}
            aria-label={`Show weights in ${u}`}
            style={{
              ...unitPillBtn,
              color: on ? 'var(--accent-fg, var(--fg))' : 'var(--fg-subtle)',
              background: on ? 'var(--accent)' : 'transparent',
            }}
          >
            {u}
          </button>
        )
      })}
    </div>
  )
}

// ── inline editable name ─────────────────────────────────────────────────────
function NameField({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  const [local, setLocal] = useState(value)
  const [editing, setEditing] = useState(false)

  // Keep the local mirror aligned when the store's name changes underneath and
  // we're not mid-edit.
  if (!editing && local !== value) setLocal(value)

  return (
    <input
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => setEditing(true)}
      onBlur={() => {
        setEditing(false)
        const next = local.trim()
        if (next !== value) onCommit(next)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      placeholder="Name workout…"
      aria-label="Workout name"
      style={nameInput}
    />
  )
}

// ── store helpers ────────────────────────────────────────────────────────────
/** Count completed sets across the active workout's exercises. */
function countCompletedSets(w: ActiveWorkout | null): number {
  if (!w) return 0
  let n = 0
  for (const ex of w.exercises) {
    for (const s of ex.sets) {
      if (s.completed) n++
    }
  }
  return n
}

/** Commit a name change through the store (updateHeader), surfacing errors. */
async function commitName(store: ActiveWorkoutStore, name: string): Promise<void> {
  try {
    await store.updateHeader({ name })
  } catch {
    showError("Couldn't rename the workout.")
  }
}

function isOfflineError(err: unknown): boolean {
  if (err == null) return false
  const msg = err instanceof Error ? err.message : String(err)
  return /offline|network|failed to fetch/i.test(msg)
}

/** Lazy toast — imported dynamically so the store helpers stay import-light. */
function showError(message: string): void {
  void import('sonner').then(({ toast }) => toast.error(message))
}

// ── styles ───────────────────────────────────────────────────────────────────
const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
}
const nameInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 6px',
  margin: '-4px -6px',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontWeight: 400,
  fontSize: 22,
  letterSpacing: '-0.01em',
  color: 'var(--fg)',
  background: 'transparent',
  border: '1px solid transparent',
  borderRadius: 8,
  outline: 'none',
}
const metaRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 12,
  marginTop: 8,
}
const timer: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--fg)',
  fontVariantNumeric: 'tabular-nums',
}
const unitPill: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: 2,
  borderRadius: 8,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-elevated)',
}
const unitPillBtn: React.CSSProperties = {
  minWidth: 26,
  height: 22,
  padding: '0 7px',
  borderRadius: 6,
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
}
const iconBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 34,
  height: 34,
  borderRadius: 9,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
}
const playRoutineBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  width: '100%',
  padding: '13px 16px',
  fontFamily: 'var(--font-sans)',
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  border: 'none',
  borderRadius: 12,
  cursor: 'pointer',
}
const playRoutineCount: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  opacity: 0.75,
}
const tuneBanner: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  width: '100%',
  padding: '10px 12px',
  textAlign: 'left',
  borderRadius: 10,
  background: 'linear-gradient(135deg, color-mix(in oklch, var(--accent) 10%, var(--bg-elevated)), var(--bg-elevated))',
  border: '1px solid color-mix(in oklch, var(--accent) 30%, var(--border-muted))',
  cursor: 'pointer',
  fontFamily: 'inherit',
}
const tuneBannerText: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 12.5,
  lineHeight: 1.4,
  color: 'var(--fg-muted)',
}
const menuScrim: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 40,
}
const menu: React.CSSProperties = {
  position: 'absolute',
  top: 40,
  right: 0,
  zIndex: 41,
  minWidth: 180,
  padding: 5,
  borderRadius: 10,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  boxShadow: '0 8px 28px rgba(0,0,0,.28)',
}
const menuItem: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '9px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: 'var(--danger)',
  background: 'transparent',
  border: 'none',
  borderRadius: 7,
  cursor: 'pointer',
  textAlign: 'left',
}
const finishBar: React.CSSProperties = {
  position: 'fixed',
  zIndex: 30,
  padding: '12px 16px',
  background: 'color-mix(in oklch, var(--bg) 88%, transparent)',
  backdropFilter: 'blur(8px)',
  borderTop: '1px solid var(--border-muted)',
}
const finishBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  maxWidth: 1008,
  margin: '0 auto',
  padding: '14px 16px',
  fontFamily: 'var(--font-sans)',
  fontSize: 15.5,
  fontWeight: 600,
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  border: 'none',
  borderRadius: 12,
}
