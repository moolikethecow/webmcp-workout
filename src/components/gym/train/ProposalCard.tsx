'use client'

/**
 * ProposalCard — the drafted workout rendered as
 * an editable artifact on the Train tab. Shows above Repeat-last when a proposal
 * exists (GET on mount) OR after the user drafts one.
 *
 * Anatomy:
 *   - name + a ✦ "Today's pick" mark
 *   - collapsible rationale (the ≤2-sentence why)
 *   - exercise rows: name · sets×reps · target weight (when present) · a subtle
 *     `why` sub-line · a muscle chip
 *   - a stale banner when proposal.stale ("things changed — refresh?")
 *   - actions: [Start] · [Dismiss]
 *
 * "Draft one for me" (when NO proposal): an optional one-line focus input →
 * draftPlan(focus). The deal takes a moment, so drafting shows an honest
 * skeleton + "Drafting…".
 *
 * This component is presentational + callback-driven — the parent (StartSurfaces)
 * owns the plan-client calls, the store hydration on Start, and error toasts.
 */
import { useState } from 'react'
import { ChevronDown, MessageSquare, RefreshCw, Sparkles, X } from 'lucide-react'

import { REGION_LABELS, type MuscleRegion } from '@/lib/fitness/muscles'
import type { Proposal, ProposalExercise } from '@/lib/gym-client/plan-client'
import { normalizeGeneratedWorkoutName } from '@/lib/gym/display-name'
import {
  normalizeProposalExerciseNames,
  resolveProposalSetPrescriptions,
  type ProposalSetPrescription,
} from '@/lib/gym/proposal-payload'
import { convertWeight, type WeightUnit } from '@/lib/units/weight'

export interface ProposalCardProps {
  /** The current proposal, or null when none exists (renders the draft surface). */
  proposal: Proposal | null
  /** A generate/action is in flight — which one drives the skeleton + disabled state. */
  busy: null | 'draft' | 'start' | 'dismiss' | 'refresh'
  onDraft: (focus: string) => void
  onStart: () => void
  onDismiss: () => void
  /** Re-run the generate for a stale proposal (draft-from-scratch refresh). */
  onRefresh: () => void
}

