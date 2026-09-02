'use client'

/**
 * SessionDetailSheet (GYM_PLAN §4 "Tab: History" session detail). A bottom sheet
 * (mobile) / right panel (≥ md) — same scrim + slide pattern as the Exercises
 * ExerciseDetailSheet. Shows one completed session's full log:
 *   - header: name/date, duration · volume · sets · exercises
 *   - per-muscle chips (primary movers touched)
 *   - full set log grouped by exercise (warmups dimmed + tagged, set-type tags,
 *     superset A/B color band) — imports (304 legacy) render clean with no notes
 *   - notes (session + per-exercise)
 *   - actions: Repeat (→ POST workouts {from:'workout'} → navigate ?tab=train) +
 *     Save as template (→ POST /api/gym/templates {fromWorkoutId, name})
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Copy, Repeat2, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'

import { titleCase } from '@/components/gym/exercises/format'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { formatDistance, formatPace, paceBasisForDistanceUnit, type DistanceUnit } from '@/lib/units/system'
import { normalizeGeneratedWorkoutName } from '@/lib/gym/display-name'
import {
  repeatWorkout,
  deleteSession,
  saveWorkoutAsTemplate,
  updateSetRest,
  useSessionDetail,
  type SessionDetailExercise,
  type SessionDetailSet,
} from './history-client'
import { duration, longDay, mmss, setValue, volume } from './format'
import { isAmbiguousBareRest } from '@/lib/gym-client/rest-timer'

const SET_TAG: Record<string, { short: string; color: string } | null> = {
  normal: null,
  warmup: { short: 'W', color: 'var(--fg-subtle)' },
  drop: { short: 'D', color: 'var(--warning)' },
  failure: { short: 'F', color: 'var(--danger)' },
}

/** Stable superset colors, keyed by group order-of-appearance. */
const SUPERSET_COLORS = ['var(--accent)', 'var(--success, var(--accent))', 'var(--warning)']

