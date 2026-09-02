'use client'

/**
 * SwapSheet (GYM_PLAN §4 replace / §6 swap sheet) — replaces the old
 * replace→AddExerciseSheet flow. Two lanes, both deterministic (NO LLM here; chat
 * may rerank):
 *
 *   1. Suggested — same-muscle alternatives from GET /api/gym/exercises/alternatives
 *      (staleness-ranked, gym-equipment-filtered, not-disliked, ranked on the source's
 *      FULL muscle profile — primary + secondary, #1876). Each row carries a
 *      freshness hint ("fresh · 6w since last") + a same-muscles chip. Picking one
 *      calls store.replaceExercise(workoutExerciseId, newId, keepPrescription).
 *   2. Search — a fallback text field with the full AddExerciseSheet catalog search
 *      (fuzzy) for a manual pick; the picked exercise also replaces via the store.
 *
 * #1876: when the slot being replaced carries a real prescribed target, picking
 * either lane doesn't commit immediately — it asks "keep this as your target?"
 * first (accept carries prescribed_* forward as the new exercise's ghost target;
 * decline starts blank, the old default). No target to carry ⇒ no prompt, commits
 * straight through as before.
 *
 * Presentational + prop-driven: the parent (ActiveExerciseCard) passes the slot's
 * workoutExerciseId + source exercise (+ its tracks/targets), and an onPick that
 * calls the store. This component owns only the fetch + the two lanes + the
 * keep-prescription confirm step.
 */
import { useEffect, useState } from 'react'
import { Repeat, Search, Sparkles, X } from 'lucide-react'

import { useDebounced, useGymExercises } from '@/lib/gym-client/fetch'
import { fetchAlternatives, type AlternativeRow } from '@/lib/gym-client/plan-client'
import type { ExerciseListItem } from '@/lib/gym-client/types'
import type { TargetSet } from '@/lib/gym-client/active-types'
import { titleCase } from '@/components/gym/exercises/format'
import { hasPrescription, prescriptionSummary } from './format'

