'use client'

/**
 * Gym settings sheet (GYM_PLAN §4). Wires the settled prefs to /api/gym/settings —
 * global unit, default rest, and linked habit — plus the P3 My-Gyms
 * editor + injuries list (mounted from ../settings).
 *
 * A slide-in right sheet with a scrim; Escape / scrim-click / the × close it.
 * Each field PATCHes on change (optimistic local state, then persist).
 */
import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'

import { GymsSection, InjuriesSection } from '@/components/gym/settings'

interface GymSettings {
  app_unit_system: 'imperial' | 'metric'
  app_weight_unit: 'lb' | 'kg'
  app_distance_unit: 'mi' | 'km'
  gym_weight_unit_override: 'lb' | 'kg' | null
  gym_distance_unit_override: 'mi' | 'km' | 'm' | 'yd' | null
  gym_default_unit: string | null
  gym_distance_unit: 'mi' | 'km' | 'm' | 'yd'
  gym_default_rest_seconds: number | null
  gym_timer_sound: string | null
  gym_linked_habit_id: string | null
}

interface HabitOption {
  id: string
  title: string
}

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--fg)',
  fontWeight: 500,
}

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

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
}

export default function GymSettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<GymSettings | null>(null)
  const [habits, setHabits] = useState<HabitOption[]>([])

  const load = useCallback(async () => {
    const [sRes, hRes] = await Promise.all([
      fetch('/api/gym/settings'),
      fetch('/api/habits'),
    ])
    if (sRes.ok) setSettings((await sRes.json()) as GymSettings)
    if (hRes.ok) {
      const rows = (await hRes.json()) as Array<{ id: string; title: string }>
      if (Array.isArray(rows)) setHabits(rows.map((r) => ({ id: r.id, title: r.title })))
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const patch = useCallback(async (body: Partial<GymSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...body } : prev))
    const res = await fetch('/api/gym/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) setSettings((await res.json()) as GymSettings)
  }, [])

  if (!open) return null

  const unit = settings?.gym_default_unit ?? 'lb'
  const distanceUnit = settings?.gym_distance_unit ?? 'mi'
  const rest = settings?.gym_default_rest_seconds ?? 120
  const linkedHabit = settings?.gym_linked_habit_id ?? ''

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Gym settings"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
    >
      {/* scrim */}
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)' }}
      />
      {/* panel */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(420px, 100%)',
          background: 'var(--bg-elevated)',
          borderLeft: '1px solid var(--border-muted)',
          padding: '20px 20px 32px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2
            style={{
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              fontWeight: 400,
              fontSize: 22,
              margin: 0,
              color: 'var(--fg)',
            }}
          >
            Gym settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              borderRadius: 8,
              border: '1px solid var(--border-muted)',
              background: 'var(--bg)',
              cursor: 'pointer',
            }}
          >
            <X size={15} color="var(--fg-muted)" />
          </button>
        </div>

        {/* Gym-only unit overrides */}
        <Row>
          <span style={labelStyle}>Gym load unit</span>
          <select
            aria-label="Gym load unit override"
            value={settings?.gym_weight_unit_override ?? 'app'}
            onChange={(event) => void patch({
              gym_weight_unit_override: event.target.value === 'app'
                ? null
                : event.target.value as 'lb' | 'kg',
            })}
            style={{ ...controlStyle, width: '100%', minHeight: 44 }}
          >
            <option value="app">Follow App Settings ({settings?.app_weight_unit ?? 'lb'})</option>
            <option value="lb">Pounds (lb)</option>
            <option value="kg">Kilograms (kg)</option>
          </select>
          <p style={helpStyle}>
            Gym only. The active logger, templates, history, records, and plate calculator use {unit}. This does not change Health or Nutrition.
          </p>
        </Row>

        <Row>
          <span style={labelStyle}>Gym distance &amp; pace</span>
          <select
            aria-label="Gym distance unit override"
            value={settings?.gym_distance_unit_override ?? 'app'}
            onChange={(event) => void patch({
              gym_distance_unit_override: event.target.value === 'app'
                ? null
                : event.target.value as 'mi' | 'km' | 'm' | 'yd',
            })}
            style={{ ...controlStyle, width: '100%', minHeight: 44 }}
          >
            <option value="app">Follow App Settings ({settings?.app_distance_unit ?? 'mi'})</option>
            <option value="mi">Miles · min/mi</option>
            <option value="km">Kilometres · min/km</option>
            <option value="m">Metres · min/km</option>
            <option value="yd">Yards · min/mi</option>
          </select>
          <p style={helpStyle}>
            Gym only. Cardio entries are stored canonically in metres, then entered and shown as {distanceUnit}; pace follows miles or kilometres when applicable.
          </p>
        </Row>

        {/* Default rest */}
        <Row>
          <span style={labelStyle}>Default rest timer</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="number"
              min={0}
              max={3600}
              step={5}
              value={rest}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) setSettings((p) => (p ? { ...p, gym_default_rest_seconds: n } : p))
              }}
              onBlur={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) void patch({ gym_default_rest_seconds: Math.max(0, Math.min(3600, Math.round(n))) })
              }}
              style={{ ...controlStyle, width: 90 }}
            />
            <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>seconds</span>
          </div>
          <p style={helpStyle}>Fallback rest between sets when a template or exercise doesn’t set its own.</p>
          <p style={helpStyle}>Keep your screen on during workouts for rest alerts.</p>
        </Row>

        {/* Linked habit */}
        <Row>
          <span style={labelStyle}>Linked habit</span>
          <select
            value={linkedHabit}
            onChange={(e) => void patch({ gym_linked_habit_id: e.target.value || null })}
            style={{ ...controlStyle, width: '100%' }}
          >
            <option value="">None</option>
            {habits.map((h) => (
              <option key={h.id} value={h.id}>
                {h.title}
              </option>
            ))}
          </select>
          <p style={helpStyle}>Auto-ticked when you finish a session with at least one working set.</p>
        </Row>

        {/* My Gyms editor (P3) */}
        <div style={sectionDivider}>
          <GymsSection />
        </div>

        {/* Injuries list (P3) */}
        <div style={sectionDivider}>
          <InjuriesSection />
        </div>
      </div>
    </div>
  )
}

const sectionDivider: React.CSSProperties = {
  borderTop: '1px solid var(--border-muted)',
  paddingTop: 18,
}
