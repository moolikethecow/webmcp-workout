'use client'

/**
 * ActiveExerciseCard (GYM_PLAN §4) — one exercise in the live logger. Header:
 * name (tap → ExerciseDetailSheet), a muscle chip (derived name→region), an
 * overflow menu (replace / remove / notes), and inline-expandable per-exercise
 * notes. Body: the SetTable + a [+ Add set] row.
 *
 * Collapse-on-complete: when EVERY set in the card is completed, the card
 * collapses to a one-line summary ("Bench Press — 4 sets · 170×8 top"); tapping
 * re-expands it. The list scrolls the next uncompleted exercise into view (owned
 * by LoggerExerciseList via a ref callback).
 */

import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Link2, Link2Off, MoreVertical, NotebookPen, Repeat, Trash2 } from 'lucide-react'

import { ExerciseDetailSheet } from '@/components/gym/exercises'
import { musclesForExercise, REGION_LABELS } from '@/lib/fitness/muscles'
import type { ActiveExercise, SetField, SetType, StrengthSideMode } from '@/lib/gym-client/active-types'
import type { PadTarget } from './pad-context'
import type { SupersetInfo } from './supersets'
import { SetTable } from './SetTable'
import { SwapSheet } from './SwapSheet'
import { collapsedSummary } from './format'
// P3-A3: reason-chip toast fired from the remove/replace flow (self-mounting,
// imperative — no component to mount here).
import { showRemovalReason } from './RemovalReasonChips'
import { GripPicker, type GripPatchInput } from './GripPicker'

function editableFields(tracks: string): SetField[] {
  switch (tracks) {
    case 'reps':
      return ['reps']
    case 'time':
      return ['durationS']
    case 'distance_time':
      return ['distanceM', 'durationS']
    default:
      return ['weight', 'reps']
  }
}