export function ProposalCard({
  proposal,
  busy,
  onDraft,
  onStart,
  onDismiss,
  onRefresh,
}: ProposalCardProps) {
  const [focus, setFocus] = useState('')
  const [rationaleOpen, setRationaleOpen] = useState(false)

  const drafting = busy === 'draft'
  const anyBusy = busy != null

  // ── No proposal: the "Draft one for me" surface ──
  if (!proposal) {
    return (
      <section style={draftShell} aria-label="Draft a workout">
        <ProposalKeyframes />
        <div style={draftHead}>
          <span style={pickMark}>
            <Sparkles size={13} strokeWidth={2} /> Today&rsquo;s pick
          </span>
        </div>
        {drafting ? (
          <DraftSkeleton />
        ) : (
          <>
            <p style={draftHint}>
              Want a workout dealt for today? It reads your recovery, goals,
              constraints and gym — and lands an editable draft.
            </p>
            <input
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="Optional: push day, legs but easy on knees…"
              aria-label="Optional focus for the draft"
              style={focusInput}
              disabled={anyBusy}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !anyBusy) onDraft(focus.trim())
              }}
            />
            <button
              type="button"
              onClick={() => onDraft(focus.trim())}
              disabled={anyBusy}
              style={{ ...primaryBtn, opacity: anyBusy ? 0.6 : 1 }}
            >
              <Sparkles size={15} strokeWidth={2} /> Draft one for me
            </button>
          </>
        )}
      </section>
    )
  }

  // ── A proposal exists ──
  const { payload, rationale, stale } = proposal
  const displayPayload = normalizeProposalExerciseNames(payload)
  const displayName = normalizeGeneratedWorkoutName(payload.name)
  return (
    <section style={cardShell} aria-label={`Proposed workout: ${displayName}`}>
      <ProposalKeyframes />
      {/* Header */}
      <div style={cardHead}>
        <div style={{ minWidth: 0 }}>
          <span style={pickMark}>
            <Sparkles size={13} strokeWidth={2} /> Today&rsquo;s pick
          </span>
          <h3 style={cardTitle}>{displayName}</h3>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          disabled={anyBusy}
          aria-label="Dismiss proposal"
          style={dismissX}
        >
          {busy === 'dismiss' ? <Spinner /> : <X size={16} strokeWidth={1.9} />}
        </button>
      </div>

      {/* Stale banner */}
      {stale && (
        <div style={staleBanner} role="status">
          <span style={{ flex: 1, minWidth: 0 }}>
            Things changed since this was drafted — refresh it?
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={anyBusy}
            style={refreshBtn}
            aria-label="Refresh proposal"
          >
            {busy === 'refresh' ? <Spinner /> : <RefreshCw size={13} strokeWidth={2} />}
            Refresh
          </button>
        </div>
      )}

      {/* Rationale (collapsible) */}
      {rationale && rationale.trim() && (
        <button
          type="button"
          onClick={() => setRationaleOpen((v) => !v)}
          aria-expanded={rationaleOpen}
          style={rationaleToggle}
        >
          <ChevronDown
            size={13}
            strokeWidth={2}
            style={{ transform: rationaleOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
          />
          {rationaleOpen ? 'Hide reasoning' : "Why this workout"}
        </button>
      )}
      {rationaleOpen && rationale && <p style={rationaleText}>{rationale}</p>}

      {/* Exercise rows */}
      <ul style={rowList}>
        {displayPayload.exercises.map((ex, i) => (
          <ExerciseRow key={`${ex.exerciseId}-${i}`} ex={ex} weightUnit={proposal.weightUnit ?? 'lb'} />
        ))}
      </ul>

      {/* Actions */}
      <div style={actionRow}>
        <button
          type="button"
          onClick={onStart}
          disabled={anyBusy}
          style={{ ...primaryBtn, flex: 2, opacity: anyBusy ? 0.6 : 1 }}
        >
          {busy === 'start' ? <Spinner /> : null}
          {busy === 'start' ? 'Starting…' : 'Start'}
        </button>
      </div>
    </section>
  )
}

// ── one exercise row ──────────────────────────────────────────────────────────
function ExerciseRow({ ex, weightUnit }: { ex: ProposalExercise; weightUnit: WeightUnit }) {
  const scheme = setsRepsLabel(ex, weightUnit)
  const chip = ex.region ? regionLabel(ex.region) : null
  const isWarmup = ex.section === 'warmup'
  const rest = restLabel(ex.restSeconds)
  const exactSets = ex.setPrescriptions?.length
    ? resolveProposalSetPrescriptions(ex)
    : null
  const warmupSets = exactSets?.filter((set) => set.setType === 'warmup') ?? []
  const workingSets = exactSets?.filter((set) => set.setType !== 'warmup') ?? []
  return (
    <li style={row}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={rowTop}>
          {isWarmup && <span style={warmupBadge}>Warm-up</span>}
          <span style={rowName}>{ex.name}</span>
          {chip && <span style={muscleChip}>{chip}</span>}
        </div>
        {ex.why && ex.why.trim() && <div style={rowWhy}>{ex.why}</div>}
      </div>
      <span style={rowSchemeCol}>
        {exactSets ? (
          <>
            {warmupSets.length > 0 && (
              <span style={exactSetGroup}>
                Warm-up sets ({warmupSets.length}): {setGroupLabel(warmupSets, weightUnit)}
              </span>
            )}
            {workingSets.length > 0 && (
              <span style={exactSetGroup}>
                Working sets ({workingSets.length}): {setGroupLabel(workingSets, weightUnit)}
              </span>
            )}
          </>
        ) : (
          <>
            <span style={rowScheme}>{scheme}</span>
            {rest && <span style={rowRest}>{rest} rest</span>}
          </>
        )}
      </span>
    </li>
  )
}

function setGroupLabel(sets: ProposalSetPrescription[], weightUnit: WeightUnit): string {
  return sets.map((set) => setPrescriptionLabel(set, weightUnit)).join(' / ')
}

function setPrescriptionLabel(set: ProposalSetPrescription, weightUnit: WeightUnit): string {
  const targets: string[] = []
  if (set.targetWeight != null) {
    const displayed = convertWeight(set.targetWeight, 'lb', weightUnit, 1) ?? set.targetWeight
    targets.push(`${trimWeight(displayed)} ${weightUnit}`)
  }
  if (set.reps != null) targets.push(`${set.reps} reps`)
  if (set.targetDurationS != null) targets.push(`${set.targetDurationS}s`)
  if (set.targetRpe != null) targets.push(`RPE ${set.targetRpe}`)
  if (set.side) targets.push(set.side)
  if (set.restSeconds != null) targets.push(`${restLabel(set.restSeconds) ?? '0s'} rest`)
  if (set.setType === 'drop') targets.unshift('Drop')
  if (set.setType === 'failure') targets.unshift('Failure')
  return targets.join(' · ') || 'Unweighted'
}

/** "90s" / "2m" / "1m 30s" from a rest-seconds value; null when absent/zero. */
function restLabel(restSeconds: number | null | undefined): string | null {
  if (restSeconds == null || restSeconds <= 0) return null
  if (restSeconds < 60) return `${restSeconds}s`
  const m = Math.floor(restSeconds / 60)
  const s = restSeconds % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

/** "4 × 8 reps · 170 lb" / "3 × 10 reps" / "3 × 30s" (timed, no reps) / "4 sets"
 * (neither). Explicit "reps"/"s" units so a bare number never reads as
 * ambiguous between reps, seconds, or rounds (#1879) — the ambiguity only a
 * trailing weight used to resolve, which timed/bodyweight rows don't have.
 * Target weights are canonical lb in the proposal and converted only for this
 * display string. */
export function setsRepsLabel(
  ex: Pick<ProposalExercise, 'sets' | 'reps' | 'targetWeight' | 'targetDurationS'>,
  weightUnit: WeightUnit = 'lb',
): string {
  const sr =
    ex.reps != null
      ? `${ex.sets} × ${ex.reps} reps`
      : ex.targetDurationS != null
        ? `${ex.sets} × ${ex.targetDurationS}s`
        : `${ex.sets} set${ex.sets === 1 ? '' : 's'}`
  if (ex.targetWeight != null && ex.targetWeight > 0) {
    const displayed = convertWeight(ex.targetWeight, 'lb', weightUnit, 1) ?? ex.targetWeight
    return `${sr} · ${trimWeight(displayed)} ${weightUnit}`
  }
  return sr
}

function trimWeight(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10)
}

function regionLabel(region: MuscleRegion): string {
  return REGION_LABELS[region] ?? region
}

// ── skeleton + spinner ────────────────────────────────────────────────────────
function DraftSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-live="polite" aria-busy>
      <p style={draftingNote}>
        <Spinner /> Drafting&hellip;
      </p>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} style={{ ...skelRow, opacity: 1 - i * 0.15 }} aria-hidden />
      ))}
    </div>
  )
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 14,
        height: 14,
        borderRadius: '50%',
        border: '2px solid color-mix(in oklch, var(--accent) 30%, transparent)',
        borderTopColor: 'var(--accent)',
        animation: 'gym-spin .7s linear infinite',
        verticalAlign: 'middle',
        marginRight: 6,
      }}
    />
  )
}

