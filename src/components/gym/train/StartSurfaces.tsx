'use client'

/**
 * StartSurfaces — the Train tab when NO workout is active (GYM_PLAN §4 "Tab:
 * Train / No active workout"). Direct, no fluff, one-handed at 390–414px:
 *
 *   1. [Repeat last workout] hero — name, date, N exercises, duration of the last
 *      completed session; tap → start('repeat_last'). Hidden when there's none.
 *   2. Template quick-start list — each template's name, folder, exercise count,
 *      last-performed stamp; tap → start('template', id). Renders only when
 *      non-empty (a new account has ZERO templates, so this is invisible until they
 *      builds some in P2b).
 *   3. [Start empty workout] — always available, the honest floor.
 *
 * One GET (/api/gym/templates) powers all three (useStartSurface). `starting`
 * disables the buttons + shows a spinner label so a double-tap can't open two.
 */
import { useCallback, useEffect, useState } from 'react'
import { ClipboardList, Dumbbell, Play, Plus, RotateCcw } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { HCard, MonoLabel } from '@/components/health/primitives'
import { relTime } from '@/components/gym/exercises/format'
import { useActiveWorkoutStore } from '@/lib/gym-client/active-workout-store'
import { useLiveRefresh } from '@/lib/stores/use-live-refresh'
import {
  dismissProposal as apiDismissProposal,
  draftPlan,
  fetchTodayProposal,
  startProposal,
  type Proposal,
} from '@/lib/gym-client/plan-client'

import { ProposalCard } from './ProposalCard'
import { clearRoutineAutoplay, requestRoutineAutoplay } from './RoutinePlayer'
import { useStartSurface } from './templates-fetch'
import type { StartFrom } from './store-contract'

/** In-flight action on the proposal (drives skeletons + disabled state). */
type ProposalBusy = null | 'load' | 'draft' | 'start' | 'dismiss' | 'refresh'

