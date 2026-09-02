'use client'

/**
 * ProgressionPolicyPicker (GYM_PLAN §2.5) — the per-exercise progression policy
 * editor inside the template builder. A named-policy select + the minimal param
 * inputs per type, with a LIVE plain-English preview rendered by the ENGINE's
 * `ruleTextFor` (so the builder chip is byte-identical to the session ghosts).
 *
 * The picker only authors the 5 named policy types; the composable `rule` type is
 * chat-authored in P3. If a slot arrives carrying a `rule` policy (from chat), we
 * show its preview read-only and offer "replace with a simple rule" rather than
 * silently dropping it.
 */
import { useMemo } from 'react'

import { ruleTextFor } from '@/lib/gym/progression'

import type { EditablePolicy, PolicyType, ProgressionUnit } from './types'

const POLICY_OPTIONS: Array<{ type: PolicyType; label: string }> = [
  { type: 'last_time', label: 'Last time (repeat)' },
  { type: 'double_progression', label: 'Double progression' },
  { type: 'linear', label: 'Linear (add each session)' },
  { type: 'rep_only', label: 'Rep-only' },
  { type: 'rpe_target', label: 'RPE target' },
]

/** Sensible defaults per unit so switching type produces a usable, valid policy. */
function defaultPolicy(type: PolicyType, unit: ProgressionUnit): EditablePolicy {
  const step = unit === 'kg' ? 2.5 : 5
  switch (type) {
    case 'last_time':
      return { type: 'last_time' }
    case 'double_progression':
      return { type: 'double_progression', repRange: [8, 12], increment: step }
    case 'linear':
      return { type: 'linear', increment: step }
    case 'rep_only':
      return { type: 'rep_only', addRepWhen: { repsAtLeast: 12 }, addReps: 1 }
    case 'rpe_target':
      return { type: 'rpe_target', rpe: 8 }
  }
}

/** Narrow a stored policy JSON to the editable shape, or last_time if it's a
 *  chat-authored `rule` / unknown. Returns `{ policy, external }` where external
 *  = true means the incoming policy isn't editable here (a `rule`). */
function toEditable(raw: unknown): { policy: EditablePolicy; external: boolean } {
  if (raw == null || typeof raw !== 'object') return { policy: { type: 'last_time' }, external: false }
  const t = (raw as { type?: unknown }).type
  if (
    t === 'last_time' ||
    t === 'double_progression' ||
    t === 'linear' ||
    t === 'rep_only' ||
    t === 'rpe_target'
  ) {
    return { policy: raw as EditablePolicy, external: false }
  }
  // A `rule` (or anything else valid the engine understands) — not editable here.
  return { policy: { type: 'last_time' }, external: t === 'rule' }
}

export function ProgressionPolicyPicker({
  value,
  unit,
  onChange,
}: {
  /** The stored §2.5 policy JSON (null ⇒ last_time). */
  value: unknown
  /** The exercise's display unit — weights in the preview render in it. */
  unit: ProgressionUnit
  /** Emits the new §2.5 policy JSON (or null for last_time). */
  onChange: (policy: unknown) => void
}) {
  const { policy, external } = useMemo(() => toEditable(value), [value])
  const preview = useMemo(() => ruleTextFor(value, unit), [value, unit])

  function setType(type: PolicyType) {
    const next = defaultPolicy(type, unit)
    onChange(type === 'last_time' ? null : next)
  }

  function patch(next: EditablePolicy) {
    onChange(next)
  }

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label style={miniLabel} htmlFor="policy-type">
          Progression
        </label>
        <select
          id="policy-type"
          value={external ? 'rule' : policy.type}
          onChange={(e) => setType(e.target.value as PolicyType)}
          aria-label="Progression policy"
          style={selectStyle}
        >
          {external && (
            <option value="rule" disabled>
              Custom rule (from chat)
            </option>
          )}
          {POLICY_OPTIONS.map((o) => (
            <option key={o.type} value={o.type}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Per-type params */}
      {!external && policy.type === 'double_progression' && (
        <div style={paramRow}>
          <NumField
            label="Reps"
            value={policy.repRange[0]}
            onChange={(v) => patch({ ...policy, repRange: [v ?? 1, policy.repRange[1]] })}
            min={1}
          />
          <span style={dash}>–</span>
          <NumField
            label=" "
            value={policy.repRange[1]}
            onChange={(v) => patch({ ...policy, repRange: [policy.repRange[0], v ?? 1] })}
            min={1}
          />
          <NumField
            label={`+${unit}`}
            value={policy.increment}
            onChange={(v) => patch({ ...policy, increment: v ?? 0 })}
            min={0}
            step={unit === 'kg' ? 2.5 : 5}
          />
        </div>
      )}

      {!external && policy.type === 'linear' && (
        <div style={paramRow}>
          <NumField
            label={`Add ${unit}/session`}
            value={policy.increment}
            onChange={(v) => patch({ ...policy, increment: v ?? 0 })}
            min={0}
            step={unit === 'kg' ? 2.5 : 5}
          />
        </div>
      )}

      {!external && policy.type === 'rep_only' && (
        <div style={paramRow}>
          <NumField
            label="+rep when reps ≥"
            value={policy.addRepWhen.repsAtLeast}
            onChange={(v) => patch({ ...policy, addRepWhen: { repsAtLeast: v ?? 1 } })}
            min={1}
          />
          <NumField
            label="cap reps"
            value={policy.capReps ?? null}
            onChange={(v) => patch({ ...policy, capReps: v == null || v <= 0 ? undefined : v })}
            min={0}
            allowEmpty
          />
        </div>
      )}

      {!external && policy.type === 'rpe_target' && (
        <div style={paramRow}>
          <NumField
            label="Target RPE"
            value={policy.rpe}
            onChange={(v) => patch({ ...policy, rpe: v ?? 8 })}
            min={1}
            max={10}
            step={0.5}
          />
        </div>
      )}

      {external && (
        <p style={externalNote}>
          Authored in chat. Switch the type above to replace it with a simple rule.
        </p>
      )}

      {/* Live plain-English preview (the same string the ghosts carry). */}
      <p style={previewStyle} aria-live="polite">
        {preview}
      </p>
    </div>
  )
}

// ── number field ─────────────────────────────────────────────────────────────
function NumField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  allowEmpty,
}: {
  label: string
  value: number | null
  onChange: (v: number | null) => void
  min?: number
  max?: number
  step?: number
  allowEmpty?: boolean
}) {
  return (
    <label style={fieldLabel}>
      <span style={miniLabel}>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '') {
            onChange(allowEmpty ? null : (min ?? 0))
            return
          }
          const n = Number(raw)
          if (Number.isFinite(n)) onChange(n)
        }}
        aria-label={label.trim() || 'value'}
        style={numInput}
      />
    </label>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────
const wrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
}
const paramRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  flexWrap: 'wrap',
  gap: 8,
}
const dash: React.CSSProperties = { color: 'var(--fg-subtle)', paddingBottom: 8 }
const miniLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const fieldLabel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3 }
const numInput: React.CSSProperties = {
  width: 70,
  boxSizing: 'border-box',
  padding: '7px 8px',
  fontSize: 14,
  fontFamily: 'var(--font-mono)',
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  outline: 'none',
}
const selectStyle: React.CSSProperties = {
  padding: '7px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  cursor: 'pointer',
  outline: 'none',
}
const previewStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 12.5,
  lineHeight: 1.5,
  color: 'var(--fg-muted)',
}
const externalNote: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--accent)',
}
