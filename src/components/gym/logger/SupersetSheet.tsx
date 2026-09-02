'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Link2, X } from 'lucide-react'

export interface SupersetExerciseOption {
  workoutExerciseId: string
  name: string
  position: number
}

interface SupersetSheetProps {
  exercises: SupersetExerciseOption[]
  initialSelectedIds: string[]
  onSave: (workoutExerciseIds: string[]) => Promise<void>
  onClose: () => void
}

/** Strong-style arbitrary superset/circuit picker. Exercise order is owned by the
 * workout; this sheet only chooses membership, so A1/B1 rotation stays predictable. */
export function SupersetSheet({
  exercises,
  initialSelectedIds,
  onSave,
  onClose,
}: SupersetSheetProps) {
  const ordered = useMemo(
    () => [...exercises].sort((a, b) => a.position - b.position),
    [exercises],
  )
  const [selected, setSelected] = useState(() => new Set(initialSelectedIds))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, saving])

  async function save() {
    if (selected.size < 2 || saving) return
    setSaving(true)
    try {
      await onSave(ordered.filter((ex) => selected.has(ex.workoutExerciseId)).map((ex) => ex.workoutExerciseId))
      onClose()
    } catch {
      const { toast } = await import('sonner')
      toast.error("Couldn't update that superset.")
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div
      role="presentation"
      style={scrim}
      onClick={(event) => event.target === event.currentTarget && !saving && onClose()}
    >
      <section role="dialog" aria-modal="true" aria-labelledby="superset-title" style={sheet}>
        <div style={handle} aria-hidden />
        <div style={head}>
          <div>
            <span style={eyebrow}>
              <Link2 size={12} /> Superset
            </span>
            <h2 id="superset-title" style={title}>Choose any exercises</h2>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close superset picker" style={closeBtn}>
            <X size={16} />
          </button>
        </div>

        <p style={help}>
          Pick two for a superset or three or more for a circuit. Sets rotate in workout order.
        </p>

        <div style={list}>
          {ordered.map((exercise, index) => {
            const checked = selected.has(exercise.workoutExerciseId)
            return (
              <label key={exercise.workoutExerciseId} style={{ ...row, borderColor: checked ? 'color-mix(in oklch, var(--accent) 45%, var(--border-muted))' : 'var(--border-muted)' }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    setSelected((current) => {
                      const next = new Set(current)
                      if (next.has(exercise.workoutExerciseId)) next.delete(exercise.workoutExerciseId)
                      else next.add(exercise.workoutExerciseId)
                      return next
                    })
                  }}
                  style={nativeCheckbox}
                />
                <span style={{ ...checkBox, background: checked ? 'var(--accent)' : 'transparent', borderColor: checked ? 'var(--accent)' : 'var(--border)' }} aria-hidden>
                  {checked && <Check size={13} strokeWidth={2.7} />}
                </span>
                <span style={order}>{index + 1}</span>
                <span style={name}>{exercise.name}</span>
              </label>
            )
          })}
        </div>

        <div style={footer}>
          <span style={count} aria-live="polite">
            {selected.size} selected
          </span>
          <button
            type="button"
            onClick={() => void save()}
            disabled={selected.size < 2 || saving}
            style={{ ...saveBtn, opacity: selected.size < 2 || saving ? 0.5 : 1 }}
          >
            {saving ? 'Saving…' : selected.size > 2 ? 'Save circuit' : 'Save superset'}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  )
}

const scrim: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  padding: '16px max(12px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left))',
  background: 'color-mix(in oklch, var(--bg) 58%, transparent)',
  backdropFilter: 'blur(2px)',
}
const sheet: React.CSSProperties = {
  width: 'min(520px, 100%)',
  maxHeight: 'min(720px, 88dvh)',
  overflowY: 'auto',
  padding: '10px 16px 16px',
  borderRadius: 18,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  boxShadow: 'var(--shadow-floating, 0 18px 60px rgba(0,0,0,.45))',
}
const handle: React.CSSProperties = { width: 36, height: 4, margin: '0 auto 12px', borderRadius: 999, background: 'var(--border)' }
const head: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }
const eyebrow: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--accent)' }
const title: React.CSSProperties = { margin: '4px 0 0', fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontWeight: 400, fontSize: 22, color: 'var(--fg)' }
const closeBtn: React.CSSProperties = { width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 9, border: '1px solid var(--border-muted)', background: 'var(--bg-elevated)', color: 'var(--fg-muted)', cursor: 'pointer' }
const help: React.CSSProperties = { margin: '10px 0 14px', fontFamily: 'var(--font-sans)', fontSize: 12.5, lineHeight: 1.45, color: 'var(--fg-subtle)' }
const list: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 7 }
const row: React.CSSProperties = { position: 'relative', display: 'flex', alignItems: 'center', gap: 10, minHeight: 48, padding: '8px 10px', border: '1px solid var(--border-muted)', borderRadius: 11, background: 'var(--bg-elevated)', cursor: 'pointer' }
const nativeCheckbox: React.CSSProperties = { position: 'absolute', opacity: 0, pointerEvents: 'none' }
const checkBox: React.CSSProperties = { width: 21, height: 21, display: 'grid', placeItems: 'center', flexShrink: 0, borderRadius: 6, border: '1px solid var(--border)', color: 'var(--accent-fg)' }
const order: React.CSSProperties = { width: 18, flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-subtle)', textAlign: 'right' }
const name: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg)' }
const footer: React.CSSProperties = { position: 'sticky', bottom: -16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '14px -16px -16px', padding: '12px 16px 16px', borderTop: '1px solid var(--border-muted)', background: 'color-mix(in oklch, var(--bg) 92%, transparent)', backdropFilter: 'blur(8px)' }
const count: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-subtle)', fontVariantNumeric: 'tabular-nums' }
const saveBtn: React.CSSProperties = { minHeight: 44, padding: '10px 16px', border: 'none', borderRadius: 10, background: 'var(--accent)', color: 'var(--accent-fg)', fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 650, cursor: 'pointer' }
