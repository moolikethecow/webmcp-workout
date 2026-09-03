'use client'

/**
 * TuneSheet (GYM_PLAN §2.7 "Tune for today ✦") — applies coach adjustments to a
 * template-started workout IN PLACE. Opened from the ActiveWorkoutView banner when
 * the live workout came from a template and hasn't been tuned yet.
 *
 * Flow:
 *   1. POST { mode: 'tune', templateId } → a proposal (deterministic, instant).
 *   2. Diff the proposal vs the current workout BY exerciseId (computeTuneDiff):
 *      kept / added / removed rows, shown diff-style with the added rows' `why`.
 *   3. [Apply] runs the store's remove then add ops to reshape the ACTIVE workout;
 *      [Keep as-is] dismisses without touching anything.
 *
 * The apply logic is deliberately simple (add/remove by exerciseId — see
 * lib/gym-client/tune-diff.ts). Presentational + callback-driven: the parent passes
 * the current exercises + the store ops; this owns the fetch, the diff, and the UI.
 */
import { useEffect, useState } from 'react'
import { ArrowRight, Check, Minus, Plus, Sparkles, X } from 'lucide-react'

import { tunePlan } from '@/lib/gym-client/plan-client'
import {
  computeTuneDiff,
  tuneDiffHasChanges,
  type CurrentExercise,
  type TuneDiff,
} from '@/lib/gym-client/tune-diff'