export function SwapSheet({
  workoutExerciseId,
  sourceExerciseId,
  sourceName,
  sourceTracks,
  sourceTargets,
  onPick,
  onClose,
}: {
  /** The active-workout slot being replaced. */
  workoutExerciseId: string
  /** The exercise currently in that slot — its id seeds the alternatives + is excluded. */
  sourceExerciseId: string
  sourceName: string
  /** The slot's current tracks shape + targets — used only to decide whether to
   *  ask "keep this as your target?" (#1876) and to word the prompt. */
  sourceTracks: string
  sourceTargets: TargetSet[]
  /** Replace the slot with a new exercise (store.replaceExercise); resolves when
   *  done. `keepPrescription` carries the old target forward as the new
   *  exercise's ghost target instead of the default blank slate. `newExerciseName`
   *  is passed through only so the caller's reason-chip toast can name the pick. */
  onPick: (
    workoutExerciseId: string,
    newExerciseId: string,
    keepPrescription: boolean,
    newExerciseName: string,
  ) => void | Promise<void>
  onClose: () => void
}) {
  const [alts, setAlts] = useState<AlternativeRow[] | null>(null)
  const [altsError, setAltsError] = useState(false)
  const [regionLabel, setRegionLabel] = useState<string | null>(null)
  const [picking, setPicking] = useState<string | null>(null)
  // #1876: when the current exercise carries a real target, hold the picked
  // replacement here and ask before committing instead of silently wiping it.
  const [pendingPick, setPendingPick] = useState<{ id: string; name: string } | null>(null)

  // Search lane (manual fallback — same catalog search AddExerciseSheet uses).
  const [searching, setSearching] = useState(false)
  const [input, setInput] = useState('')
  const q = useDebounced(input.trim(), 250)
  const { data: searchData, loading: searchLoading } = useGymExercises(
    searching ? { q: q || undefined, limit: 30, offset: 0 } : { limit: 0 },
  )
  const searchRows: ExerciseListItem[] = searching ? searchData?.exercises ?? [] : []

  // Fetch deterministic alternatives on mount.
  useEffect(() => {
    let alive = true
    fetchAlternatives(sourceExerciseId, 8)
      .then((r) => {
        if (!alive) return
        setAlts(r.alternatives)
        setRegionLabel(r.regionLabel)
      })
      .catch(() => {
        if (alive) setAltsError(true)
      })
    return () => {
      alive = false
    }
  }, [sourceExerciseId])

  async function commit(newExerciseId: string, newName: string, keepPrescription: boolean) {
    setPicking(newExerciseId)
    try {
      await onPick(workoutExerciseId, newExerciseId, keepPrescription, newName)
      onClose()
    } finally {
      setPicking(null)
      setPendingPick(null)
    }
  }

  function pick(newExerciseId: string, newName: string) {
    if (newExerciseId === sourceExerciseId) {
      onClose()
      return
    }
    if (hasPrescription(sourceTargets)) {
      setPendingPick({ id: newExerciseId, name: newName })
      return
    }
    void commit(newExerciseId, newName, false)
  }

  return (
    <div role="presentation" style={scrim} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={`Replace ${sourceName}`} style={sheet} className="gym-swap-sheet">
        <style>{SWAP_CSS}</style>
        <div style={headRow}>
          <span style={{ minWidth: 0 }}>
            <span style={heading}>Replace</span>
            <span style={subHeading}>{sourceName}</span>
          </span>
          <button type="button" onClick={onClose} aria-label="Close" style={closeBtn}>
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        {pendingPick ? (
          <div role="group" aria-label={`Keep the prescribed target for ${pendingPick.name}?`} style={confirmWrap}>
            <p style={confirmPrompt}>
              Keep <span style={confirmValue}>{prescriptionSummary(sourceTracks, sourceTargets)}</span> as your
              target for <span style={confirmValue}>{pendingPick.name}</span>?
            </p>
            <div style={confirmRow}>
              <button
                type="button"
                onClick={() => void commit(pendingPick.id, pendingPick.name, true)}
                disabled={picking != null}
                style={confirmKeepBtn}
              >
                Keep as target
              </button>
              <button
                type="button"
                onClick={() => void commit(pendingPick.id, pendingPick.name, false)}
                disabled={picking != null}
                style={confirmBlankBtn}
              >
                Start blank
              </button>
            </div>
          </div>
        ) : !searching ? (
          <>
            {/* ── Suggested (deterministic) ── */}
            <div style={sectionLabel}>
              <Sparkles size={11} strokeWidth={2} />
              {regionLabel ? `Same muscles · ${regionLabel}` : 'Suggested'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto' }}>
              {alts == null && !altsError && <p style={note}>Finding alternatives…</p>}
              {altsError && <p style={note}>Couldn&rsquo;t load suggestions — search instead.</p>}
              {alts != null && alts.length === 0 && !altsError && (
                <p style={note}>No same-muscle alternatives in your gym — search instead.</p>
              )}
              {(alts ?? []).map((a) => (
                <button
                  key={a.exerciseId}
                  type="button"
                  onClick={() => pick(a.exerciseId, a.name)}
                  disabled={picking != null}
                  aria-label={`Replace with ${a.name}`}
                  style={resultRow}
                >
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, textAlign: 'left' }}>
                    <span style={resultName}>{a.name}</span>
                    <span style={metaLine}>
                      <span style={freshChip}>{a.freshness}</span>
                      <span style={muscleChip}>{a.regionLabel}</span>
                    </span>
                  </span>
                  <Repeat size={15} strokeWidth={2} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                </button>
              ))}
            </div>

            {/* Fall back to manual search. */}
            <button type="button" onClick={() => setSearching(true)} style={searchToggle}>
              <Search size={13} strokeWidth={1.9} /> Search all exercises instead
            </button>
          </>
        ) : (
          <>
            {/* ── Manual search lane ── */}
            <div style={{ position: 'relative', marginBottom: 10 }}>
              <Search
                size={15}
                strokeWidth={1.8}
                style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-subtle)', pointerEvents: 'none' }}
              />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Search exercises…"
                aria-label="Search exercises to replace with"
                autoFocus
                style={searchInput}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto' }}>
              {searchLoading && searchRows.length === 0 && <p style={note}>Searching…</p>}
              {!searchLoading && searchRows.length === 0 && (
                <p style={note}>No matches. Create it in the Exercises tab.</p>
              )}
              {searchRows.map((ex) => (
                <button
                  key={ex.id}
                  type="button"
                  onClick={() => pick(ex.id, ex.name)}
                  disabled={picking != null}
                  aria-label={`Replace with ${ex.name}`}
                  style={resultRow}
                >
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, textAlign: 'left' }}>
                    <span style={resultName}>{ex.name}</span>
                    {(ex.primaryMuscle || ex.equipment) && (
                      <span style={resultMeta}>
                        {[ex.primaryMuscle && titleCase(ex.primaryMuscle), ex.equipment && titleCase(ex.equipment)]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                  </span>
                  <Repeat size={15} strokeWidth={2} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setSearching(false)} style={searchToggle}>
              <Sparkles size={13} strokeWidth={1.9} /> Back to suggestions
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const SWAP_CSS = `
.gym-swap-sheet { animation: gym-swap-up .2s cubic-bezier(.16,1,.3,1); }
@keyframes gym-swap-up { from { transform: translateY(28px); opacity: .6; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .gym-swap-sheet { animation: none; } }
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
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '16px 16px 0 0',
  boxShadow: '0 -12px 40px rgba(0,0,0,.34)',
  padding: '16px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
}
const headRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 10,
  marginBottom: 12,
}
const heading: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const subHeading: React.CSSProperties = {
  display: 'block',
  marginTop: 2,
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 18,
  color: 'var(--fg)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const confirmWrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '8px 2px 4px',
}
const confirmPrompt: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  lineHeight: 1.5,
  color: 'var(--fg-muted)',
}
const confirmValue: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  color: 'var(--fg)',
}
const confirmRow: React.CSSProperties = {
  display: 'flex',
  gap: 8,
}
const confirmKeepBtn: React.CSSProperties = {
  flex: 1,
  padding: '11px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  letterSpacing: '0.03em',
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  border: 'none',
  borderRadius: 9,
  cursor: 'pointer',
}
const confirmBlankBtn: React.CSSProperties = {
  flex: 1,
  padding: '11px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  letterSpacing: '0.03em',
  color: 'var(--fg-muted)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 9,
  cursor: 'pointer',
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
const sectionLabel: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  marginBottom: 8,
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
}
const searchInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '11px 12px 11px 34px',
  fontSize: 15,
  fontFamily: 'var(--font-sans)',
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
  outline: 'none',
}
const resultRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '11px 12px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
  cursor: 'pointer',
}
const resultName: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 14.5,
  color: 'var(--fg)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const metaLine: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const resultMeta: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.03em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const freshChip: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  color: 'var(--accent)',
  background: 'color-mix(in oklch, var(--accent) 12%, transparent)',
  border: '1px solid color-mix(in oklch, var(--accent) 30%, transparent)',
  borderRadius: 5,
  padding: '1px 6px',
}
const muscleChip: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-muted)',
  borderRadius: 5,
  padding: '1px 6px',
}
const searchToggle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 12,
  padding: '9px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.03em',
  color: 'var(--fg-muted)',
  background: 'transparent',
  border: '1px dashed var(--border-muted)',
  borderRadius: 9,
  cursor: 'pointer',
  justifyContent: 'center',
}
const note: React.CSSProperties = {
  margin: '12px 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13,
  color: 'var(--fg-subtle)',
  textAlign: 'center',
}
