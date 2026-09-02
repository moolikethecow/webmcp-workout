'use client'

/**
 * TemplateEditor (GYM_PLAN §4 "Tab: Templates" builder) — a full-height bottom
 * sheet on mobile / centered pane on wide. Owns the working draft (name, folder,
 * notes + an ordered exercise list) and saves it in one shot:
 *   - new template  → POST /api/gym/templates (full payload) → { template }
 *   - existing      → PATCH /api/gym/templates/[id] (replace-all)
 *
 * Per exercise: target sets × reps (or duration for timed tracks) + optional target
 * weight, working/warmup rest, an arbitrary superset/circuit picker (derived A1/B1
 * labels), a progression-policy picker (§2.5 live preview), notes, remove, and
 * reorder (drag on desktop + up/down buttons everywhere — no new deps, touch-safe).
 *
 * Add-exercise reuses the P2a AddExerciseSheet (the gym-client search hook).
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical, Link2, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'

import { AddExerciseSheet } from '@/components/gym/logger/AddExerciseSheet'
import { SupersetSheet } from '@/components/gym/logger/SupersetSheet'

import {
  createTemplate,
  saveTemplate,
  useTemplateEditor,
} from './templates-client'
import { ProgressionPolicyPicker } from './ProgressionPolicyPicker'
import {
  draftToPayload,
  isTimedTrack,
  moveRow,
  newDraft,
  patchDraftExercise,
  setSupersetMembers,
  supersetLabels,
  toDraft,
  type DraftExercise,
} from './editor-state'

export function TemplateEditor({
  templateId,
  folders,
  onClose,
  onSaved,
}: {
  /** Editing an existing template, or null for a fresh "new template". */
  templateId: string | null
  /** Existing folder names for the datalist. */
  folders: string[]
  onClose: () => void
  /** Called after a successful save (parent refetches the card list). */
  onSaved: () => void
}) {
  const isNew = templateId == null
  const { data, loading, error } = useTemplateEditor(templateId)

  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [notes, setNotes] = useState('')
  const [rows, setRows] = useState<DraftExercise[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [saving, setSaving] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [supersetForKey, setSupersetForKey] = useState<string | null>(null)
  const [appWeightUnit, setAppWeightUnit] = useState<'lb' | 'kg'>('lb')
  const [unitLoaded, setUnitLoaded] = useState(false)

  // New rows have no editor GET payload to carry the display unit, so read the
  // app-wide setting once. Existing rows still carry their explicit unit across
  // the draft/save boundary.
  useEffect(() => {
    let alive = true
    void fetch('/api/gym/settings')
      .then((res) => (res.ok ? res.json() : null))
      .then((settings: { gym_default_unit?: unknown } | null) => {
        if (alive && settings?.gym_default_unit === 'kg') setAppWeightUnit('kg')
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setUnitLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [])

  // Hydrate the draft once the editor data loads (or immediately for a new one).
  useEffect(() => {
    if (hydrated) return
    if (isNew) {
      if (!unitLoaded) return
      setHydrated(true)
      return
    }
    if (data?.template) {
      setName(data.template.name)
      setFolder(data.template.folder ?? '')
      setNotes(data.template.notes ?? '')
      setRows(data.template.exercises.map(toDraft))
      const loadedUnit = data.template.exercises[0]?.targetWeightUnit
      if (loadedUnit) setAppWeightUnit(loadedUnit)
      setHydrated(true)
    }
  }, [data, isNew, hydrated, unitLoaded])

  const labels = useMemo(() => supersetLabels(rows), [rows])
  const canSave = name.trim().length > 0 && rows.length > 0 && !saving

  function patchRow(key: string, patch: Partial<DraftExercise>) {
    setRows((rs) => rs.map((r) => (r.key === key ? patchDraftExercise(r, patch) : r)))
  }
  function removeRow(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key))
  }
  function move(from: number, to: number) {
    setRows((rs) => moveRow(rs, from, to))
  }
  async function handleAdd(exerciseId: string) {
    // AddExerciseSheet only hands back an id. Fetch the one exercise's detail so the
    // new row shows its real name/track/unit immediately; on any failure, seed a
    // stub row (the name resolves after save + reload).
    try {
      const res = await fetch(`/api/gym/exercises/${encodeURIComponent(exerciseId)}`)
      if (res.ok) {
        const { exercise } = (await res.json()) as {
          exercise: { id: string; name: string; tracks: string; preferredUnit: 'lb' | 'kg' | null }
        }
        setRows((rs) => [
          ...rs,
          newDraft({
            exerciseId: exercise.id,
            name: exercise.name,
            tracks: exercise.tracks,
            preferredUnit: exercise.preferredUnit,
            targetWeightUnit: appWeightUnit,
          }),
        ])
        return
      }
    } catch {
      /* fall through to stub */
    }
    // Fallback: add a stub row (name resolves after save+reload).
    setRows((rs) => [
      ...rs,
      newDraft({
        exerciseId,
        name: 'Exercise',
        tracks: 'weight_reps',
        targetWeightUnit: appWeightUnit,
      }),
    ])
  }

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    const payload = {
      name: name.trim(),
      folder: folder.trim() || null,
      notes: notes.trim() || null,
      exercises: draftToPayload(rows),
    }
    try {
      if (isNew) await createTemplate(payload)
      else await saveTemplate(templateId!, payload)
      toast.success(isNew ? 'Template created' : 'Template saved')
      onSaved()
      onClose()
    } catch {
      toast.error("Couldn't save the template — try again.")
      setSaving(false)
    }
  }

  return (
    <div role="presentation" style={scrim} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={isNew ? 'New template' : 'Edit template'} style={sheet} className="gym-tpl-sheet">
        <style>{SHEET_CSS}</style>

        {/* Header */}
        <div style={headerRow}>
          <span style={heading}>{isNew ? 'New template' : 'Edit template'}</span>
          <button type="button" onClick={onClose} aria-label="Close" style={closeBtn}>
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        {!isNew && loading && !hydrated && <p style={note}>Loading template…</p>}
        {!isNew && error && <p style={note}>Couldn&rsquo;t load this template.</p>}

        {hydrated && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', flex: 1 }}>
            {/* Meta */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Template name"
                aria-label="Template name"
                style={{ ...textInput, fontSize: 16 }}
              />
              <input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="Folder (optional)"
                aria-label="Folder"
                list="gym-tpl-folders"
                style={textInput}
              />
              <datalist id="gym-tpl-folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes (optional)"
                aria-label="Notes"
                rows={2}
                style={{ ...textInput, resize: 'vertical', fontFamily: 'var(--font-sans)' }}
              />
            </div>

            {/* Exercise list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rows.length === 0 && (
                <p style={note}>No exercises yet. Add one below to build the skeleton.</p>
              )}
              {rows.map((row, i) => (
                <ExerciseRow
                  key={row.key}
                  row={row}
                  index={i}
                  count={rows.length}
                  label={labels[i]}
                  isDragging={dragIndex === i}
                  onDragStart={() => setDragIndex(i)}
                  onDragEnter={() => {
                    if (dragIndex != null && dragIndex !== i) {
                      move(dragIndex, i)
                      setDragIndex(i)
                    }
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  onPatch={(p) => patchRow(row.key, p)}
                  onRemove={() => removeRow(row.key)}
                  onMoveUp={() => move(i, i - 1)}
                  onMoveDown={() => move(i, i + 1)}
                  onManageSuperset={() => setSupersetForKey(row.key)}
                />
              ))}

              <button type="button" onClick={() => setAddOpen(true)} style={addBtn}>
                <Plus size={15} strokeWidth={2} /> Add exercise
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        {hydrated && (
          <div style={footer}>
            <button type="button" onClick={onClose} style={cancelBtn}>
              Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={!canSave} style={saveBtn(canSave)}>
              {saving ? 'Saving…' : isNew ? 'Create template' : 'Save changes'}
            </button>
          </div>
        )}

        {addOpen && (
          <AddExerciseSheet
            onAdd={handleAdd}
            onClose={() => setAddOpen(false)}
          />
        )}
        {supersetForKey && (
          <SupersetSheet
            exercises={rows.map((row, position) => ({
              workoutExerciseId: row.key,
              name: row.name,
              position,
            }))}
            initialSelectedIds={selectedTemplateSupersetKeys(rows, supersetForKey)}
            onSave={async (selectedKeys) => {
              setRows((current) => setSupersetMembers(current, supersetForKey, selectedKeys))
            }}
            onClose={() => setSupersetForKey(null)}
          />
        )}
      </div>
    </div>
  )
}

function selectedTemplateSupersetKeys(rows: DraftExercise[], sourceKey: string): string[] {
  const source = rows.find((row) => row.key === sourceKey)
  if (!source || source.supersetGroup == null) return source ? [source.key] : []
  return rows
    .filter((row) => row.supersetGroup === source.supersetGroup)
    .map((row) => row.key)
}

// ── one exercise row ─────────────────────────────────────────────────────────
function ExerciseRow({
  row,
  index,
  count,
  label,
  isDragging,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onPatch,
  onRemove,
  onMoveUp,
  onMoveDown,
  onManageSuperset,
}: {
  row: DraftExercise
  index: number
  count: number
  label: string | null
  isDragging: boolean
  onDragStart: () => void
  onDragEnter: () => void
  onDragEnd: () => void
  onPatch: (p: Partial<DraftExercise>) => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onManageSuperset: () => void
}) {
  const timed = isTimedTrack(row.tracks)
  const targetUnit = row.targetWeightUnit
  // Progression increments are evaluated in the exercise/history unit, while
  // the point target is an app-wide display value. Keep those labels explicit
  // so switching the app to kg never turns an existing +5 lb policy into +5 kg.
  const progressionUnit = row.preferredUnit ?? targetUnit
  return (
    <div
      style={{ ...card, opacity: isDragging ? 0.5 : 1, borderColor: label ? 'color-mix(in oklch, var(--accent) 40%, var(--border-muted))' : 'var(--border-muted)' }}
      onDragOver={(e) => {
        e.preventDefault()
        onDragEnter()
      }}
    >
      {/* Row header: grip + name + superset label + reorder + remove */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          aria-label="Drag to reorder"
          style={grip}
        >
          <GripVertical size={15} strokeWidth={1.8} />
        </span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
          {label && <span style={supersetBadge}>{label}</span>}
          <span style={exName}>{row.name}</span>
        </span>
        <button type="button" onClick={onMoveUp} disabled={index === 0} aria-label="Move up" style={iconBtn(index === 0)}>
          <ArrowUp size={14} strokeWidth={1.9} />
        </button>
        <button type="button" onClick={onMoveDown} disabled={index === count - 1} aria-label="Move down" style={iconBtn(index === count - 1)}>
          <ArrowDown size={14} strokeWidth={1.9} />
        </button>
        <button type="button" onClick={onRemove} aria-label={`Remove ${row.name}`} style={iconBtn(false)}>
          <Trash2 size={14} strokeWidth={1.9} />
        </button>
      </div>

      {/* Targets */}
      <div style={targetRow}>
        <NumCell
          label="Sets"
          value={row.targetSets}
          onChange={(v) => onPatch({ targetSets: v })}
          min={1}
        />
        {timed ? (
          <NumCell
            label="Seconds"
            value={row.targetDurationS}
            onChange={(v) => onPatch({ targetDurationS: v })}
            min={0}
          />
        ) : (
          <NumCell
            label="Reps"
            value={row.targetReps}
            onChange={(v) => onPatch({ targetReps: v })}
            min={0}
          />
        )}
        <NumCell
          label={`Weight (${targetUnit})`}
          value={row.targetWeight}
          onChange={(v) => onPatch({ targetWeight: v })}
          min={0}
          step={targetUnit === 'kg' ? 2.5 : 5}
          allowEmpty
        />
      </div>

      {/* Rest */}
      <div style={targetRow}>
        <NumCell
          label="Rest (s)"
          value={row.restSeconds}
          onChange={(v) => onPatch({ restSeconds: v })}
          min={0}
          step={15}
          allowEmpty
        />
        <button
          type="button"
          onClick={onManageSuperset}
          disabled={count < 2}
          aria-label={`${label ? 'Edit' : 'Create'} superset or circuit for ${row.name}`}
          style={supersetBtn(label != null, count < 2)}
        >
          <Link2 size={13} strokeWidth={1.9} />
          {label ? 'Edit superset / circuit' : 'Create superset / circuit'}
        </button>
      </div>

      {/* Progression policy */}
      <ProgressionPolicyPicker
        value={row.progression}
        unit={progressionUnit}
        onChange={(policy) => onPatch({ progression: policy })}
      />
    </div>
  )
}

// ── number cell ──────────────────────────────────────────────────────────────
function NumCell({
  label,
  value,
  onChange,
  min,
  step,
  allowEmpty,
}: {
  label: string
  value: number | null
  onChange: (v: number | null) => void
  min?: number
  step?: number
  allowEmpty?: boolean
}) {
  return (
    <label style={cellLabel}>
      <span style={cellLabelText}>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={value ?? ''}
        min={min}
        step={step}
        // Focusing a filled cell selects it so typing overwrites (no append).
        onFocus={(e) => e.target.select()}
        enterKeyHint="done"
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '') {
            onChange(allowEmpty ? null : min ?? 0)
            return
          }
          const n = Number(raw)
          if (Number.isFinite(n)) onChange(n)
        }}
        aria-label={label}
        style={cellInput}
      />
    </label>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────
const SHEET_CSS = `
.gym-tpl-sheet { animation: gym-tpl-up .2s cubic-bezier(.16,1,.3,1); }
@keyframes gym-tpl-up { from { transform: translateY(28px); opacity: .6; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .gym-tpl-sheet { animation: none; } }
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
  maxWidth: 560,
  height: '92vh',
  maxHeight: '92vh',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '16px 16px 0 0',
  boxShadow: '0 -12px 40px rgba(0,0,0,.34)',
  padding: '16px 16px calc(12px + env(safe-area-inset-bottom, 0px))',
}
const headerRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
}
const heading: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 19,
  color: 'var(--fg)',
}
const closeBtn: React.CSSProperties = {
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
const textInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  fontSize: 14.5,
  fontFamily: 'var(--font-sans)',
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
  outline: 'none',
}
const card: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 12,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 12,
}
const grip: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  color: 'var(--fg-subtle)',
  cursor: 'grab',
  touchAction: 'none',
}
const exName: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 14.5,
  color: 'var(--fg)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const supersetBadge: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.04em',
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  borderRadius: 5,
  padding: '2px 6px',
  flexShrink: 0,
}
function iconBtn(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: 7,
    border: '1px solid var(--border-muted)',
    background: 'var(--bg-subtle)',
    color: disabled ? 'var(--fg-subtle)' : 'var(--fg-muted)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    flexShrink: 0,
  }
}
const targetRow: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  alignItems: 'flex-end',
}
const cellLabel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 72 }
const cellLabelText: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const cellInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  fontSize: 15,
  fontFamily: 'var(--font-mono)',
  color: 'var(--fg)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  outline: 'none',
}
function supersetBtn(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 12px',
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    letterSpacing: '0.03em',
    borderRadius: 8,
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-muted)'}`,
    background: active ? 'color-mix(in oklch, var(--accent) 16%, var(--bg-subtle))' : 'var(--bg-subtle)',
    color: active ? 'var(--accent)' : 'var(--fg-muted)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    alignSelf: 'flex-end',
    height: 36,
  }
}
const addBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  padding: '11px 14px',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--accent)',
  background: 'transparent',
  border: '1px dashed color-mix(in oklch, var(--accent) 45%, transparent)',
  borderRadius: 10,
  cursor: 'pointer',
}
const footer: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  paddingTop: 6,
  borderTop: '1px solid var(--border-muted)',
}
const cancelBtn: React.CSSProperties = {
  flex: 1,
  padding: '12px',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--fg-muted)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
  cursor: 'pointer',
}
function saveBtn(enabled: boolean): React.CSSProperties {
  return {
    flex: 2,
    padding: '12px',
    fontFamily: 'var(--font-sans)',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--accent-fg)',
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 10,
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.5,
  }
}
const note: React.CSSProperties = {
  margin: '8px 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13,
  color: 'var(--fg-subtle)',
}