export function SessionDetailSheet({
  id,
  onClose,
  onDeleted,
}: {
  id: string
  onClose: () => void
  onDeleted: () => void
}) {
  const { data, loading, error } = useSessionDetail(id)
  const router = useRouter()
  const [busy, setBusy] = useState<'repeat' | 'save' | null>(null)
  const [savePrompt, setSavePrompt] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Local optimistic overrides for per-set rest edits, keyed by set id.
  const [restEdits, setRestEdits] = useState<Record<string, number | null>>({})

  const saveRest = useCallback(
    async (setId: string, seconds: number | null) => {
      const prevHad = Object.prototype.hasOwnProperty.call(restEdits, setId)
      const prev = restEdits[setId]
      setRestEdits((m) => ({ ...m, [setId]: seconds }))
      try {
        await updateSetRest(id, setId, seconds)
      } catch {
        // Revert the optimistic value on failure.
        setRestEdits((m) => {
          const next = { ...m }
          if (prevHad) next[setId] = prev ?? null
          else delete next[setId]
          return next
        })
        toast.error("Couldn't save that rest time.")
      }
    },
    [id, restEdits],
  )

  // Escape closes only the topmost layer. ConfirmModal owns Escape while the
  // destructive confirmation is open; a second Escape can then close detail.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmDelete) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmDelete, onClose])

  // Seed the save-name from the session name when the prompt opens.
  useEffect(() => {
    if (savePrompt && data) setSaveName(normalizeGeneratedWorkoutName(data.name ?? 'New Template'))
  }, [savePrompt, data])

  // Distinct primary muscles touched, for the chip row.
  const muscles = useMemo(() => {
    if (!data) return []
    const seen = new Set<string>()
    for (const ex of data.exercises) {
      if (ex.primaryMuscle) seen.add(ex.primaryMuscle)
    }
    return [...seen]
  }, [data])

  // Superset group → color (by order of first appearance).
  const groupColor = useMemo(() => {
    const map = new Map<number, string>()
    if (!data) return map
    let i = 0
    for (const ex of data.exercises) {
      if (ex.supersetGroup != null && !map.has(ex.supersetGroup)) {
        map.set(ex.supersetGroup, SUPERSET_COLORS[i % SUPERSET_COLORS.length]!)
        i++
      }
    }
    return map
  }, [data])

  async function handleRepeat() {
    if (busy) return
    setBusy('repeat')
    try {
      const { conflict } = await repeatWorkout(id)
      if (conflict) {
        toast.error('Finish or discard your active workout first.')
        return
      }
      toast.success('Started — copied this session.')
      router.replace('/gym?tab=train')
    } catch {
      toast.error("Couldn't start that workout.")
    } finally {
      setBusy(null)
    }
  }

  async function handleSave() {
    const name = saveName.trim()
    if (!name || busy) return
    setBusy('save')
    try {
      await saveWorkoutAsTemplate(id, name)
      toast.success(`Saved "${name}" as a template.`)
      setSavePrompt(false)
    } catch {
      toast.error("Couldn't save that template.")
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete() {
    if (deleting) return
    setDeleting(true)
    try {
      const result = await deleteSession(id)
      toast.success(
        result.habitCompletionRemoved
          ? 'Session deleted. Linked habit completion removed too.'
          : 'Session deleted.',
      )
      onDeleted()
    } catch {
      toast.error("Couldn't delete that session.")
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  return (
    <div role="presentation" style={scrim} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <style>{SHEET_CSS}</style>
      <aside className="gym-hsheet" role="dialog" aria-label={data ? normalizeGeneratedWorkoutName(data.name ?? 'Workout') : 'Session detail'}>
        <button type="button" onClick={onClose} aria-label="Close" style={closeBtn}>
          <X size={15} strokeWidth={1.8} />
        </button>

        {error && !data && <p style={note}>Couldn&rsquo;t load this session.</p>}
        {!data && loading && <p style={note}>Loading…</p>}

        {data && (
          <>
            {/* Header */}
            <h2 style={title}>{normalizeGeneratedWorkoutName(data.name ?? 'Workout')}</h2>
            <div style={dateLine}>{longDay(data.date)}</div>

            <div style={statRow}>
              <Stat label="Duration" value={duration(data.durationSeconds)} />
              <Stat label="Volume" value={volume(data.volume ?? data.volumeLb, data.weightUnit)} />
              <Stat label="Sets" value={String(data.setCount)} />
              <Stat label="Exercises" value={String(data.exerciseCount)} />
            </div>

            {/* Muscle chips */}
            {muscles.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
                {muscles.map((m) => (
                  <span key={m} style={chip}>
                    {titleCase(m)}
                  </span>
                ))}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 18 }}>
              <ActionBtn onClick={handleRepeat} disabled={busy != null} primary>
                <Repeat2 size={14} strokeWidth={2} /> {busy === 'repeat' ? 'Starting…' : 'Repeat'}
              </ActionBtn>
              <ActionBtn onClick={() => setSavePrompt((v) => !v)} disabled={busy != null}>
                <Copy size={14} strokeWidth={2} /> Save as template
              </ActionBtn>
              <ActionBtn onClick={() => setConfirmDelete(true)} disabled={busy != null} danger>
                <Trash2 size={14} strokeWidth={2} /> Delete session
              </ActionBtn>
            </div>

            {savePrompt && (
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <input
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder="Template name"
                  aria-label="Template name"
                  style={saveInput}
                  onKeyDown={(e) => e.key === 'Enter' && void handleSave()}
                />
                <button type="button" onClick={handleSave} disabled={busy != null || !saveName.trim()} style={miniSave}>
                  {busy === 'save' ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}

            {/* Session notes */}
            {data.notes && <p style={sessionNotes}>{data.notes}</p>}

            {/* Set log */}
            <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {data.exercises.map((ex) => (
                <ExerciseBlock
                  key={ex.workoutExerciseId}
                  ex={ex}
                  bandColor={ex.supersetGroup != null ? groupColor.get(ex.supersetGroup) ?? null : null}
                  distanceUnit={data.distanceUnit ?? 'm'}
                  restEdits={restEdits}
                  onSaveRest={saveRest}
                />
              ))}
            </div>
          </>
        )}
      </aside>
      {confirmDelete && (
        <ConfirmModal
          title="Delete this session?"
          description="This permanently deletes the workout and its sets. If it created a linked habit completion, that completion is removed too. This can't be undone."
          confirmLabel="Delete session"
          loading={deleting}
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}

// ── one exercise's set list ─────────────────────────────────────────────────
function ExerciseBlock({
  ex,
  bandColor,
  distanceUnit,
  restEdits,
  onSaveRest,
}: {
  ex: SessionDetailExercise
  bandColor: string | null
  distanceUnit: DistanceUnit
  restEdits: Record<string, number | null>
  onSaveRest: (setId: string, seconds: number | null) => void
}) {
  // A duration is its own value for timed holds, so no rest line there.
  const showsRest = ex.tracks !== 'time'
  const logicalNumbers = new Map<string, number>()
  for (const set of ex.sets) {
    if (!logicalNumbers.has(set.logicalSetId)) logicalNumbers.set(set.logicalSetId, logicalNumbers.size + 1)
  }
  const completedLogicalSets = new Set(
    ex.sets
      .filter((set) => set.completed && set.setType !== 'warmup')
      .map((set) => set.logicalSetId),
  ).size
  return (
    <div style={{ position: 'relative', paddingLeft: bandColor ? 10 : 0 }}>
      {bandColor && (
        <span
          aria-hidden
          style={{ position: 'absolute', left: 0, top: 2, bottom: 2, width: 3, borderRadius: 2, background: bandColor }}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={exName}>{ex.name}</span>
        <span style={exMeta}>
          {ex.loadBasis === 'per_side' ? 'Per side · ' : ''}{completedLogicalSets} × sets
        </span>
      </div>
      {ex.notes && <p style={exNotes}>{ex.notes}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
        {ex.sets.length === 0 ? (
          <span style={emptySet}>No sets logged</span>
        ) : (
          ex.sets.map((s, i) => {
            const rest = Object.prototype.hasOwnProperty.call(restEdits, s.id)
              ? restEdits[s.id]!
              : s.restSeconds
            return (
              <div key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <SetRow s={s} n={logicalNumbers.get(s.logicalSetId) ?? i + 1} tracks={ex.tracks} loadBasis={ex.loadBasis} distanceUnit={distanceUnit} />
                {/* Rest AFTER this set — a thin, tappable line between it and the
                    next set (never a block). Not shown on the last set. */}
                {showsRest && i < ex.sets.length - 1 && ex.sets[i + 1]?.logicalSetId !== s.logicalSetId && (
                  <RestLine seconds={rest ?? null} onSave={(sec) => onSaveRest(s.id, sec)} />
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** "2:00" / "90" → seconds; null when blank/unparseable. Accepts m:ss or bare
 *  seconds so a quick edit stays forgiving. */
function parseRest(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const m = s.match(/^(\d+):(\d{1,2})$/)
  if (m) return Number(m[1]) * 60 + Number(m[2])
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/** The thin rest line between two sets. Tap to edit the time inline. */
function RestLine({ seconds, onSave }: { seconds: number | null; onSave: (seconds: number | null) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [ambiguous, setAmbiguous] = useState<number | null>(null)
  function commit() {
    const next = parseRest(draft)
    // A bare "3" almost certainly meant 3:00 (#1832). This field commits on
    // BLUR as well as Enter, so tapping away would otherwise save 3 seconds
    // silently — ask instead, and stay open until the units are settled.
    if (next != null && isAmbiguousBareRest(draft, next)) {
      setAmbiguous(next)
      return
    }
    setEditing(false)
    setAmbiguous(null)
    if (next !== seconds) onSave(next)
  }
  function resolve(next: number) {
    setEditing(false)
    setAmbiguous(null)
    if (next !== seconds) onSave(next)
  }
  if (editing) {
    return (
      <div style={restLineWrap}>
        <span aria-hidden style={restRule} />
        <input
          autoFocus
          defaultValue={seconds != null ? mmss(seconds) : ''}
          onChange={(e) => {
            setDraft(e.target.value)
            setAmbiguous(null)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          placeholder="m:ss"
          aria-label="Rest between sets"
          style={restInput}
        />
        <span aria-hidden style={restRule} />
        {ambiguous != null && (
          <div role="group" aria-label="Confirm rest units" style={restUnitsWrap}>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => resolve(ambiguous * 60)}
              style={restUnitsBtn}
            >
              {mmss(ambiguous * 60)}
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => resolve(ambiguous)}
              style={restUnitsBtn}
            >
              {ambiguous}s
            </button>
          </div>
        )}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(seconds != null ? mmss(seconds) : '')
        setEditing(true)
      }}
      style={restLineBtn}
      aria-label={seconds != null ? `Rest ${mmss(seconds)} — edit` : 'Add rest between sets'}
    >
      <span aria-hidden style={restRule} />
      <span style={restLabel}>{seconds != null ? `⏱ ${mmss(seconds)}` : '+ rest'}</span>
      <span aria-hidden style={restRule} />
    </button>
  )
}

function SetRow({
  s,
  n,
  tracks,
  loadBasis,
  distanceUnit,
}: {
  s: SessionDetailSet
  n: number
  tracks: string
  loadBasis: 'total' | 'per_side'
  distanceUnit: DistanceUnit
}) {
  const tag = SET_TAG[s.setType] ?? null
  const warmup = s.setType === 'warmup'
  const value =
    tracks === 'time'
      ? mmss(s.durationS)
      : tracks === 'distance_time'
        ? `${formatDistance(s.distanceM, distanceUnit) || '—'}${s.durationS != null ? ` · ${mmss(s.durationS)}` : ''}${s.durationS != null && s.distanceM != null ? ` · ${formatPace(s.durationS, s.distanceM, paceBasisForDistanceUnit(distanceUnit))}` : ''}`
        : setValue(s.weight, s.reps, s.unit)
  return (
    <div style={{ ...setRow, opacity: warmup ? 0.55 : s.completed ? 1 : 0.65 }}>
      {/* Number by POSITION — imported sessions carry gaps in set_number where
          Strong rest-timer rows were folded out, so position stays 1..N. */}
      <span style={setNum}>{n}</span>
      <span style={setVal}>{value}</span>
      {/* Rest is rendered as its own line BETWEEN sets (see RestLine), not here. */}
      {loadBasis === 'per_side' && (
        <span style={sideTag}>{s.side ? titleCase(s.side) : 'Both'}</span>
      )}
      {s.rpe != null && <span style={rpeTag}>RPE {s.rpe}</span>}
      {tag && <span style={{ ...typeTag, color: tag.color }}>{tag.short}</span>}
      {!s.completed && <span style={plannedTag}>Planned</span>}
    </div>
  )
}

// ── small bits ───────────────────────────────────────────────────────────────
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={statValue}>{value}</span>
      <span style={statLabel}>{label}</span>
    </div>
  )
}

function ActionBtn({
  onClick,
  disabled,
  primary,
  danger,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '9px 14px',
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        borderRadius: 9,
        cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${primary ? 'var(--accent)' : danger ? 'color-mix(in oklch, var(--danger) 35%, var(--border-muted))' : 'var(--border-muted)'}`,
        background: primary ? 'var(--accent)' : danger ? 'color-mix(in oklch, var(--danger) 7%, var(--bg-elevated))' : 'var(--bg-elevated)',
        color: primary ? 'var(--accent-fg)' : danger ? 'var(--danger)' : 'var(--fg-muted)',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  )
}

// ── styles ─────────────────────────────────────────────────────────────────
const SHEET_CSS = `
.gym-hsheet {
  position: fixed; z-index: 60;
  background: var(--bg); border: 1px solid var(--border);
  box-shadow: var(--shadow-floating, 0 12px 48px rgba(0,0,0,.5));
  overflow-y: auto; -webkit-overflow-scrolling: touch;
  right: 0; top: 0; bottom: 0; width: 440px; max-width: 92vw;
  border-radius: 16px 0 0 16px; padding: 22px 22px 40px;
  animation: gym-hslide-in .22s cubic-bezier(.16,1,.3,1);
}
@keyframes gym-hslide-in { from { transform: translateX(24px); opacity: .6; } to { transform: none; opacity: 1; } }
@keyframes gym-hslide-up { from { transform: translateY(24px); opacity: .6; } to { transform: none; opacity: 1; } }
@media (max-width: 700px) {
  .gym-hsheet {
    left: 0; right: 0; top: auto; bottom: 0; width: 100%; max-width: 100%;
    max-height: 92vh; border-radius: 16px 16px 0 0;
    animation: gym-hslide-up .24s cubic-bezier(.16,1,.3,1);
  }
}
@media (prefers-reduced-motion: reduce) { .gym-hsheet { animation: none !important; } }
`
const scrim: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 55,
  background: 'color-mix(in oklch, var(--bg) 55%, transparent)',
  backdropFilter: 'blur(2px)',
}
const closeBtn: React.CSSProperties = {
  position: 'absolute',
  top: 14,
  right: 14,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: 8,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  zIndex: 2,
}
const title: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontWeight: 400,
  fontSize: 24,
  letterSpacing: '-0.01em',
  margin: '4px 40px 0 0',
  color: 'var(--fg)',
}
const dateLine: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  color: 'var(--fg-subtle)',
  marginTop: 6,
}
const statRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: 10,
  marginTop: 16,
  paddingTop: 14,
  borderTop: '1px solid var(--border-muted)',
}
const statValue: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--fg)',
  fontVariantNumeric: 'tabular-nums',
}
const statLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const chip: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-muted)',
  borderRadius: 6,
  padding: '3px 8px',
}
const sessionNotes: React.CSSProperties = {
  margin: '14px 0 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13.5,
  lineHeight: 1.5,
  color: 'var(--fg-muted)',
  background: 'var(--bg-subtle)',
  borderRadius: 8,
  padding: '10px 12px',
}
const exName: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 14.5,
  color: 'var(--fg)',
}
const exMeta: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
}
const exNotes: React.CSSProperties = {
  margin: '4px 0 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 12.5,
  color: 'var(--fg-subtle)',
}
const setRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '4px 8px',
  borderRadius: 6,
  background: 'var(--bg-elevated)',
}
const setNum: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-subtle)',
  width: 16,
  textAlign: 'center',
  flexShrink: 0,
}
const setVal: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: 'var(--fg-muted)',
  fontVariantNumeric: 'tabular-nums',
  flex: 1,
}
// Thin rest line between sets: a hairline rule with a small mono label,
// tappable to edit. Kept deliberately quiet so it never competes with the sets.
const restLineWrap: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '1px 8px',
}
const restLineBtn: React.CSSProperties = {
  ...restLineWrap,
  width: '100%',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  font: 'inherit',
}
const restRule: React.CSSProperties = {
  flex: 1,
  height: 1,
  background: 'var(--border-muted)',
}
const restLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.04em',
  color: 'var(--fg-subtle)',
  flexShrink: 0,
}
const restInput: React.CSSProperties = {
  ...restLabel,
  width: 56,
  textAlign: 'center',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 5,
  padding: '2px 4px',
  outline: 'none',
}
/** The two-choice units prompt shown inline when a bare rest value is ambiguous. */
const restUnitsWrap: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  marginLeft: 6,
}
const restUnitsBtn: React.CSSProperties = {
  ...restLabel,
  minHeight: 28,
  padding: '2px 7px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--accent)',
  borderRadius: 5,
  color: 'var(--fg)',
  cursor: 'pointer',
}
const rpeTag: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.04em',
  color: 'var(--fg-subtle)',
}
const typeTag: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  fontWeight: 600,
  width: 12,
  textAlign: 'center',
}
const sideTag: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.04em',
  color: 'var(--fg-subtle)',
}
const plannedTag: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.04em',
  color: 'var(--fg-subtle)',
}
const emptySet: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 12,
  color: 'var(--fg-subtle)',
}
const saveInput: React.CSSProperties = {
  flex: 1,
  padding: '9px 11px',
  fontSize: 13,
  fontFamily: 'var(--font-sans)',
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  outline: 'none',
}
const miniSave: React.CSSProperties = {
  padding: '9px 16px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
}
const note: React.CSSProperties = {
  margin: '30px 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13,
  color: 'var(--fg-subtle)',
  textAlign: 'center',
}
