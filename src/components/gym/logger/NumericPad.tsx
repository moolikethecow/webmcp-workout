'use client'

/**
 * NumericPad + NumericPadHost (GYM_PLAN §4 — the ergonomics centerpiece). The OS
 * keyboard is the wrong tool at the gym: readOnly inputs (inputMode='none') open
 * THIS bottom-sheet pad instead. The host is mounted ONCE by the provider (portal
 * host); any field opens it via usePad().open(request).
 *
 * The pad:
 *   - big digit grid (0-9), decimal, backspace — ≥48px touch targets, ≤45vh
 *   - unit-aware plate steppers on weight fields (+2.5/+5/+10 lb, +1.25/+2.5/+5 kg)
 *   - +1/−1 on reps
 *   - RPE quick-row (6·6.5·…·10, toggleable off) on weight/rep tracks
 *   - Next  → commit the current field + advance focus to the next uncompleted
 *             field (weight→reps→next row weight…); the LAST field's Next
 *             completes the set (= ✓)
 *   - Done  → commit + close
 *
 * Every keystroke writes through updateSetField (optimistic; the queue debounces).
 * For a `durationS` field the digits are entered as mm:ss and parsed on write.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Delete, Layers } from 'lucide-react'

import { useActiveWorkoutStore } from '@/lib/gym-client/active-workout-store'
import type { SetField, Unit } from '@/lib/gym-client/active-types'
import { computePlates, formatPlateLabel, isBarbellExercise } from '@/lib/gym-client/plate-calc'
import { convertWeight } from '@/lib/units/weight'
import { distanceToMeters, metersToDistance, type DistanceUnit } from '@/lib/units/system'
import { PadProvider, type PadController, type PadRequest, type PadTarget } from './pad-context'
import { PLATE_STEPS, RPE_VALUES, secToMmss, trimNum } from './format'

/** Provider that owns the pad controller + renders the single host portal. */
export function NumericPadHost({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<PadRequest | null>(null)
  const [index, setIndex] = useState(0) // position in the auto-advance chain

  const open = useCallback((req: PadRequest) => {
    setRequest(req)
    setIndex(0)
  }, [])
  const close = useCallback(() => setRequest(null), [])

  const current: PadTarget | null = request ? (request.chain[index] ?? request.target) : null

  const controller: PadController = useMemo(
    () => ({
      open,
      close,
      active: current ? { clientSetId: current.clientSetId, field: current.field } : null,
    }),
    [open, close, current],
  )

  return (
    <PadProvider value={controller}>
      {children}
      {request && current && (
        <PadSheet
          request={request}
          index={index}
          current={current}
          onAdvance={setIndex}
          onClose={close}
        />
      )}
    </PadProvider>
  )
}

function PadSheet({
  request,
  index,
  current,
  onAdvance,
  onClose,
}: {
  request: PadRequest
  index: number
  current: PadTarget
  onAdvance: (i: number) => void
  onClose: () => void
}) {
  const store = useActiveWorkoutStore()
  const { updateSetField, completeSet, setSetWeightUnit } = store

  // The raw digit buffer for the current field ("" = untouched → shows ghost).
  const [buffer, setBuffer] = useState('')
  const [platesOpen, setPlatesOpen] = useState(false)
  // A field opened WITH an existing value starts "pristine": the first digit
  // replaces the whole value instead of appending to it (calculator-entry
  // convention — tapping a "12" reps cell and typing 9 must yield 9, not 129).
  // Backspace/steppers edit the existing value and clear pristine.
  const pristine = useRef(false)

  // Reset the buffer to the live value whenever the focused field changes.
  const exercise = useMemo(
    () => store.workout?.exercises.find((e) => e.workoutExerciseId === current.workoutExerciseId) ?? null,
    [store.workout, current],
  )
  const set = useMemo(
    () => exercise?.sets.find((s) => s.clientSetId === current.clientSetId) ?? null,
    [exercise, current],
  )
  const showPlates =
    current.field === 'weight' &&
    isBarbellExercise({
      name: exercise?.name,
      // equipment/category ride along when the read model carries them; best-effort.
      equipment: (exercise as { equipment?: string | null } | null)?.equipment,
      category: (exercise as { category?: string | null } | null)?.category,
    })

  useEffect(() => {
    const live = liveFieldValue(set, current.field)
    setBuffer(initialPadBuffer(current.field, live, set?.weightUnit, request.unit, request.distanceUnit ?? 'm'))
    pristine.current = live != null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key on the focused target
  }, [current.clientSetId, current.field, request.unit, request.distanceUnit])

  const isLast = index >= request.chain.length - 1
  const isWeight = current.field === 'weight'
  const isReps = current.field === 'reps'
  const isDuration = current.field === 'durationS'

  /** Parse the current buffer → the numeric value to persist (mm:ss for duration). */
  const parseBuffer = useCallback(
    (raw: string): number | null => {
      if (raw === '' || raw === '.' || raw === ':') return null
      if (isDuration) return parseMmss(raw)
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    },
    [isDuration],
  )

  /** Write the buffer to the store (optimistic; queue debounces). A weight typed
   *  under a display-unit toggle is recorded IN that unit (stored-as-entered). */
  const writeBuffer = useCallback(
    (raw: string) => {
      const val = parseBuffer(raw)
      if (isWeight && val != null) setSetWeightUnit(current.clientSetId, request.unit)
      const stored = current.field === 'distanceM' && val != null
        ? distanceToMeters(val, request.distanceUnit ?? 'm')
        : val
      updateSetField(current.clientSetId, current.field, stored)
    },
    [updateSetField, setSetWeightUnit, current, parseBuffer, isWeight, request.unit, request.distanceUnit],
  )

  const push = useCallback(
    (ch: string) => {
      setBuffer((b) => {
        const base = pristine.current ? '' : b
        // Single decimal only; digits pass through.
        if (ch === '.' && (base.includes('.') || isReps || isDuration)) return b
        if (ch === ':' && (!isDuration || base.includes(':'))) return b
        pristine.current = false
        const next = base + ch
        writeBuffer(next)
        return next
      })
    },
    [isReps, isDuration, writeBuffer],
  )

  const backspace = useCallback(() => {
    setBuffer((b) => {
      pristine.current = false
      const next = b.slice(0, -1)
      writeBuffer(next)
      return next
    })
  }, [writeBuffer])

  const step = useCallback(
    (delta: number) => {
      setBuffer((b) => {
        pristine.current = false
        const base = parseBuffer(b) ?? current.ghost ?? 0
        const next = Math.max(0, Math.round((base + delta) * 100) / 100)
        const raw = String(next)
        if (isWeight) setSetWeightUnit(current.clientSetId, request.unit)
        updateSetField(current.clientSetId, current.field, next)
        return raw
      })
    },
    [parseBuffer, current, updateSetField, isWeight, setSetWeightUnit, request.unit],
  )

  const setRpe = useCallback(
    (v: number | null) => {
      updateSetField(current.clientSetId, 'rpe', v)
    },
    [updateSetField, current.clientSetId],
  )

  /** Commit the current field. If the buffer is empty, commit the ghost so a
   *  bare Next/Done still records the placeholder (Strong's one-tap). */
  const commit = useCallback(() => {
    if (buffer === '' && current.ghost != null) {
      if (isWeight) setSetWeightUnit(current.clientSetId, request.unit)
      const storedGhost = current.field === 'distanceM'
        ? distanceToMeters(current.ghost, request.distanceUnit ?? 'm')
        : current.ghost
      updateSetField(current.clientSetId, current.field, storedGhost)
    }
  }, [buffer, current, updateSetField, isWeight, setSetWeightUnit, request.unit, request.distanceUnit])

  const next = useCallback(() => {
    commit()
    if (isLast) {
      // Last field → completing the set (= ✓).
      completeSet(current.workoutExerciseId, current.clientSetId)
      onClose()
    } else {
      onAdvance(index + 1)
    }
  }, [commit, isLast, completeSet, current, onClose, onAdvance, index])

  const done = useCallback(() => {
    commit()
    onClose()
  }, [commit, onClose])

  // Live display string (buffer, or the ghost as grey placeholder).
  const display = buffer !== '' ? formatDisplay(current.field, buffer) : ''
  const ghostDisplay = current.ghost != null ? formatDisplay(current.field, rawFor(current.field, current.ghost)) : ''

  const rpeValue = set?.rpe ?? null
  const showRpe = request.showRpe && (isWeight || isReps)

  return createPortal(
    <div style={scrim} onClick={(e) => e.target === e.currentTarget && done()}>
      <div role="dialog" aria-label="Numeric pad" style={sheet} className="gym-pad">
        <style>{PAD_CSS}</style>

        {/* readout */}
        <div style={readout}>
          <span style={readoutLabel}>
            {fieldLabel(
              current.field,
              request.distanceUnit ?? 'm',
              exercise?.modality === 'strength' && exercise.loadBasis === 'per_side',
            )}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {showPlates && (
              <button
                type="button"
                onClick={() => setPlatesOpen((v) => !v)}
                aria-label="Plate calculator"
                aria-expanded={platesOpen}
                style={platesBtn}
              >
                <Layers size={13} strokeWidth={1.9} /> Plates
              </button>
            )}
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 26, fontWeight: 700, color: 'var(--fg)' }}>
              {display || <span style={{ color: 'var(--fg-subtle)' }}>{ghostDisplay || '—'}</span>}
            </span>
            {/* Always-visible dismissal — commits and closes, same as Done. */}
            <button type="button" onClick={done} aria-label="Hide keypad" style={padCloseBtn}>
              <ChevronDown size={18} strokeWidth={2} />
            </button>
          </span>
        </div>

        {/* plate calculator mini-panel */}
        {showPlates && platesOpen && (
          <PlatePanel target={parseBuffer(buffer) ?? current.ghost ?? null} unit={request.unit} />
        )}

        {/* steppers — decrement left, increment right (standard convention);
            both share one neutral style so neither reads as "red = bad". */}
        {isWeight && (
          <div style={stepperRow} aria-label="Weight steppers">
            {PLATE_STEPS[request.unit].map((s) => (
              <button key={`-${s}`} type="button" onClick={() => step(-s)} style={stepperBtn}>
                −{trimNum(s)}
              </button>
            ))}
            {PLATE_STEPS[request.unit].map((s) => (
              <button key={`+${s}`} type="button" onClick={() => step(s)} style={stepperBtn}>
                +{trimNum(s)}
              </button>
            ))}
          </div>
        )}
        {isReps && (
          <div style={stepperRow} aria-label="Rep steppers">
            <button type="button" onClick={() => step(-1)} style={stepperBtn}>
              −1
            </button>
            <button type="button" onClick={() => step(1)} style={stepperBtn}>
              +1
            </button>
          </div>
        )}

        {/* RPE quick-row */}
        {showRpe && (
          <div>
            <span style={rpeLabel}>RPE{rpeValue != null ? ` · ${trimNum(rpeValue)}` : ''}</span>
            <div style={rpeRow} aria-label="RPE">
              {RPE_VALUES.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => (rpeValue === v ? setRpe(null) : setRpe(v))}
                  aria-pressed={rpeValue === v}
                  style={{
                    ...rpeBtn,
                    background: rpeValue === v ? 'var(--accent)' : 'var(--bg-elevated)',
                    color: rpeValue === v ? 'var(--accent-fg)' : 'var(--fg-muted)',
                    borderColor: rpeValue === v ? 'var(--accent)' : 'var(--border-muted)',
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* digit grid */}
        <div style={digitGrid}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} type="button" onClick={() => push(d)} style={digitBtn} aria-label={`Digit ${d}`}>
              {d}
            </button>
          ))}
          <button type="button" onClick={() => push(isDuration ? ':' : '.')} style={digitBtn} aria-label={isDuration ? 'Minutes separator' : 'Decimal'}>
            {isDuration ? ':' : '.'}
          </button>
          <button type="button" onClick={() => push('0')} style={digitBtn} aria-label="Digit 0">
            0
          </button>
          <button type="button" onClick={backspace} style={digitBtn} aria-label="Backspace">
            <Delete size={18} strokeWidth={1.8} />
          </button>
        </div>

        {/* commit row */}
        <div style={commitRow}>
          <button type="button" onClick={done} style={doneBtn} aria-label="Done">
            Done
          </button>
          <button type="button" onClick={next} style={nextBtn} aria-label={isLast ? 'Complete set' : 'Next field'}>
            {isLast ? 'Complete ✓' : 'Next'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── plate calculator panel ─────────────────────────────────────────────────────

function PlatePanel({ target, unit }: { target: number | null; unit: 'lb' | 'kg' }) {
  if (target == null || target <= 0) {
    return <div style={platePanel}>Enter a weight to see the plate breakdown.</div>
  }
  const b = computePlates(target, unit)
  return (
    <div style={platePanel} aria-label="Plate breakdown">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={plateBar}>bar {trimNum(b.barWeight)}{unit}</span>
        {b.perSide.length > 0 ? (
          b.perSide.map((p, i) => (
            <span key={i} style={plateChip}>
              {trimNum(p)}
            </span>
          ))
        ) : (
          <span style={{ color: 'var(--fg-subtle)', fontSize: 12 }}>—</span>
        )}
      </div>
      <div style={plateLabelLine}>{formatPlateLabel(b, unit)}</div>
    </div>
  )
}

// ── field value helpers ───────────────────────────────────────────────────────

function liveFieldValue(
  set: { weight: number | null; reps: number | null; durationS: number | null; distanceM: number | null; rpe: number | null } | null,
  field: SetField,
): number | null {
  if (!set) return null
  switch (field) {
    case 'weight':
      return set.weight
    case 'reps':
      return set.reps
    case 'durationS':
      return set.durationS
    case 'distanceM':
      return set.distanceM
    case 'rpe':
      return set.rpe
  }
}

/** Seed the editable buffer in the unit shown by the logger. Gym rows remain
 * stored-as-entered, so a 220 lb set opened while viewing kg must start at
 * 99.79—not 220—before the first keypad edit changes its stored unit. */
export function initialPadBuffer(
  field: SetField,
  value: number | null,
  storedWeightUnit: unknown,
  displayWeightUnit: Unit,
  distanceUnit: DistanceUnit = 'm',
): string {
  if (value == null) return ''
  const displayValue =
    field === 'weight'
      ? convertWeight(value, storedWeightUnit === 'kg' ? 'kg' : 'lb', displayWeightUnit)
      : field === 'distanceM'
        ? metersToDistance(value, distanceUnit)
      : value
  return displayValue == null ? '' : rawFor(field, displayValue)
}

/** The raw editable-buffer string for a numeric value (mm:ss for duration). */
function rawFor(field: SetField, value: number): string {
  if (field === 'durationS') return secToMmss(value)
  return trimNum(value)
}

/** The pretty display of the buffer (duration buffers are shown verbatim, e.g. "1:3"). */
function formatDisplay(_field: SetField, raw: string): string {
  return raw
}

/** Parse "mm:ss" or a bare seconds string → total seconds. */
function parseMmss(raw: string): number | null {
  if (raw.includes(':')) {
    const [m, s] = raw.split(':')
    const mins = Number(m || '0')
    const secs = Number(s || '0')
    if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null
    return mins * 60 + secs
  }
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function fieldLabel(field: SetField, distanceUnit: DistanceUnit = 'm', perSide = false): string {
  switch (field) {
    case 'weight':
      return perSide ? 'Weight / side' : 'Weight'
    case 'reps':
      return 'Reps'
    case 'durationS':
      return 'Time (mm:ss)'
    case 'distanceM':
      return `Distance (${distanceUnit})`
    case 'rpe':
      return 'RPE'
  }
}

// ── styles ────────────────────────────────────────────────────────────────────
// Desktop default: a centered floating card (plenty of vertical room, so no
// height cap is needed). Mobile (<=700px, matching the breakpoint used by the
// other gym sheets) keeps the original thumb-reachable bottom sheet, capped to
// 45vh so the field being edited stays visible above it.
const PAD_CSS = `
.gym-pad {
  position: fixed;
  z-index: 81;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(520px, 92vw);
  max-height: 88vh;
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow-floating, 0 12px 48px rgba(0,0,0,.5));
  animation: gym-pad-in .18s cubic-bezier(.16,1,.3,1);
}
@keyframes gym-pad-in { from { opacity: .7; transform: translate(-50%, calc(-50% + 16px)); } to { opacity: 1; transform: translate(-50%, -50%); } }
@media (max-width: 700px) {
  .gym-pad {
    left: 0;
    right: 0;
    top: auto;
    bottom: 0;
    transform: none;
    width: 100%;
    max-height: 45vh;
    border-bottom: none;
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -12px 40px rgba(0,0,0,.34);
    animation: gym-pad-up .18s cubic-bezier(.16,1,.3,1);
  }
  @keyframes gym-pad-up { from { transform: translateY(30px); opacity: .7; } to { transform: none; opacity: 1; } }
}
@media (prefers-reduced-motion: reduce) { .gym-pad { animation: none; } }
`
const scrim: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 80,
  background: 'color-mix(in oklch, var(--bg) 30%, transparent)',
}
const sheet: React.CSSProperties = {
  overflowY: 'auto',
  boxSizing: 'border-box',
  background: 'var(--bg)',
  padding: '12px 12px calc(12px + env(safe-area-inset-bottom, 0px))',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}
const readout: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  padding: '2px 6px 6px',
}
const readoutLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const stepperRow: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
}
const stepperBtn: React.CSSProperties = {
  flex: 1,
  minWidth: 52,
  height: 40,
  borderRadius: 8,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-elevated)',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
}
const rpeLabel: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  padding: '0 6px 4px',
}
const rpeRow: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  overflowX: 'auto',
  paddingBottom: 2,
}
const rpeBtn: React.CSSProperties = {
  flexShrink: 0,
  minWidth: 40,
  height: 34,
  borderRadius: 8,
  border: '1px solid var(--border-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  cursor: 'pointer',
}
const digitGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 6,
}
const digitBtn: React.CSSProperties = {
  height: 48,
  borderRadius: 10,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-elevated)',
  color: 'var(--fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 20,
  fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const commitRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 2fr',
  gap: 8,
  marginTop: 2,
}
const doneBtn: React.CSSProperties = {
  height: 48,
  borderRadius: 10,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-elevated)',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  letterSpacing: '0.04em',
  cursor: 'pointer',
}
const nextBtn: React.CSSProperties = {
  height: 48,
  borderRadius: 10,
  border: 'none',
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
  fontFamily: 'var(--font-sans)',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
}
const padCloseBtn: React.CSSProperties = {
  width: 38,
  height: 32,
  borderRadius: 8,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-elevated)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const platesBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 26,
  padding: '0 9px',
  borderRadius: 7,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-elevated)',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  letterSpacing: '0.04em',
  cursor: 'pointer',
}
const platePanel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '9px 10px',
  borderRadius: 10,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--fg-muted)',
}
const plateBar: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const plateChip: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 34,
  height: 28,
  padding: '0 8px',
  borderRadius: 6,
  background: 'color-mix(in oklch, var(--accent) 12%, var(--bg))',
  border: '1px solid color-mix(in oklch, var(--accent) 35%, transparent)',
  color: 'var(--fg)',
  fontSize: 13,
  fontWeight: 700,
}
const plateLabelLine: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-subtle)',
}