export function ActiveExerciseCard({
  exercise,
  superset = null,
  upNext = false,
  canSuperset = false,
  canMoveUp = false,
  canMoveDown = false,
  moving = false,
  sideMode = 'both',
  onCompleteSet,
  onAddSet,
  onAddWarmupSet,
  onDeleteSet,
  onCycleSetType,
  onUpdateSetRest,
  onUpdateNotes,
  onSetGrip,
  onCommitNotes,
  onSaveNoteToTemplate,
  onRemove,
  onReplace,
  onReplaceWith,
  onSupersetWithNext,
  onRemoveFromSuperset,
  onManageSuperset,
  onMoveUp,
  onMoveDown,
  onSideModeChange,
  onExerciseLoadBasisChange,
}: {
  exercise: ActiveExercise
  /** Derived superset label/colour/rotation for this card (null = ungrouped). */
  superset?: SupersetInfo | null
  /** True when this card is the next member up in its superset circuit. */
  upNext?: boolean
  /** Whether this workout has another exercise available to group. */
  canSuperset?: boolean
  canMoveUp?: boolean
  canMoveDown?: boolean
  moving?: boolean
  sideMode?: StrengthSideMode
  onCompleteSet: (workoutExerciseId: string, clientSetId: string) => void
  onAddSet: (workoutExerciseId: string) => void
  onAddWarmupSet: (workoutExerciseId: string) => void
  onDeleteSet: (clientSetId: string) => void
  onCycleSetType: (clientSetId: string, type: SetType) => void
  onUpdateSetRest: (clientSetId: string, seconds: number | null) => void
  onUpdateNotes: (workoutExerciseId: string, notes: string) => void
  /** Optional so every existing test render stays valid without a grip handler. */
  onSetGrip?: (workoutExerciseId: string, patch: GripPatchInput) => void | Promise<void>
  /** Force-persist the typed note (blur) instead of waiting out the debounce. */
  onCommitNotes?: () => void
  /** Promote the note to the source template. Absent for a template-less session. */
  onSaveNoteToTemplate?: (workoutExerciseId: string) => void
  onRemove: (workoutExerciseId: string) => void
  /** Legacy replace hook (opens the add sheet). Used when onReplaceWith is absent. */
  onReplace: (workoutExerciseId: string) => void
  /**
   * Preferred replace path (GYM_PLAN §6): opens the deterministic SwapSheet inside
   * the card and replaces the slot with the picked exercise. When provided, the
   * "Replace" menu item opens the swap sheet instead of calling onReplace.
   */
  onReplaceWith?: (
    workoutExerciseId: string,
    newExerciseId: string,
    keepPrescription: boolean,
  ) => void | Promise<void>
  onSupersetWithNext?: (workoutExerciseId: string) => void
  onRemoveFromSuperset?: (workoutExerciseId: string) => void
  onManageSuperset?: (workoutExerciseId: string) => void
  onMoveUp?: (workoutExerciseId: string) => void
  onMoveDown?: (workoutExerciseId: string) => void
  onSideModeChange?: (workoutExerciseId: string, mode: StrengthSideMode) => void
  onExerciseLoadBasisChange?: (
    workoutExerciseId: string,
    loadBasis: 'total' | 'per_side',
  ) => void | Promise<void>
}) {
  const [detailOpen, setDetailOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(Boolean(exercise.notes))
  const [manuallyExpanded, setManuallyExpanded] = useState(false)
  const [swapOpen, setSwapOpen] = useState(false)

  const allCompleted =
    exercise.sets.length > 0 && exercise.sets.every((s) => s.completed)
  const collapsed = allCompleted && !manuallyExpanded

  const region = useMemo(() => {
    const hits = musclesForExercise(exercise.name)
    const primary = hits.find((h) => h.weight === 1) ?? hits[0]
    return primary ? REGION_LABELS[primary.region] : null
  }, [exercise.name])

  /** Build the auto-advance chain across UNCOMPLETED fields, starting at (set,field). */
  const buildChain = useMemo(
    () =>
      (startClientSetId: string, startField: SetField): PadTarget[] => {
        const fields = editableFields(exercise.tracks)
        const chain: PadTarget[] = []
        let started = false
        for (const set of exercise.sets) {
          if (set.completed && set.clientSetId !== startClientSetId) continue
          for (const field of fields) {
            const isStart = set.clientSetId === startClientSetId && field === startField
            if (isStart) started = true
            if (!started) continue
            chain.push({
              workoutExerciseId: exercise.workoutExerciseId,
              clientSetId: set.clientSetId!,
              setNumber: set.setNumber,
              field,
              ghost: null, // resolved by the pad host from the live store
            })
          }
        }
        return chain
      },
    [exercise],
  )

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setManuallyExpanded(true)}
        aria-label={`Expand ${exercise.name}`}
        style={collapsedRow}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ ...checkDot }} aria-hidden />
          <span style={collapsedName}>{exercise.name}</span>
        </span>
        <span style={collapsedMeta}>{collapsedSummary(exercise.tracks, exercise.sets)}</span>
      </button>
    )
  }

  const grouped = superset?.group != null
  return (
    <div
      style={{
        ...card,
        ...(grouped
          ? {
              borderLeft: `3px solid ${superset!.color}`,
              paddingLeft: 12,
            }
          : null),
      }}
      data-superset-group={superset?.group ?? undefined}
    >
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {superset?.label && (
          <span
            style={{ ...groupBadge, color: superset.color!, borderColor: superset.color! }}
            aria-label={`Superset ${superset.label}`}
            title={`Superset ${superset.label}`}
          >
            {superset.label}
          </span>
        )}
        <button
          type="button"
          onClick={() => setDetailOpen(true)}
          style={nameBtn}
          aria-label={`Open ${exercise.name} details`}
        >
          <span style={exName}>{exercise.name}</span>
          {upNext && grouped && <span style={upNextChip}>up next</span>}
        </button>
        <div role="group" aria-label={`Reorder ${exercise.name}`} style={reorderGroup}>
          <button
            type="button"
            onClick={() => onMoveUp?.(exercise.workoutExerciseId)}
            disabled={!canMoveUp || moving}
            aria-label={`Move ${exercise.name} up`}
            style={{ ...reorderBtn, opacity: canMoveUp && !moving ? 1 : 0.32 }}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            onClick={() => onMoveDown?.(exercise.workoutExerciseId)}
            disabled={!canMoveDown || moving}
            aria-label={`Move ${exercise.name} down`}
            style={{ ...reorderBtn, opacity: canMoveDown && !moving ? 1 : 0.32 }}
          >
            <ArrowDown size={14} />
          </button>
        </div>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={`${exercise.name} options`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            style={overflowBtn}
          >
            <MoreVertical size={16} strokeWidth={1.8} />
          </button>
          {menuOpen && (
            <>
              <div style={menuScrim} onClick={() => setMenuOpen(false)} aria-hidden />
              <div role="menu" style={overflowMenu}>
                <MenuItem
                  icon={<Repeat size={14} />}
                  label="Replace"
                  onClick={() => {
                    if (onReplaceWith) setSwapOpen(true)
                    else onReplace(exercise.workoutExerciseId)
                    setMenuOpen(false)
                  }}
                />
                {canSuperset && (
                  <MenuItem
                    icon={<Link2 size={14} />}
                    label={grouped ? 'Edit superset / circuit' : 'Create superset / circuit'}
                    onClick={() => {
                      if (onManageSuperset) onManageSuperset(exercise.workoutExerciseId)
                      else onSupersetWithNext?.(exercise.workoutExerciseId)
                      setMenuOpen(false)
                    }}
                  />
                )}
                {grouped && (
                  <MenuItem
                    icon={<Link2Off size={14} />}
                    label="Remove from superset"
                    onClick={() => {
                      onRemoveFromSuperset?.(exercise.workoutExerciseId)
                      setMenuOpen(false)
                    }}
                  />
                )}
                <MenuItem
                  icon={<NotebookPen size={14} />}
                  label={notesOpen ? 'Hide notes' : 'Notes'}
                  onClick={() => {
                    setNotesOpen((v) => !v)
                    setMenuOpen(false)
                  }}
                />
                <MenuItem
                  icon={<Trash2 size={14} />}
                  label="Remove"
                  danger
                  onClick={() => {
                    onRemove(exercise.workoutExerciseId)
                    // P3-A3: offer the optional learning chips for the removed slot.
                    showRemovalReason({ exerciseId: exercise.exerciseId, exerciseName: exercise.name })
                    setMenuOpen(false)
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {(region || (exercise.modality === 'strength' && exercise.loadBasis === 'per_side')) && (
        <div style={metaRow}>
          {region && <span style={muscleChip}>{region}</span>}
          {exercise.modality === 'strength' && exercise.loadBasis === 'per_side' && (
            <div style={sideModeWrap}>
              <div role="group" aria-label={`${exercise.name} side mode`} style={sideModeGroup}>
                {SIDE_MODES.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={sideMode === value}
                    onClick={() => onSideModeChange?.(exercise.workoutExerciseId, value)}
                    style={{
                      ...sideModeButton,
                      color: sideMode === value ? 'var(--accent-fg)' : 'var(--fg-subtle)',
                      background: sideMode === value ? 'var(--accent)' : 'transparent',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span style={sideModeHint}>Applies to blank + future sets</span>
            </div>
          )}
        </div>
      )}

      {/* How it is being held. Sits above notes because it is the thing that
          used to END UP in notes ("did MAG grip") with nothing able to read it. */}
      {onSetGrip && (
        <GripPicker
          grip={exercise.grip}
          onChange={(patch) => void onSetGrip(exercise.workoutExerciseId, patch)}
        />
      )}

      {/* per-exercise notes (inline expandable). The note is the SESSION's; the
          link promotes it to the template this workout came from, so a cue
          learned mid-set is there next time without editing the template by hand. */}
      {notesOpen && (
        <>
          <textarea
            value={exercise.notes ?? ''}
            onChange={(e) => onUpdateNotes(exercise.workoutExerciseId, e.target.value)}
            onBlur={() => onCommitNotes?.()}
            placeholder="Notes for this exercise…"
            aria-label={`${exercise.name} notes`}
            rows={2}
            style={notesInput}
          />
          {onSaveNoteToTemplate && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()} // keep focus: blur would double-write
              onClick={() => onSaveNoteToTemplate(exercise.workoutExerciseId)}
              style={noteToTemplateBtn}
            >
              Save note to template
            </button>
          )}
        </>
      )}

      {/* set table */}
      <div style={{ marginTop: 10 }}>
        <SetTable
          exercise={exercise}
          onCompleteSet={onCompleteSet}
          onDeleteSet={onDeleteSet}
          onCycleSetType={onCycleSetType}
          onUpdateSetRest={onUpdateSetRest}
          buildChain={buildChain}
        />
      </div>

      {/* Warm-ups are opt-in: expose one deliberate action next to ordinary sets. */}
      <div style={addSetActions}>
        <button
          type="button"
          onClick={() => onAddWarmupSet(exercise.workoutExerciseId)}
          aria-label={`Add warm-up set to ${exercise.name}`}
          style={{ ...addSetRow, color: 'var(--warning)' }}
        >
          + Warm-up set
        </button>
        <button
          type="button"
          onClick={() => onAddSet(exercise.workoutExerciseId)}
          aria-label={`Add set to ${exercise.name}`}
          style={addSetRow}
        >
          + Add set
        </button>
      </div>

      {/* re-collapse affordance once complete but manually expanded */}
      {allCompleted && manuallyExpanded && (
        <button
          type="button"
          onClick={() => setManuallyExpanded(false)}
          style={collapseHint}
          aria-label={`Collapse ${exercise.name}`}
        >
          Collapse <ChevronDown size={12} style={{ transform: 'rotate(180deg)' }} />
        </button>
      )}

      {detailOpen && (
        <ExerciseDetailSheet
          id={exercise.exerciseId}
          onClose={() => setDetailOpen(false)}
          onExerciseChanged={(patch) => {
            if (patch.loadBasis) {
              void onExerciseLoadBasisChange?.(exercise.workoutExerciseId, patch.loadBasis)
            }
          }}
        />
      )}

      {swapOpen && onReplaceWith && (
        <SwapSheet
          workoutExerciseId={exercise.workoutExerciseId}
          sourceExerciseId={exercise.exerciseId}
          sourceName={exercise.name}
          sourceTracks={exercise.tracks}
          sourceTargets={exercise.targets}
          onPick={async (weId, newExerciseId, keepPrescription, newExerciseName) => {
            await onReplaceWith(weId, newExerciseId, keepPrescription)
            // P3-A3: offer the optional learning chips for the swapped-out exercise.
            // #1876: carries the replacement along so the "Preferred it" chip has
            // something to mark preferred — the toast is about THIS swap, not just
            // the exercise that left.
            showRemovalReason({
              exerciseId: exercise.exerciseId,
              exerciseName: exercise.name,
              replaced: true,
              replacementExerciseId: newExerciseId,
              replacementExerciseName: newExerciseName,
            })
          }}
          onClose={() => setSwapOpen(false)}
        />
      )}
    </div>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{ ...menuItem, color: danger ? 'var(--danger)' : 'var(--fg-muted)' }}
    >
      {icon}
      {label}
    </button>
  )
}

// ── styles ────────────────────────────────────────────────────────────────────
const card: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 'var(--radius, 12px)',
  padding: 12,
}
const nameBtn: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  textAlign: 'left',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
}
const exName: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 17,
  color: 'var(--fg)',
  lineHeight: 1.2,
}
const reorderGroup: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  flexShrink: 0,
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  overflow: 'hidden',
}
const reorderBtn: React.CSSProperties = {
  width: 34,
  height: 34,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderRight: '1px solid var(--border-muted)',
  background: 'var(--bg)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
}
const overflowBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  border: 'none',
  background: 'none',
  color: 'var(--fg-subtle)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
}
const muscleChip: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-muted)',
  borderRadius: 5,
  padding: '2px 7px',
}
const SIDE_MODES: Array<{ value: StrengthSideMode; label: string }> = [
  { value: 'both', label: 'Both' },
  { value: 'split', label: 'Split' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
]
const metaRow: React.CSSProperties = {
  marginTop: 6,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  flexWrap: 'wrap',
}
const sideModeGroup: React.CSSProperties = {
  display: 'inline-flex',
  padding: 2,
  border: '1px solid var(--border-muted)',
  borderRadius: 7,
  background: 'var(--bg)',
}
const sideModeWrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 3,
}
const sideModeHint: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  color: 'var(--fg-subtle)',
}
const sideModeButton: React.CSSProperties = {
  minWidth: 44,
  minHeight: 44,
  padding: '6px 8px',
  border: 0,
  borderRadius: 5,
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  cursor: 'pointer',
}
const groupBadge: React.CSSProperties = {
  flexShrink: 0,
  marginTop: 2,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 24,
  height: 20,
  padding: '0 5px',
  borderRadius: 6,
  border: '1px solid',
  background: 'transparent',
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.02em',
}
const upNextChip: React.CSSProperties = {
  marginLeft: 8,
  display: 'inline-block',
  verticalAlign: 'middle',
  padding: '1px 6px',
  borderRadius: 5,
  background: 'color-mix(in oklch, var(--accent) 16%, transparent)',
  border: '1px solid color-mix(in oklch, var(--accent) 40%, transparent)',
  color: 'var(--accent)',
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  fontWeight: 700,
}
const notesInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 8,
  padding: '8px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: 'var(--fg)',
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  outline: 'none',
  resize: 'vertical',
}
const noteToTemplateBtn: React.CSSProperties = {
  marginTop: 5,
  padding: 0,
  border: 'none',
  background: 'none',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.04em',
  color: 'var(--accent)',
  cursor: 'pointer',
}
const addSetRow: React.CSSProperties = {
  flex: 1,
  padding: '9px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
  color: 'var(--accent)',
  background: 'transparent',
  border: '1px dashed color-mix(in oklch, var(--accent) 35%, transparent)',
  borderRadius: 8,
  cursor: 'pointer',
}
const addSetActions: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 8,
}
const collapseHint: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  marginTop: 8,
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-subtle)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
}
const collapsedRow: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '12px 14px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 'var(--radius, 12px)',
  cursor: 'pointer',
  textAlign: 'left',
}
const collapsedName: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 15,
  color: 'var(--fg-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const collapsedMeta: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}
const checkDot: React.CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: '50%',
  background: 'var(--success, var(--accent))',
  flexShrink: 0,
}
const menuScrim: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 40 }
const overflowMenu: React.CSSProperties = {
  position: 'absolute',
  top: 32,
  right: 0,
  zIndex: 41,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 150,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  boxShadow: '0 8px 28px rgba(0,0,0,.3)',
  padding: 4,
}
const menuItem: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '9px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  background: 'none',
  border: 'none',
  borderRadius: 7,
  cursor: 'pointer',
  textAlign: 'left',
}
