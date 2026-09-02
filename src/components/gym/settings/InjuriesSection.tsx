'use client'

/**
 * InjuriesSection (GYM_PLAN §4 settings sheet) — the injuries editor inside the
 * Gym settings sheet. Active injuries list (region label + severity pill + note +
 * resolve); an add flow (site picker → canonical InjurySite, severity select,
 * free-text label + note); resolved rows collapse under a toggle.
 *
 * Region picking uses a canonical injury-site grid; every write validates the
 * same shared enum server-side.
 * Writes are optimistic; a failed call reloads from the server so the UI never
 * drifts silently.
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, Plus, X } from 'lucide-react'

import { MonoLabel } from '@/components/health/primitives'
import {
  INJURY_SITES,
  INJURY_SITE_LABELS,
  type InjurySite,
} from '@/lib/gym/injury-profile'

interface Injury {
  id: string
  region: InjurySite
  label: string | null
  note: string | null
  severity: 'nagging' | 'limiting' | 'out' | null
  resolvedAt: string | null
  active: boolean
}

const SEVERITIES: Array<{ id: 'nagging' | 'limiting' | 'out'; label: string; help: string }> = [
  { id: 'nagging', label: 'Nagging', help: 'recorded, but not automatically blocked' },
  { id: 'limiting', label: 'Limiting', help: 'exclude exercises that involve it' },
  { id: 'out', label: 'Out', help: 'exclude any documented involvement' },
]

const labelStyle: React.CSSProperties = { fontSize: 13, color: 'var(--fg)', fontWeight: 500 }
const helpStyle: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  color: 'var(--fg-subtle)',
  margin: '3px 0 0',
}
const controlStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 13,
  color: 'var(--fg)',
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  padding: '8px 10px',
}

export default function InjuriesSection() {
  const [injuries, setInjuries] = useState<Injury[]>([])
  const [showResolved, setShowResolved] = useState(false)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch('/api/gym/injuries')
    if (res.ok) {
      const data = (await res.json()) as { injuries: Injury[] }
      if (Array.isArray(data.injuries)) setInjuries(data.injuries)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const active = injuries.filter((i) => i.active)
  const resolved = injuries.filter((i) => !i.active)

  const create = useCallback(
    async (body: { region: InjurySite; severity: string; label: string; note: string }) => {
      setAdding(false)
      const res = await fetch('/api/gym/injuries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      await load()
      if (!res.ok) console.warn('[injuries] create failed')
    },
    [load],
  )

  const resolve = useCallback(
    async (id: string) => {
      // Optimistic: mark inactive locally, then persist.
      setInjuries((prev) => prev.map((i) => (i.id === id ? { ...i, active: false, resolvedAt: 'now' } : i)))
      const res = await fetch(`/api/gym/injuries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolve: true }),
      })
      if (!res.ok) await load()
    },
    [load],
  )

  const reopen = useCallback(
    async (id: string) => {
      setInjuries((prev) => prev.map((i) => (i.id === id ? { ...i, active: true, resolvedAt: null } : i)))
      const res = await fetch(`/api/gym/injuries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolve: false }),
      })
      if (!res.ok) await load()
    },
    [load],
  )

  // Severity was set-once: the row rendered a static pill, so an injury entered
  // as "out" could only be walked back by resolving or deleting it and adding it
  // again — losing its start date and note. The PATCH route already accepted
  // severity; only the control was missing.
  const changeSeverity = useCallback(
    async (id: string, severity: 'nagging' | 'limiting' | 'out') => {
      setInjuries((prev) => prev.map((i) => (i.id === id ? { ...i, severity } : i)))
      const res = await fetch(`/api/gym/injuries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ severity }),
      })
      if (!res.ok) await load()
    },
    [load],
  )

  const remove = useCallback(
    async (id: string) => {
      setInjuries((prev) => prev.filter((i) => i.id !== id))
      const res = await fetch(`/api/gym/injuries/${id}`, { method: 'DELETE' })
      if (!res.ok) await load()
    },
    [load],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <MonoLabel>Injuries</MonoLabel>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} style={addBtn} aria-label="Add injury">
            <Plus size={13} /> Add
          </button>
        )}
      </div>
      <p style={{ ...helpStyle, margin: 0 }}>
        Mark the injured site. Limiting/out excludes every catalog exercise that loads, supports, or bears weight through it.
        This conservative filter is not medical clearance.
      </p>

      {adding && <AddInjury onCancel={() => setAdding(false)} onCreate={create} />}

      {active.length === 0 && !adding && (
        <p style={{ ...helpStyle, margin: 0, fontStyle: 'italic' }}>No active injuries.</p>
      )}

      {active.map((inj) => (
        <InjuryRow
          key={inj.id}
          injury={inj}
          onResolve={() => resolve(inj.id)}
          onDelete={() => remove(inj.id)}
          onSeverityChange={(sev) => changeSeverity(inj.id, sev)}
        />
      ))}

      {resolved.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            style={resolvedToggle}
            aria-expanded={showResolved}
          >
            <ChevronDown
              size={13}
              style={{ transform: showResolved ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
            />
            {resolved.length} resolved
          </button>
          {showResolved &&
            resolved.map((inj) => (
              <InjuryRow
                key={inj.id}
                injury={inj}
                resolved
                onReopen={() => reopen(inj.id)}
                onDelete={() => remove(inj.id)}
              />
            ))}
        </div>
      )}
    </div>
  )
}

function InjuryRow({
  injury,
  resolved = false,
  onResolve,
  onReopen,
  onDelete,
  onSeverityChange,
}: {
  injury: Injury
  resolved?: boolean
  onResolve?: () => void
  onReopen?: () => void
  onDelete?: () => void
  /** Active rows only — resolved ones keep the static pill. */
  onSeverityChange?: (severity: 'nagging' | 'limiting' | 'out') => void
}) {
  return (
    <div style={{ ...injRow, opacity: resolved ? 0.6 : 1 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span style={labelStyle}>{injury.label?.trim() || INJURY_SITE_LABELS[injury.region]}</span>
          {injury.severity && !onSeverityChange && <SeverityPill severity={injury.severity} />}
        </div>
        <p style={{ ...helpStyle, margin: '2px 0 0' }}>
          {INJURY_SITE_LABELS[injury.region]}
          {injury.note ? ` — ${injury.note}` : ''}
        </p>
        {onSeverityChange && (
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }} role="group" aria-label="Severity">
            {SEVERITIES.map((s) => {
              const on = injury.severity === s.id
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => !on && onSeverityChange(s.id)}
                  title={s.help}
                  aria-pressed={on}
                  style={{
                    ...sevChipSmall,
                    color: on ? 'var(--accent-fg, var(--fg))' : 'var(--fg-muted)',
                    background: on ? 'var(--accent)' : 'var(--bg)',
                    borderColor: on ? 'var(--accent)' : 'var(--border-muted)',
                    cursor: on ? 'default' : 'pointer',
                  }}
                >
                  {s.label}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {!resolved && onResolve && (
          <button type="button" onClick={onResolve} style={smallBtn}>
            Resolve
          </button>
        )}
        {resolved && onReopen && (
          <button type="button" onClick={onReopen} style={smallBtn}>
            Reopen
          </button>
        )}
        <button type="button" onClick={onDelete} aria-label="Delete injury" style={iconBtn}>
          <X size={13} />
        </button>
      </div>
    </div>
  )
}

function SeverityPill({ severity }: { severity: 'nagging' | 'limiting' | 'out' }) {
  const tone =
    severity === 'out'
      ? 'var(--danger)'
      : severity === 'limiting'
        ? 'var(--warning, var(--accent))'
        : 'var(--fg-subtle)'
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 8.5,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: tone,
        border: `1px solid ${tone}`,
        borderRadius: 4,
        padding: '1px 5px',
      }}
    >
      {severity}
    </span>
  )
}

function AddInjury({
  onCancel,
  onCreate,
}: {
  onCancel: () => void
  onCreate: (body: { region: InjurySite; severity: string; label: string; note: string }) => void
}) {
  const [region, setRegion] = useState<InjurySite | null>(null)
  const [severity, setSeverity] = useState<'nagging' | 'limiting' | 'out'>('nagging')
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')

  return (
    <div style={addCard}>
      <span style={labelStyle}>Region</span>
      <div style={regionGrid}>
        {INJURY_SITES.map((r) => {
          const on = region === r
          return (
            <button
              key={r}
              type="button"
              onClick={() => setRegion(r)}
              aria-pressed={on}
              style={{
                ...regionChip,
                color: on ? 'var(--accent-fg, var(--fg))' : 'var(--fg-muted)',
                background: on ? 'var(--accent)' : 'var(--bg)',
                borderColor: on ? 'var(--accent)' : 'var(--border-muted)',
              }}
            >
              {INJURY_SITE_LABELS[r]}
            </button>
          )
        })}
      </div>

      <span style={{ ...labelStyle, marginTop: 4 }}>Severity</span>
      <div style={{ display: 'flex', gap: 6 }}>
        {SEVERITIES.map((s) => {
          const on = severity === s.id
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSeverity(s.id)}
              title={s.help}
              style={{
                ...sevBtn,
                color: on ? 'var(--accent-fg, var(--fg))' : 'var(--fg-muted)',
                background: on ? 'var(--accent)' : 'var(--bg)',
                borderColor: on ? 'var(--accent)' : 'var(--border-muted)',
              }}
            >
              {s.label}
            </button>
          )
        })}
      </div>

      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label (e.g. left knee)"
        aria-label="Injury label"
        style={{ ...controlStyle, marginTop: 4 }}
      />
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        aria-label="Injury note"
        style={controlStyle}
      />

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          type="button"
          disabled={!region}
          onClick={() => region && onCreate({ region, severity, label: label.trim(), note: note.trim() })}
          style={{ ...primaryBtn, opacity: region ? 1 : 0.5, cursor: region ? 'pointer' : 'not-allowed' }}
        >
          Add injury
        </button>
        <button type="button" onClick={onCancel} style={ghostBtn}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── styles ────────────────────────────────────────────────────────────────────
const addBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 9px',
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  background: 'transparent',
  border: '1px solid color-mix(in oklch, var(--accent) 35%, transparent)',
  borderRadius: 6,
  cursor: 'pointer',
}
const injRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 10,
  padding: '10px 12px',
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
}
const smallBtn: React.CSSProperties = {
  padding: '5px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  color: 'var(--fg-muted)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 7,
  cursor: 'pointer',
}
const iconBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  color: 'var(--fg-subtle)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 7,
  cursor: 'pointer',
}
const resolvedToggle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '4px 0',
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
}
const addCard: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
}
const regionGrid: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 5 }
const regionChip: React.CSSProperties = {
  padding: '5px 9px',
  fontFamily: 'var(--font-sans)',
  fontSize: 11.5,
  border: '1px solid var(--border-muted)',
  borderRadius: 999,
  cursor: 'pointer',
}
/** Row-level severity chips — same vocabulary as the add flow, sized to sit
 *  inside an existing injury row rather than a form. */
const sevChipSmall: React.CSSProperties = {
  padding: '3px 9px',
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  border: '1px solid var(--border-muted)',
  borderRadius: 6,
}
const sevBtn: React.CSSProperties = {
  flex: 1,
  padding: '7px 0',
  fontFamily: 'var(--font-sans)',
  fontSize: 12.5,
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  cursor: 'pointer',
}
const primaryBtn: React.CSSProperties = {
  padding: '8px 14px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--accent-fg, #fff)',
  background: 'var(--accent)',
  border: '1px solid var(--accent)',
  borderRadius: 8,
}
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: 'var(--fg-muted)',
  background: 'transparent',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  cursor: 'pointer',
}
