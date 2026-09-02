'use client'

/**
 * GymsSection (GYM_PLAN §4 settings sheet — "My Gyms") — the per-gym equipment
 * editor inside the Gym settings sheet. Gym cards (name, default star, equipment
 * summary); an editor (name + FEDB equipment checklist + free-text machines chips +
 * notes + set-default). Exactly one default is enforced server-side (setting one
 * clears the others transactionally); the UI mirrors optimistically.
 */
import { useCallback, useEffect, useState } from 'react'
import { Plus, Star, X } from 'lucide-react'

import { MonoLabel } from '@/components/health/primitives'

interface GymEquipment {
  categories: string[]
  machines: string[]
  machines_excluded: string[]
}
interface Gym {
  id: string
  name: string
  equipment: GymEquipment
  notes: string | null
  isDefault: boolean
}

const EMPTY_EQUIP: GymEquipment = { categories: [], machines: [], machines_excluded: [] }

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

export default function GymsSection() {
  const [gyms, setGyms] = useState<Gym[]>([])
  const [vocab, setVocab] = useState<string[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch('/api/gym/gyms')
    if (res.ok) {
      const data = (await res.json()) as { gyms: Gym[]; equipmentVocab: string[] }
      if (Array.isArray(data.gyms)) setGyms(data.gyms)
      if (Array.isArray(data.equipmentVocab)) setVocab(data.equipmentVocab)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setDefault = useCallback(
    async (id: string) => {
      setGyms((prev) => prev.map((g) => ({ ...g, isDefault: g.id === id })))
      const res = await fetch(`/api/gym/gyms/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      })
      if (!res.ok) await load()
    },
    [load],
  )

  const remove = useCallback(
    async (id: string) => {
      setGyms((prev) => prev.filter((g) => g.id !== id))
      const res = await fetch(`/api/gym/gyms/${id}`, { method: 'DELETE' })
      await load() // reload — a default delete promotes another
      if (!res.ok) console.warn('[gyms] delete failed')
    },
    [load],
  )

  const save = useCallback(
    async (id: string | null, body: Partial<Gym> & { name: string }) => {
      const path = id ? `/api/gym/gyms/${id}` : '/api/gym/gyms'
      const res = await fetch(path, {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setEditingId(null)
      setCreating(false)
      await load()
      if (!res.ok) console.warn('[gyms] save failed')
    },
    [load],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <MonoLabel>My gyms</MonoLabel>
        {!creating && (
          <button type="button" onClick={() => setCreating(true)} style={addBtn} aria-label="Add gym">
            <Plus size={13} /> Add
          </button>
        )}
      </div>
      <p style={{ ...helpStyle, margin: 0 }}>
        Your gym&rsquo;s equipment filters exercise swaps + drafts to what you can actually use.
      </p>

      {creating && (
        <GymEditor vocab={vocab} onCancel={() => setCreating(false)} onSave={(body) => save(null, body)} />
      )}

      {gyms.length === 0 && !creating && (
        <p style={{ ...helpStyle, margin: 0, fontStyle: 'italic' }}>No gyms yet.</p>
      )}

      {gyms.map((g) =>
        editingId === g.id ? (
          <GymEditor
            key={g.id}
            gym={g}
            vocab={vocab}
            onCancel={() => setEditingId(null)}
            onSave={(body) => save(g.id, body)}
          />
        ) : (
          <GymCard
            key={g.id}
            gym={g}
            onEdit={() => setEditingId(g.id)}
            onSetDefault={() => setDefault(g.id)}
            onDelete={() => remove(g.id)}
          />
        ),
      )}
    </div>
  )
}

function GymCard({
  gym,
  onEdit,
  onSetDefault,
  onDelete,
}: {
  gym: Gym
  onEdit: () => void
  onSetDefault: () => void
  onDelete: () => void
}) {
  const equipCount = gym.equipment.categories.length + gym.equipment.machines.length
  return (
    <div style={gymCard}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <button
            type="button"
            onClick={onSetDefault}
            aria-label={gym.isDefault ? 'Default gym' : 'Set as default gym'}
            style={starBtn}
            title={gym.isDefault ? 'Default gym' : 'Set as default'}
          >
            <Star
              size={14}
              fill={gym.isDefault ? 'var(--accent)' : 'none'}
              color={gym.isDefault ? 'var(--accent)' : 'var(--fg-subtle)'}
            />
          </button>
          <button type="button" onClick={onEdit} style={gymNameBtn}>
            {gym.name}
          </button>
        </div>
        <p style={{ ...helpStyle, margin: '3px 0 0' }}>
          {equipCount > 0 ? `${equipCount} equipment` : 'No equipment listed'}
          {gym.equipment.machines_excluded.length > 0
            ? ` · ${gym.equipment.machines_excluded.length} excluded`
            : ''}
        </p>
      </div>
      <button type="button" onClick={onDelete} aria-label={`Delete ${gym.name}`} style={iconBtn}>
        <X size={13} />
      </button>
    </div>
  )
}

function GymEditor({
  gym,
  vocab,
  onCancel,
  onSave,
}: {
  gym?: Gym
  vocab: string[]
  onCancel: () => void
  onSave: (body: { name: string; equipment: GymEquipment; notes: string | null }) => void
}) {
  const [name, setName] = useState(gym?.name ?? '')
  const [categories, setCategories] = useState<string[]>(gym?.equipment.categories ?? [])
  const [machines, setMachines] = useState<string[]>(gym?.equipment.machines ?? [])
  const [machinesExcluded] = useState<string[]>(gym?.equipment.machines_excluded ?? [])
  const [notes, setNotes] = useState(gym?.notes ?? '')
  const [machineDraft, setMachineDraft] = useState('')

  const toggleCat = (c: string) =>
    setCategories((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))

  const addMachine = () => {
    const v = machineDraft.trim()
    if (v && !machines.some((m) => m.toLowerCase() === v.toLowerCase())) {
      setMachines((prev) => [...prev, v])
    }
    setMachineDraft('')
  }

  return (
    <div style={editorCard}>
      <span style={labelStyle}>Name</span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Gym name"
        aria-label="Gym name"
        style={controlStyle}
      />

      <span style={{ ...labelStyle, marginTop: 4 }}>Equipment</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {vocab.map((c) => {
          const on = categories.includes(c)
          return (
            <button
              key={c}
              type="button"
              onClick={() => toggleCat(c)}
              aria-pressed={on}
              style={{
                ...equipChip,
                color: on ? 'var(--accent-fg, var(--fg))' : 'var(--fg-muted)',
                background: on ? 'var(--accent)' : 'var(--bg)',
                borderColor: on ? 'var(--accent)' : 'var(--border-muted)',
              }}
            >
              {c}
            </button>
          )
        })}
      </div>

      <span style={{ ...labelStyle, marginTop: 4 }}>Machines</span>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={machineDraft}
          onChange={(e) => setMachineDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addMachine()
            }
          }}
          placeholder="e.g. Hammer Strength Row"
          aria-label="Add machine"
          style={{ ...controlStyle, flex: 1 }}
        />
        <button type="button" onClick={addMachine} style={smallBtn}>
          Add
        </button>
      </div>
      {machines.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {machines.map((m) => (
            <span key={m} style={machineTag}>
              {m}
              <button
                type="button"
                onClick={() => setMachines((prev) => prev.filter((x) => x !== m))}
                aria-label={`Remove ${m}`}
                style={tagX}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <span style={{ ...labelStyle, marginTop: 4 }}>Notes</span>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        aria-label="Gym notes"
        rows={2}
        style={{ ...controlStyle, resize: 'vertical' }}
      />

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() =>
            onSave({
              name: name.trim(),
              equipment: { categories, machines, machines_excluded: machinesExcluded },
              notes: notes.trim() || null,
            })
          }
          style={{
            ...primaryBtn,
            opacity: name.trim() ? 1 : 0.5,
            cursor: name.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          {gym ? 'Save' : 'Add gym'}
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
const gymCard: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 10,
  padding: '10px 12px',
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
}
const starBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  flexShrink: 0,
}
const gymNameBtn: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 16,
  color: 'var(--fg)',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left',
  minWidth: 0,
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
  flexShrink: 0,
}
const editorCard: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
}
const equipChip: React.CSSProperties = {
  padding: '5px 9px',
  fontFamily: 'var(--font-sans)',
  fontSize: 11.5,
  border: '1px solid var(--border-muted)',
  borderRadius: 999,
  cursor: 'pointer',
}
const smallBtn: React.CSSProperties = {
  padding: '8px 12px',
  fontFamily: 'var(--font-sans)',
  fontSize: 12.5,
  color: 'var(--fg-muted)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  cursor: 'pointer',
  flexShrink: 0,
}
const machineTag: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '4px 6px 4px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  color: 'var(--fg-muted)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 999,
}
const tagX: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 16,
  height: 16,
  color: 'var(--fg-subtle)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
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