export function StartSurfaces({
  onStart,
  starting,
}: {
  /** Delegates to the store's start(); the parent owns error handling. */
  onStart: (from: StartFrom, templateId?: string) => void
  /** The kind currently starting (disables all start affordances), or null. */
  starting: StartFrom | null
}) {
  const router = useRouter()
  // Only fetch when idle (no active workout) — this component only mounts then,
  // but gate anyway so it never fires mid-session.
  const { data, loading, error } = useStartSurface(true)

  const templates = data?.templates ?? []
  // Mobility (all-timed) templates get their own ▶ quick-start group (§10b.6 M3);
  // the strength list excludes them so nothing renders twice.
  const mobilityTemplates = templates.filter((t) => t.isMobility)
  const strengthTemplates = templates.filter((t) => !t.isMobility)
  const last = data?.lastWorkout ?? null
  const busy = starting != null

  // ── AI-coach proposal lifecycle (GYM_PLAN §2.7) ──
  const store = useActiveWorkoutStore()
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [proposalBusy, setProposalBusy] = useState<ProposalBusy>('load')
  // Mobility ▶: which routine template is mid-start (per-row spinner + disable).
  const [playingRoutineId, setPlayingRoutineId] = useState<string | null>(null)

  // GET today's proposal on mount (never runs the LLM server-side).
  useEffect(() => {
    let alive = true
    fetchTodayProposal()
      .then((p) => {
        if (alive) setProposal(p)
      })
      .catch(() => {
        /* no proposal surface on read failure — the draft button still works */
      })
      .finally(() => {
        if (alive) setProposalBusy(null)
      })
    return () => {
      alive = false
    }
  }, [])

  // Live refresh: a chat turn that mutates the gym resource (plan_workout draft/
  // shuffle, or edit_workout_proposal's conversational tweaks) bumps the 'gym'
  // counter — refetch today's proposal so the card updates in place, no reload.
  // The mount is skipped by useLiveRefresh (the effect above already did the GET).
  useLiveRefresh('gym', () => {
    fetchTodayProposal()
      .then((p) => setProposal(p))
      .catch(() => {
        /* leave the current card up on a refetch hiccup */
      })
  })

  const toastError = useCallback(async (msg: string) => {
    const { toast } = await import('sonner')
    toast.error(msg)
  }, [])

  const handleDraft = useCallback(
    async (focus: string) => {
      setProposalBusy('draft')
      try {
        setProposal(await draftPlan(focus))
      } catch {
        void toastError("Couldn't draft a workout — try again.")
      } finally {
        setProposalBusy(null)
      }
    },
    [toastError],
  )

  const handleRefresh = useCallback(async () => {
    setProposalBusy('refresh')
    try {
      // Stale refresh = re-draft from scratch (fresh context) per §2.7.
      setProposal(await draftPlan(''))
    } catch {
      void toastError("Couldn't refresh — try again.")
    } finally {
      setProposalBusy(null)
    }
  }, [toastError])

  const handleDismiss = useCallback(async () => {
    if (!proposal) return
    const prev = proposal
    setProposalBusy('dismiss')
    setProposal(null) // optimistic
    try {
      await apiDismissProposal(prev.id)
    } catch {
      setProposal(prev) // rollback
      void toastError("Couldn't dismiss — try again.")
    } finally {
      setProposalBusy(null)
    }
  }, [proposal, toastError])

  const handleProposalStart = useCallback(async () => {
    if (!proposal) return
    setProposalBusy('start')
    try {
      const res = await startProposal(proposal.id)
      // Either the workout came back, or a 409 said one's already active — in both
      // cases the store hydrates from the server (§ instructions: probe() after).
      await store.probe()
      if (res.conflictActiveWorkoutId) {
        void toastError('You already have a workout in progress — resuming it.')
      }
    } catch {
      void toastError("Couldn't start the workout — try again.")
    } finally {
      setProposalBusy(null)
    }
  }, [proposal, store, toastError])

  /**
   * Mobility ▶ Play: start the routine session, then hand off to the player.
   * The store's start() owns 409s (it hydrates the existing session, no throw),
   * so on resolve the parent swaps to ActiveWorkoutView — which consumes the
   * autoplay latch and opens the RoutinePlayer. primeAudio() runs HERE because
   * this tap is the user gesture that must unlock the chime's AudioContext.
   */
  const handlePlayRoutine = useCallback(
    async (templateId: string) => {
      if (playingRoutineId) return
      store.primeAudio()
      setPlayingRoutineId(templateId)
      requestRoutineAutoplay()
      try {
        await store.start('template', templateId)
      } catch {
        clearRoutineAutoplay()
        void toastError("Couldn't start the routine — try again.")
      } finally {
        setPlayingRoutineId(null)
      }
    },
    [playingRoutineId, store, toastError],
  )

  // The proposal card blocks the other start affordances while it's mid-action.
  const proposalActive = proposalBusy != null && proposalBusy !== 'load'
  const surfacesBusy = busy || proposalActive || playingRoutineId != null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* ── Today's pick (proposal or draft-one-for-me) ── */}
      {proposalBusy !== 'load' && (
        <ProposalCard
          proposal={proposal}
          busy={proposalBusy}
          onDraft={(focus) => void handleDraft(focus)}
          onStart={() => void handleProposalStart()}
          onDismiss={() => void handleDismiss()}
          onRefresh={() => void handleRefresh()}
        />
      )}

      {/* ── Repeat last hero ── */}
      {last && (
        <button
          type="button"
          onClick={() => onStart('repeat_last')}
          disabled={surfacesBusy}
          aria-label={`Repeat last workout${last.name ? `: ${last.name}` : ''}`}
          style={{ ...heroBtn, opacity: surfacesBusy ? 0.6 : 1, cursor: surfacesBusy ? 'default' : 'pointer' }}
        >
          <span style={heroIcon}>
            <RotateCcw size={18} strokeWidth={1.9} />
          </span>
          <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
            <span style={heroLabel}>Repeat last workout</span>
            <span style={heroTitle}>{last.name || 'Last session'}</span>
            <span style={heroMeta}>
              {relTime(last.date)} · {exCount(last.exerciseCount)}
              {last.durationSeconds != null ? ` · ${mins(last.durationSeconds)}` : ''}
            </span>
          </span>
          {starting === 'repeat_last' && <Spinner />}
        </button>
      )}

      {/* ── Template quick-start (only when non-empty) ── */}
      {strengthTemplates.length > 0 && (
        <section>
          <MonoLabel style={{ marginBottom: 10 }}>Templates</MonoLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {strengthTemplates.map((t) => (
              <HCard
                key={t.id}
                pad={12}
                hover
                onClick={surfacesBusy ? undefined : () => onStart('template', t.id)}
                ariaLabel={`Start ${t.name}`}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={tplIcon}>
                    <Dumbbell size={15} strokeWidth={1.9} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={tplName}>{t.name}</div>
                    <div style={tplMeta}>
                      {t.folder ? `${t.folder} · ` : ''}
                      {exCount(t.exerciseCount)}
                      {t.lastPerformed ? ` · ${relTime(t.lastPerformed)}` : ' · never run'}
                    </div>
                  </div>
                  {starting === 'template' && <Spinner />}
                </div>
              </HCard>
            ))}
          </div>
        </section>
      )}

      {/* ── Mobility ▶ quick-start (all-timed templates; renders nothing when empty) ── */}
      {mobilityTemplates.length > 0 && (
        <section>
          <MonoLabel style={{ marginBottom: 10 }}>Mobility</MonoLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {mobilityTemplates.map((t) => (
              <HCard
                key={t.id}
                pad={12}
                hover
                onClick={surfacesBusy ? undefined : () => void handlePlayRoutine(t.id)}
                ariaLabel={`Play ${t.name} routine`}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={playIcon}>
                    <Play size={14} strokeWidth={2} fill="currentColor" />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={tplName}>{t.name}</div>
                    <div style={tplMeta}>
                      {t.folder ? `${t.folder} · ` : ''}
                      {exCount(t.exerciseCount)}
                      {t.lastPerformed ? ` · ${relTime(t.lastPerformed)}` : ' · never run'}
                    </div>
                  </div>
                  {playingRoutineId === t.id && <Spinner />}
                </div>
              </HCard>
            ))}
          </div>
        </section>
      )}

      {/* ── Start empty (always) ── */}
      <button
        type="button"
        onClick={() => onStart('empty')}
        disabled={surfacesBusy}
        style={{ ...emptyBtn, opacity: surfacesBusy ? 0.6 : 1, cursor: surfacesBusy ? 'default' : 'pointer' }}
      >
        <Plus size={16} strokeWidth={2} />
        {starting === 'empty' ? 'Starting…' : 'Start empty workout'}
      </button>

      {/* ── Build a template (#1381) ──
          The builder has lived on the Templates tab since #1102, but Train —
          where you actually go to work out — never pointed at it, so template
          creation read as a side effect of finishing a workout. This is the
          signpost: quieter than the start affordances (it isn't "train now"),
          always present, and it opens the builder directly rather than just
          landing on the tab. */}
      <button
        type="button"
        onClick={() => router.push('/gym?tab=templates&new=1')}
        style={buildTemplateBtn}
      >
        <ClipboardList size={15} strokeWidth={1.9} />
        Build a template
      </button>

      {/* First-run / empty hint: no templates and no history yet. */}
      {!loading && !error && templates.length === 0 && !last && (
        <p style={hint}>
          No templates or past sessions yet. Build a template to reuse a workout you
          already know, or start an empty one — add exercises as you go, and save it
          as a template when you&rsquo;re done.
        </p>
      )}

      {error && <p style={hint}>Couldn&rsquo;t load your templates. You can still start an empty workout.</p>}
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────────
function exCount(n: number): string {
  return `${n} exercise${n === 1 ? '' : 's'}`
}
function mins(seconds: number): string {
  const m = Math.round(seconds / 60)
  return `${m} min`
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        width: 15,
        height: 15,
        borderRadius: '50%',
        border: '2px solid color-mix(in oklch, var(--accent) 30%, transparent)',
        borderTopColor: 'var(--accent)',
        flexShrink: 0,
        animation: 'gym-spin .7s linear infinite',
      }}
    />
  )
}