export function TuneSheet({
  templateId,
  current,
  onAddExercise,
  onRemoveExercise,
  onApplied,
  onClose,
}: {
  templateId: string
  /** The live workout's current exercises (for the diff). */
  current: CurrentExercise[]
  onAddExercise: (exerciseId: string) => Promise<void>
  onRemoveExercise: (workoutExerciseId: string) => Promise<void>
  /** Called after a successful apply (parent marks the workout tuned). */
  onApplied: () => void
  onClose: () => void
}) {
  const [phase, setPhase] = useState<'loading' | 'review' | 'applying' | 'error'>('loading')
  const [diff, setDiff] = useState<TuneDiff | null>(null)

  // Fetch + diff on mount.
  useEffect(() => {
    let alive = true
    tunePlan(templateId)
      .then((proposal) => {
        if (!alive) return
        setDiff(computeTuneDiff(proposal.payload, current))
        setPhase('review')
      })
      .catch(() => {
        if (alive) setPhase('error')
      })
    // current is a snapshot at open; re-diffing mid-review isn't wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId])

  async function apply() {
    if (!diff) return
    setPhase('applying')
    try {
      // Removes first (frees the slots), then adds — the simple ordering (§ tune-diff).
      for (const r of diff.removed) await onRemoveExercise(r.workoutExerciseId)
      for (const a of diff.added) await onAddExercise(a.exerciseId)
      onApplied()
      onClose()
    } catch {
      setPhase('review')
      const { toast } = await import('sonner')
      toast.error("Couldn't apply the tune — try again.")
    }
  }

  const hasChanges = diff != null && tuneDiffHasChanges(diff)

  return (
    <div role="presentation" style={scrim} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Tune for today" style={sheet} className="gym-tune-sheet">
        <style>{TUNE_CSS}</style>
        <div style={headRow}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Sparkles size={14} strokeWidth={2} style={{ color: 'var(--accent)' }} />
            <span style={heading}>Tune for today</span>
          </span>
          <button type="button" onClick={onClose} aria-label="Close" style={closeBtn}>
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        {phase === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-busy>
            <p style={note}>
              <Spinner /> Tuning today&rsquo;s session&hellip;
            </p>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ ...skelRow, opacity: 1 - i * 0.2 }} aria-hidden />
            ))}
          </div>
        )}

        {phase === 'error' && (
          <>
            <p style={note}>Couldn&rsquo;t tune the workout right now.</p>
            <div style={actionRow}>
              <button type="button" onClick={onClose} style={secondaryBtn}>
                Keep as-is
              </button>
            </div>
          </>
        )}

        {(phase === 'review' || phase === 'applying') && diff && (
          <>
            {!hasChanges ? (
              <p style={note}>
                Today&rsquo;s tune matches your template — nothing to change. You&rsquo;re
                good to go.
              </p>
            ) : (
              <div style={diffList}>
                {diff.removed.map((r) => (
                  <DiffRow key={`rm-${r.exerciseId}`} kind="removed" name={r.name} />
                ))}
                {diff.added.map((a) => (
                  <DiffRow key={`add-${a.exerciseId}`} kind="added" name={a.name} why={a.why} />
                ))}
                {diff.kept.map((k) => (
                  <DiffRow key={`keep-${k.exerciseId}`} kind="kept" name={k.name} />
                ))}
              </div>
            )}

            <div style={actionRow}>
              <button type="button" onClick={onClose} disabled={phase === 'applying'} style={secondaryBtn}>
                Keep as-is
              </button>
              {hasChanges && (
                <button
                  type="button"
                  onClick={() => void apply()}
                  disabled={phase === 'applying'}
                  style={{ ...primaryBtn, opacity: phase === 'applying' ? 0.6 : 1 }}
                >
                  {phase === 'applying' ? <Spinner /> : <Check size={15} strokeWidth={2.2} />}
                  {phase === 'applying' ? 'Applying…' : 'Apply'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── one diff row ──────────────────────────────────────────────────────────────
function DiffRow({
  kind,
  name,
  why,
}: {
  kind: 'added' | 'removed' | 'kept'
  name: string
  why?: string
}) {
  const meta =
    kind === 'added'
      ? { icon: <Plus size={13} strokeWidth={2.4} />, label: 'Add', color: 'var(--accent)' }
      : kind === 'removed'
        ? { icon: <Minus size={13} strokeWidth={2.4} />, label: 'Drop', color: 'var(--danger)' }
        : { icon: <ArrowRight size={13} strokeWidth={2} />, label: 'Keep', color: 'var(--fg-subtle)' }
  return (
    <div style={{ ...row, opacity: kind === 'kept' ? 0.72 : 1 }}>
      <span style={{ ...tag, color: meta.color, borderColor: meta.color }}>
        {meta.icon} {meta.label}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span
          style={{
            ...rowName,
            textDecoration: kind === 'removed' ? 'line-through' : 'none',
          }}
        >
          {name}
        </span>
        {why && kind === 'added' && <span style={rowWhy}>{why}</span>}
      </span>
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
        animation: 'gym-tune-spin .7s linear infinite',
        verticalAlign: 'middle',
        marginRight: 6,
      }}
    />
  )
}

// ── styles ────────────────────────────────────────────────────────────────────
const TUNE_CSS = `
.gym-tune-sheet { animation: gym-tune-up .2s cubic-bezier(.16,1,.3,1); }
@keyframes gym-tune-up { from { transform: translateY(28px); opacity: .6; } to { transform: none; opacity: 1; } }
@keyframes gym-tune-spin { to { transform: rotate(360deg); } }
@keyframes gym-tune-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) {
  .gym-tune-sheet { animation: none; }
  [style*="gym-tune-spin"], [style*="gym-tune-shimmer"] { animation: none !important; }
}
`
const scrim: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 70,
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  background: 'color-mix(in oklch, var(--bg) 45%, transparent)',
  backdropFilter: 'blur(2px)',
}
const sheet: React.CSSProperties = {
  width: '100%',
  maxWidth: 520,
  maxHeight: '78vh',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '16px 16px 0 0',
  boxShadow: '0 -12px 40px rgba(0,0,0,.34)',
  padding: '16px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
}
const headRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  marginBottom: 12,
}
const heading: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 18,
  color: 'var(--fg)',
}
const closeBtn: React.CSSProperties = {
  flexShrink: 0,
  width: 30,
  height: 30,
  borderRadius: 8,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-elevated)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const diffList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '10px 11px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
}
const tag: React.CSSProperties = {
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  padding: '2px 7px',
  borderRadius: 6,
  border: '1px solid',
  background: 'transparent',
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  marginTop: 1,
}
const rowName: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-sans)',
  fontSize: 14.5,
  color: 'var(--fg)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const rowWhy: React.CSSProperties = {
  display: 'block',
  marginTop: 3,
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 12,
  color: 'var(--fg-subtle)',
  lineHeight: 1.4,
}
const actionRow: React.CSSProperties = { display: 'flex', gap: 8, marginTop: 16 }
const primaryBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  flex: 1,
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
  flex: 1,
  padding: '12px 16px',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 11,
  cursor: 'pointer',
}
const note: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  margin: '4px 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13.5,
  lineHeight: 1.5,
  color: 'var(--fg-muted)',
}
const skelRow: React.CSSProperties = {
  height: 42,
  borderRadius: 10,
  background:
    'linear-gradient(90deg, var(--bg-subtle) 0%, color-mix(in oklch, var(--bg-subtle) 60%, var(--border-muted)) 50%, var(--bg-subtle) 100%)',
  backgroundSize: '200% 100%',
  animation: 'gym-tune-shimmer 1.3s ease-in-out infinite',
}
