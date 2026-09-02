'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock3, X } from 'lucide-react'

import { formatRest, isAmbiguousBareRest } from '@/lib/gym-client/rest-timer'

const PRESETS = [30, 60, 90, 120, 180] as const

/** Parse either raw seconds ("135") or min:sec ("2:15"). */
export function parseCustomRest(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  let seconds: number
  if (trimmed.includes(':')) {
    const match = /^(\d+):(\d{1,2})$/.exec(trimmed)
    if (!match) return undefined
    const minutes = Number(match[1])
    const remainder = Number(match[2])
    if (remainder >= 60) return undefined
    seconds = minutes * 60 + remainder
  } else {
    if (!/^\d+$/.test(trimmed)) return undefined
    seconds = Number(trimmed)
  }
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= 3600 ? seconds : undefined
}

export function SetRestPicker({
  setNumber,
  value,
  inheritedSeconds,
  onChange,
  onClose,
}: {
  setNumber: number
  value: number | null | undefined
  inheritedSeconds: number
  onChange: (seconds: number | null) => void
  onClose: () => void
}) {
  const [custom, setCustom] = useState(
    value != null && !PRESETS.includes(value as (typeof PRESETS)[number]) ? formatRest(value) : '',
  )
  const [invalid, setInvalid] = useState(false)
  const [ambiguous, setAmbiguous] = useState<number | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function choose(seconds: number | null) {
    onChange(seconds)
    onClose()
  }

  function saveCustom() {
    const seconds = parseCustomRest(custom)
    if (seconds == null) {
      setInvalid(true)
      return
    }
    if (isAmbiguousBareRest(custom, seconds)) {
      setAmbiguous(seconds)
      return
    }
    choose(seconds)
  }

  return createPortal(
    <div
      role="presentation"
      style={scrim}
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <section role="dialog" aria-modal="true" aria-labelledby="set-rest-title" style={sheet}>
        <div style={head}>
          <div>
            <span style={eyebrow}><Clock3 size={12} /> Set timer</span>
            <h2 id="set-rest-title" style={title}>Rest after set {setNumber}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close rest picker" style={closeBtn}>
            <X size={16} />
          </button>
        </div>

        <p style={help}>Inherit currently uses {formatRest(inheritedSeconds)} for this set.</p>

        <div style={presets} role="group" aria-label="Rest time presets">
          <button
            type="button"
            aria-pressed={value == null}
            onClick={() => choose(null)}
            style={presetBtn(value == null)}
          >
            <span>Inherit</span>
            <small>{formatRest(inheritedSeconds)}</small>
          </button>
          {PRESETS.map((seconds) => (
            <button
              key={seconds}
              type="button"
              aria-pressed={value === seconds}
              onClick={() => choose(seconds)}
              style={presetBtn(value === seconds)}
            >
              {formatRest(seconds)}
            </button>
          ))}
        </div>

        <div style={customRow}>
          <label style={{ flex: 1, minWidth: 0 }}>
            <span style={customLabel}>Custom seconds or min:sec</span>
            <input
              type="text"
              inputMode="numeric"
              value={custom}
              onChange={(event) => {
                setCustom(event.target.value)
                setInvalid(false)
                setAmbiguous(null)
              }}
              onKeyDown={(event) => event.key === 'Enter' && saveCustom()}
              onFocus={(event) => event.target.select()}
              enterKeyHint="done"
              placeholder="e.g. 135 or 2:15"
              aria-label="Custom rest time"
              aria-invalid={invalid}
              aria-describedby={
                invalid ? 'set-rest-error' : ambiguous != null ? 'set-rest-units' : undefined
              }
              style={{ ...customInput, borderColor: invalid ? 'var(--danger)' : 'var(--border-muted)' }}
            />
          </label>
          <button type="button" onClick={saveCustom} style={saveBtn}>Set</button>
        </div>
        {invalid && <p id="set-rest-error" role="alert" style={errorText}>Use seconds or min:sec, up to 60:00.</p>}
        {ambiguous != null && (
          <div role="group" aria-label="Confirm rest units">
            <p id="set-rest-units" role="alert" style={errorText}>
              {ambiguous} seconds is barely a pause — did you mean {ambiguous}:00?
            </p>
            <div style={presets}>
              <button type="button" onClick={() => choose(ambiguous * 60)} style={presetBtn(true)}>
                {formatRest(ambiguous * 60)}
                <small>minutes</small>
              </button>
              <button type="button" onClick={() => choose(ambiguous)} style={presetBtn(false)}>
                {ambiguous}s
                <small>seconds</small>
              </button>
            </div>
          </div>
        )}
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
  alignItems: 'center',
  justifyContent: 'center',
  padding: '16px max(12px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left))',
  background: 'color-mix(in oklch, var(--bg) 58%, transparent)',
  backdropFilter: 'blur(2px)',
}
const sheet: React.CSSProperties = { width: 'min(420px, 100%)', padding: 16, borderRadius: 16, border: '1px solid var(--border)', background: 'var(--bg)', boxShadow: 'var(--shadow-floating, 0 18px 60px rgba(0,0,0,.45))' }
const head: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }
const eyebrow: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--accent)' }
const title: React.CSSProperties = { margin: '4px 0 0', fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontWeight: 400, fontSize: 21, color: 'var(--fg)' }
const closeBtn: React.CSSProperties = { width: 34, height: 34, display: 'grid', placeItems: 'center', flexShrink: 0, borderRadius: 9, border: '1px solid var(--border-muted)', background: 'var(--bg-elevated)', color: 'var(--fg-muted)', cursor: 'pointer' }
const help: React.CSSProperties = { margin: '10px 0 13px', fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-subtle)' }
const presets: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 7 }
const presetBtn = (active: boolean): React.CSSProperties => ({ minHeight: 44, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, padding: '7px 8px', borderRadius: 9, border: `1px solid ${active ? 'var(--accent)' : 'var(--border-muted)'}`, background: active ? 'color-mix(in oklch, var(--accent) 12%, var(--bg-elevated))' : 'var(--bg-elevated)', color: active ? 'var(--accent)' : 'var(--fg-muted)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' })
const customRow: React.CSSProperties = { display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--border-muted)' }
const customLabel: React.CSSProperties = { display: 'block', marginBottom: 5, fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--fg-subtle)' }
const customInput: React.CSSProperties = { width: '100%', height: 42, boxSizing: 'border-box', padding: '0 10px', border: '1px solid var(--border-muted)', borderRadius: 9, outline: 'none', background: 'var(--bg-elevated)', color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 14 }
const saveBtn: React.CSSProperties = { minWidth: 64, height: 42, border: 'none', borderRadius: 9, background: 'var(--accent)', color: 'var(--accent-fg)', fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 650, cursor: 'pointer' }
const errorText: React.CSSProperties = { margin: '7px 0 0', fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--danger)' }