// ── styles ───────────────────────────────────────────────────────────────────
const heroBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  width: '100%',
  padding: 16,
  textAlign: 'left',
  background: 'linear-gradient(135deg, color-mix(in oklch, var(--accent) 12%, var(--bg-elevated)), var(--bg-elevated))',
  border: '1px solid color-mix(in oklch, var(--accent) 35%, var(--border-muted))',
  borderRadius: 'var(--radius)',
  fontFamily: 'inherit',
}
const heroIcon: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 40,
  height: 40,
  borderRadius: 10,
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
  flexShrink: 0,
}
const heroLabel: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 3,
}
const heroTitle: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-sans)',
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--fg)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
const heroMeta: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--fg-muted)',
  marginTop: 3,
}
const tplIcon: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 34,
  height: 34,
  borderRadius: 9,
  background: 'var(--bg-subtle)',
  color: 'var(--fg-muted)',
  border: '1px solid var(--border-muted)',
  flexShrink: 0,
}
const playIcon: React.CSSProperties = {
  ...tplIcon,
  color: 'var(--accent)',
  background: 'color-mix(in oklch, var(--accent) 12%, var(--bg-subtle))',
  border: '1px solid color-mix(in oklch, var(--accent) 30%, var(--border-muted))',
}
const tplName: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 14.5,
  color: 'var(--fg)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
const tplMeta: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-subtle)',
  marginTop: 3,
}
const emptyBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  width: '100%',
  padding: '13px 16px',
  fontFamily: 'var(--font-sans)',
  fontSize: 14.5,
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px dashed var(--border)',
  borderRadius: 12,
  fontWeight: 500,
}
/** #1381 — a manage action, not a start action: no card, no dashed border, so
 *  it never competes with "Start empty workout" directly above it. */
const buildTemplateBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  alignSelf: 'center',
  padding: '8px 14px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: 'var(--fg-muted)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
}
const hint: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--fg-subtle)',
  maxWidth: '48ch',
}