/** Self-contained keyframes so the card animates regardless of global CSS. */
function ProposalKeyframes() {
  return (
    <style>{`
@keyframes gym-spin { to { transform: rotate(360deg); } }
@keyframes gym-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) {
  [style*="gym-spin"], [style*="gym-shimmer"] { animation: none !important; }
}
`}</style>
  )
}

// ── styles ────────────────────────────────────────────────────────────────────
const cardShell: React.CSSProperties = {
  padding: 16,
  borderRadius: 'var(--radius, 14px)',
  background: 'linear-gradient(150deg, color-mix(in oklch, var(--accent) 9%, var(--bg-elevated)), var(--bg-elevated))',
  border: '1px solid color-mix(in oklch, var(--accent) 32%, var(--border-muted))',
}
const draftShell: React.CSSProperties = {
  padding: 16,
  borderRadius: 'var(--radius, 14px)',
  background: 'var(--bg-elevated)',
  border: '1px dashed color-mix(in oklch, var(--accent) 36%, var(--border-muted))',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}
const cardHead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 10,
}
const draftHead: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }
const pickMark: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
}
const cardTitle: React.CSSProperties = {
  margin: '4px 0 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontWeight: 400,
  fontSize: 20,
  letterSpacing: '-0.01em',
  color: 'var(--fg)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const dismissX: React.CSSProperties = {
  flexShrink: 0,
  width: 32,
  height: 32,
  borderRadius: 9,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const staleBanner: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginTop: 12,
  padding: '9px 11px',
  borderRadius: 9,
  background: 'color-mix(in oklch, var(--warning, #d97706) 14%, transparent)',
  border: '1px solid color-mix(in oklch, var(--warning, #d97706) 40%, transparent)',
  fontFamily: 'var(--font-sans)',
  fontSize: 12.5,
  color: 'var(--fg)',
}
const refreshBtn: React.CSSProperties = {
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '6px 10px',
  borderRadius: 7,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-elevated)',
  color: 'var(--fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  cursor: 'pointer',
}
const rationaleToggle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  marginTop: 12,
  padding: 0,
  background: 'none',
  border: 'none',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  letterSpacing: '0.03em',
  cursor: 'pointer',
}
const rationaleText: React.CSSProperties = {
  margin: '6px 0 0',
  fontFamily: 'var(--font-serif)',
  fontSize: 13.5,
  lineHeight: 1.5,
  color: 'var(--fg-muted)',
}
const rowList: React.CSSProperties = {
  listStyle: 'none',
  margin: '12px 0 0',
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}
const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 10,
  padding: '9px 0',
  borderTop: '1px solid var(--border-muted)',
}
const rowTop: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
const rowName: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 14.5,
  fontWeight: 500,
  color: 'var(--fg)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const rowWhy: React.CSSProperties = {
  marginTop: 2,
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 12,
  color: 'var(--fg-subtle)',
  lineHeight: 1.4,
}
const rowSchemeCol: React.CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 2,
  paddingTop: 1,
  maxWidth: '58%',
}
const rowScheme: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--fg-muted)',
  fontVariantNumeric: 'tabular-nums',
}
const rowRest: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.03em',
  color: 'var(--fg-subtle)',
  fontVariantNumeric: 'tabular-nums',
}
const exactSetGroup: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  lineHeight: 1.45,
  color: 'var(--fg-muted)',
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}
const warmupBadge: React.CSSProperties = {
  flexShrink: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  background: 'color-mix(in oklch, var(--accent) 12%, transparent)',
  border: '1px solid color-mix(in oklch, var(--accent) 30%, var(--border-muted))',
  borderRadius: 5,
  padding: '1px 6px',
}
const muscleChip: React.CSSProperties = {
  flexShrink: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-muted)',
  borderRadius: 5,
  padding: '1px 6px',
}
const actionRow: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }
const primaryBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  padding: '12px 16px',
  fontFamily: 'var(--font-sans)',
  fontSize: 14.5,
  fontWeight: 600,
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  border: 'none',
  borderRadius: 11,
  cursor: 'pointer',
}
const secondaryBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  flex: 1,
  padding: '12px 14px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13.5,
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 11,
  cursor: 'pointer',
}
const draftHint: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontSize: 13.5,
  lineHeight: 1.5,
  color: 'var(--fg-muted)',
  maxWidth: '46ch',
}
const focusInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '11px 12px',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--fg)',
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
  outline: 'none',
}
const draftingNote: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13.5,
  color: 'var(--fg-muted)',
}
const skelRow: React.CSSProperties = {
  height: 34,
  borderRadius: 8,
  background:
    'linear-gradient(90deg, var(--bg-subtle) 0%, color-mix(in oklch, var(--bg-subtle) 60%, var(--border-muted)) 50%, var(--bg-subtle) 100%)',
  backgroundSize: '200% 100%',
  animation: 'gym-shimmer 1.3s ease-in-out infinite',
}
