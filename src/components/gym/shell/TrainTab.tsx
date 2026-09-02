'use client'

/**
 * Train tab (GYM_PLAN §4 "Tab: Train", P2a) — the live-logging surface.
 *
 * Wraps everything in A2's <ActiveWorkoutProvider> and drives the top-level state
 * machine off the optimistic store:
 *
 *   probe() on mount →
 *     • active workout exists → <ActiveWorkoutView> (+ a stale <ResumeBanner> when
 *       it's >30 min old with nothing logged yet)
 *     • none → <StartSurfaces> (repeat-last hero · template quick-start · empty)
 *
 *   finish() resolves → <FinishSheet> (summary + PRs + template prompt); closing it
 *   returns to <StartSurfaces> (the store cleared the workout).
 *
 * The store VALUES come from A2's module ('@/lib/gym-client/active-workout-store');
 * the TYPES are the local store-contract mirror so this compiles independently
 * while A2 lands. In tests, that module is vi.mock()'d so this file's behavior is
 * verified without A2's implementation.
 */
import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { HCard, MonoLabel } from '@/components/health/primitives'
import {
  ActiveWorkoutProvider,
  useActiveWorkoutStore,
} from '@/lib/gym-client/active-workout-store'

import { ActiveWorkoutView } from '@/components/gym/train/ActiveWorkoutView'
import { StartSurfaces } from '@/components/gym/train/StartSurfaces'
import { ResumeBanner } from '@/components/gym/train/ResumeBanner'
import { FinishSheet } from '@/components/gym/train/FinishSheet'
import type {
  ActiveWorkoutStore,
  FinishSummary,
  StartFrom,
} from '@/components/gym/train/store-contract'

/** A workout is "stale" (resume-banner) when it's this old with no set logged. */
const STALE_MINUTES = 30

interface FinishState {
  summary: FinishSummary
  workoutId: string
  workoutName: string | null
  hadTemplate: boolean
}

function TrainTabInner() {
  const store = useActiveWorkoutStore()
  const { workout, loading, probe } = store
  const router = useRouter()
  const searchParams = useSearchParams()

  const [starting, setStarting] = useState<StartFrom | null>(null)
  const [finishState, setFinishState] = useState<FinishState | null>(null)
  const [bannerDismissed, setBannerDismissed] = useState(false)

  // Probe once on mount for an in-progress workout — unless Templates deep-linked
  // a template via ?startTemplate=<id> (#1875: the link used to only navigate
  // here and leave the user to start manually), in which case start it directly.
  // Consume the param once and strip it so a reload/Back doesn't re-fire the start.
  useEffect(() => {
    const templateId = searchParams.get('startTemplate')
    if (templateId) {
      const params = new URLSearchParams(searchParams.toString())
      params.delete('startTemplate')
      router.replace(`/gym?${params.toString()}`)
      void handleStart('template', templateId)
    } else {
      void probe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleStart(from: StartFrom, templateId?: string) {
    if (starting) return
    setStarting(from)
    try {
      // A2's start() resolves normally even on a 409 — it probes + hydrates the
      // existing session internally (no throw), so store.workout carries the result.
      await store.start(from, templateId)
      setBannerDismissed(false)
    } catch {
      const { toast } = await import('sonner')
      toast.error("Couldn't start the workout — try again.")
    } finally {
      setStarting(null)
    }
  }

  // ── First-load: probing, nothing decided yet ──
  if (loading && !workout) {
    return (
      <HCard pad={22}>
        <MonoLabel>Train</MonoLabel>
        <p style={loadingNote}>Checking for an active workout…</p>
      </HCard>
    )
  }

  // ── Active workout ──
  if (workout && !finishState) {
    const stale = isStale(store) && !bannerDismissed
    return (
      <div>
        {stale && (
          <ResumeBanner
            minutesAgo={minutesSince(workout.startedAt)}
            onResume={() => setBannerDismissed(true)}
            onDiscard={() => store.discard()}
          />
        )}
        <ActiveWorkoutView
          store={store}
          onFinished={(s) => setFinishState(s)}
          onDiscarded={() => setBannerDismissed(false)}
        />
      </div>
    )
  }

  // ── Finished → summary sheet over the start surface ──
  return (
    <div>
      <StartSurfaces onStart={(f, id) => void handleStart(f, id)} starting={starting} />
      {finishState && (
        <FinishSheet
          workoutId={finishState.workoutId}
          workoutName={finishState.workoutName}
          summary={finishState.summary}
          hadTemplate={finishState.hadTemplate}
          onClose={() => setFinishState(null)}
        />
      )}
    </div>
  )
}

export default function TrainTab() {
  return (
    <ActiveWorkoutProvider>
      <TrainTabInner />
    </ActiveWorkoutProvider>
  )
}

// ── staleness helpers ────────────────────────────────────────────────────────
function minutesSince(iso: string): number {
  const started = new Date(iso).getTime()
  if (Number.isNaN(started)) return 0
  return Math.max(0, Math.floor((Date.now() - started) / 60_000))
}

/** Stale = started >30 min ago AND no set has been completed yet. */
function isStale(store: ActiveWorkoutStore): boolean {
  const w = store.workout
  if (!w) return false
  if (minutesSince(w.startedAt) < STALE_MINUTES) return false
  for (const ex of w.exercises) {
    for (const s of ex.sets) {
      if (s.completed) return false
    }
  }
  return true
}

const loadingNote: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13.5,
  color: 'var(--fg-subtle)',
  margin: '12px 0 0',
}
