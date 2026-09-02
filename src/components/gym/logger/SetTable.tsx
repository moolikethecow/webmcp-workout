'use client'

/**
 * SetTable (GYM_PLAN §4, §3a) — the per-exercise set rows, adapted to the
 * exercise's `tracks` shape. Columns per shape:
 *   weight_reps          set# | previous | weight | reps | ✓
 *   weighted_bodyweight  same, "+" prefix on the weight column
 *   assisted_bodyweight  same, "−" prefix (assistance; stored positive)
 *   reps                 set# | previous | reps | ✓
 *   time                 set# | previous | (weight?) | mm:ss | ✓
 *   distance_time        set# | previous | distance | mm:ss | ✓
 *
 * Ghost-commit: an untouched row shows the ghost (previous, else target) as the
 * input PLACEHOLDER; ✓ commits those ghosts as the set's real values (the store
 * does the commit — this table just fires completeSet). The set-number tap opens
 * a small tag menu (Warm-up/Drop/Failure/Clear); a tag renders as a W/D/F chip
 * replacing the number. Row delete: swipe-left (touch) or an × (pointer).
 *
 * Numeric inputs are readOnly (inputMode='none') — tapping one opens the shared
 * NumericPad (usePad) rather than the OS keyboard.
 */

import { Fragment, useRef, useState } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Check, Clock3, X } from 'lucide-react'

import { ghostFor, ghostSourcesFor, logicalSetNumber } from '@/lib/gym-client/active-workout-store'
import type { ActiveExercise, ActiveSet, SetField, SetType, Unit } from '@/lib/gym-client/active-types'
import { convertWeight, formatRest, restSecondsForSet } from '@/lib/gym-client/rest-timer'
import { formatPace, metersToDistance, paceBasisForDistanceUnit } from '@/lib/units/system'
import { usePad, type PadTarget } from './pad-context'
import { useUnitDisplay } from './unit-context'
import { previousText, secToMmss, targetHint, trimNum, metersLabel } from './format'
import { SetRestPicker } from './SetRestPicker'

const SET_TYPE_CHIP: Record<Exclude<SetType, 'normal'>, { short: string; color: string; label: string }> = {
  warmup: { short: 'W', color: 'var(--warning)', label: 'Warm-up' },
  drop: { short: 'D', color: 'var(--violet, #a78bfa)', label: 'Drop' },
  failure: { short: 'F', color: 'var(--danger)', label: 'Failure' },
}

function TargetHint({ hint }: { hint: string }) {
  const target = hint.replace('→ ', '')
  const description = target.startsWith('×')
    ? `Programmed target for this set: ${target.slice(1)} reps.`
    : `Programmed target for this set: ${target}.`

  return (
    <Tooltip.Provider delayDuration={180}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span style={targetLine}>
            {hint}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content sideOffset={6} style={targetTooltip}>
            {description}
            <Tooltip.Arrow style={{ fill: 'var(--border)' }} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

/** The ordered fields a tracks shape edits (drives columns + auto-advance chain). */
function editableFields(tracks: string): SetField[] {
  switch (tracks) {
    case 'weight_reps':
    case 'weighted_bodyweight':
    case 'assisted_bodyweight':
      return ['weight', 'reps']
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

/** Whether a tracks shape pairs weight+reps as adjacent fields — these get a "×"
 *  separator between them (weight × reps) instead of a bare gap. */
function pairsWeightReps(tracks: string): boolean {
  return tracks !== 'reps' && tracks !== 'time' && tracks !== 'distance_time'
}

/** Whether the `time` shape should show its optional weight column (any set has weight). */
function timeShowsWeight(ex: ActiveExercise): boolean {
  return ex.tracks === 'time' && ex.sets.some((s) => s.weight != null && s.weight > 0)
}

const WEIGHT_PREFIX: Record<string, string> = {
  weighted_bodyweight: '+',
  assisted_bodyweight: '−',
}

export function SetTable({
  exercise,
  onCompleteSet,
  onDeleteSet,
  onCycleSetType,
  onUpdateSetRest,
  buildChain,
}: {
  exercise: ActiveExercise
  onCompleteSet: (workoutExerciseId: string, clientSetId: string) => void
  onDeleteSet: (clientSetId: string) => void
  onCycleSetType: (clientSetId: string, type: SetType) => void
  onUpdateSetRest: (clientSetId: string, seconds: number | null) => void
  /** Given a starting field, the ordered auto-advance chain across uncompleted fields. */
  buildChain: (startClientSetId: string, startField: SetField) => PadTarget[]
}) {
  const fields = editableFields(exercise.tracks)
  const showWeightCol = timeShowsWeight(exercise)
  const unitCtx = useUnitDisplay()
  const displayUnit = unitCtx.effectiveUnit(exercise.preferredUnit)

  return (
    <div role="table" aria-label={`${exercise.name} sets`} style={{ display: 'flex', flexDirection: 'column' }}>
      <HeaderRow
        tracks={exercise.tracks}
        fields={fields}
        showWeightCol={showWeightCol}
        unit={displayUnit}
        distanceUnit={unitCtx.distanceUnit}
        perSideLoad={exercise.modality === 'strength' && exercise.loadBasis === 'per_side'}
        perSide={exercise.perSide}
      />
      {exercise.sets.map((set) => (
        <SetRow
          key={set.clientSetId ?? set.setNumber}
          exercise={exercise}
          set={set}
          fields={fields}
          showWeightCol={showWeightCol}
          onCompleteSet={onCompleteSet}
          onDeleteSet={onDeleteSet}
          onCycleSetType={onCycleSetType}
          onUpdateSetRest={onUpdateSetRest}
          buildChain={buildChain}
        />
      ))}
    </div>
  )
}

function HeaderRow({ tracks, fields, showWeightCol, unit, distanceUnit, perSideLoad, perSide }: { tracks: string; fields: SetField[]; showWeightCol: boolean; unit: Unit; distanceUnit: ReturnType<typeof useUnitDisplay>['distanceUnit']; perSideLoad: boolean; perSide: boolean }) {
  const cols: string[] = ['Set', 'Previous']
  if (tracks === 'time' && showWeightCol) cols.push(unit)
  const showMultiply = pairsWeightReps(tracks) && fields.length === 2
  fields.forEach((f, i) => {
    if (i === 1 && showMultiply) cols.push('')
    // Non-weight fields belong to the exercise's own per-side flag (a unilateral
    // hold/rep count): `perSideLoad` only answers "is the WEIGHT number per
    // dumbbell", a different question that doesn't apply to reps/time/distance.
    const sideSuffix = f === 'weight' ? (perSideLoad ? '/side' : '') : (perSide ? '/side' : '')
    cols.push(
      f === 'weight' ? `${FIELD_LABEL[f]}${sideSuffix} (${unit})`
        : f === 'distanceM' ? `${FIELD_LABEL[f]}${sideSuffix} (${distanceUnit})`
          : `${FIELD_LABEL[f]}${sideSuffix}`,
    )
  })
  cols.push('Rest', '', '') // rest, ✓, delete
  return (
    <div style={{ ...rowGrid(tracks, showWeightCol), padding: '0 4px 6px' }} aria-hidden>
      {cols.map((c, i) => (
        <span key={i} style={headerCell}>
          {c}
        </span>
      ))}
    </div>
  )
}

const FIELD_LABEL: Record<SetField, string> = {
  weight: 'Weight',
  reps: 'Reps',
  durationS: 'Time',
  distanceM: 'Distance',
  rpe: 'RPE',
}

function SetRow({
  exercise,
  set,
  fields,
  showWeightCol,
  onCompleteSet,
  onDeleteSet,
  onCycleSetType,
  onUpdateSetRest,
  buildChain,
}: {
  exercise: ActiveExercise
  set: ActiveSet
  fields: SetField[]
  showWeightCol: boolean
  onCompleteSet: (workoutExerciseId: string, clientSetId: string) => void
  onDeleteSet: (clientSetId: string) => void
  onCycleSetType: (clientSetId: string, type: SetType) => void
  onUpdateSetRest: (clientSetId: string, seconds: number | null) => void
  buildChain: (startClientSetId: string, startField: SetField) => PadTarget[]
}) {
  const pad = usePad()
  const unitCtx = useUnitDisplay()
  const [menuOpen, setMenuOpen] = useState(false)
  const [restOpen, setRestOpen] = useState(false)
  const [swipeX, setSwipeX] = useState(0)
  const touchStart = useRef<number | null>(null)

  const clientSetId = set.clientSetId!
  const displayUnit = unitCtx.effectiveUnit(exercise.preferredUnit)
  const { previous: prev, target } = ghostSourcesFor(exercise, set)
  const roundNumber = logicalSetNumber(exercise, set)
  const sideLetter = set.side === 'left' ? 'L' : set.side === 'right' ? 'R' : ''
  // Every side-tracked row reads "<round><side>" (1L / 1R / 2L / 2R…) — the same
  // convention as the strength Split mode below, so a per-side hold with more than
  // one round never collapses to indistinguishable bare "L"/"R" chips (#1840).
  const visualSetLabel = set.side ? `${roundNumber}${sideLetter}` : String(roundNumber)
  const accessibleSetLabel = `Set ${roundNumber}${set.side ? ` (${set.side})` : ''}`
  // Convert the ghost's weight (prev in its own unit, target in the exercise unit)
  // into the display unit — DISPLAY only; stored rows are never touched.
  const dispPrev = prev
    ? { ...prev, weight: convertWeight(prev.weight, prev.unit === 'kg' ? 'kg' : 'lb', displayUnit) }
    : prev
  const dispTarget = target
    ? { ...target, weight: convertWeight(target.weight ?? null, exUnit(exercise), displayUnit) ?? undefined }
    : target
  const ghostText = previousText(exercise.tracks, dispPrev, dispTarget, unitCtx.distanceUnit)
  const hint = targetHint(exercise.tracks, dispPrev, dispTarget)
  const tag = set.setType !== 'normal' ? SET_TYPE_CHIP[set.setType as Exclude<SetType, 'normal'>] : null
  const prefix = WEIGHT_PREFIX[exercise.tracks] ?? ''
  const inheritedRest = restSecondsForSet(
    set.setType === 'warmup',
    exercise.restSeconds,
    exercise.restSecondsWarmup,
  )
  const displayedRest = set.restSeconds ?? inheritedRest
  const showMultiply = pairsWeightReps(exercise.tracks) && fields.length === 2

  function openPad(field: SetField) {
    // The pad edits in the DISPLAY unit; converting the ghost keeps its steppers +
    // committed value in that unit. The store still records the entered unit.
    const rawGhost = ghostFor(exercise, set, field)
    const ghost =
      field === 'weight'
        ? convertWeight(rawGhost, ghostWeightUnit(exercise, prev), displayUnit)
        : field === 'distanceM'
          ? metersToDistance(rawGhost, unitCtx.distanceUnit)
          : rawGhost
    pad.open({
      target: {
        workoutExerciseId: exercise.workoutExerciseId,
        clientSetId,
        setNumber: set.setNumber,
        field,
        ghost,
      },
      unit: displayUnit,
      distanceUnit: unitCtx.distanceUnit,
      showRpe: exercise.tracks === 'weight_reps' || exercise.tracks === 'weighted_bodyweight' || exercise.tracks === 'assisted_bodyweight',
      chain: buildChain(clientSetId, field),
    })
  }

  // Touch swipe-to-delete (left swipe past threshold).
  function onTouchStart(e: React.TouchEvent) {
    touchStart.current = e.touches[0]!.clientX
  }
  function onTouchMove(e: React.TouchEvent) {
    if (touchStart.current == null) return
    const dx = e.touches[0]!.clientX - touchStart.current
    if (dx < 0) setSwipeX(Math.max(dx, -96))
  }
  function onTouchEnd() {
    if (swipeX <= -72) onDeleteSet(clientSetId)
    setSwipeX(0)
    touchStart.current = null
  }

  const active = pad.active?.clientSetId === clientSetId

  return (
    // overflow hidden clips the swipe-delete reveal + slide transform, but it
    // must not clip the tag menu (#1471 — the menu was rendering below the
    // row's own bounds and getting cut off by this same clip).
    <div style={{ position: 'relative', overflow: menuOpen ? 'visible' : 'hidden' }}>
      {/* delete affordance revealed by swipe */}
      {swipeX < -8 && (
        <div style={swipeDeleteBg} aria-hidden>
          <X size={16} strokeWidth={2} color="var(--danger)" />
        </div>
      )}
      <div
        role="row"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          ...rowGrid(exercise.tracks, showWeightCol),
          alignItems: 'center',
          padding: '5px 4px',
          borderRadius: 8,
          background: set.completed ? 'color-mix(in oklch, var(--success, var(--accent)) 12%, transparent)' : 'transparent',
          transform: swipeX ? `translateX(${swipeX}px)` : 'none',
          transition: swipeX ? 'none' : 'transform .16s, background .16s',
        }}
      >
        {/* set number / tag chip → tap opens the tag menu. Per-side holds show
            round + side letter (§10b.2, #1840) — the pair reads 1L/1R, not 1/2. */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={`${accessibleSetLabel}${tag ? ` (${tag.label})` : ''} — tag`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            style={{
              ...setNumBtn,
              color: tag ? tag.color : 'var(--fg-muted)',
              borderColor: tag ? tag.color : 'var(--border-muted)',
            }}
          >
            {tag ? `${tag.short}${sideLetter}` : visualSetLabel}
          </button>
          {menuOpen && (
            <TagMenu
              current={set.setType as SetType}
              onPick={(t) => {
                onCycleSetType(clientSetId, t)
                setMenuOpen(false)
              }}
              onClear={() => {
                if (set.setType !== 'normal') onCycleSetType(clientSetId, set.setType as SetType)
                setMenuOpen(false)
              }}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>

        {/* previous ghost + the target nudge stacked beneath it, inside the same
            grid cell so the pair stays aligned with its own row (the hint used to
            hang under the row and broke the table's rhythm). Both lines fit the
            40px field height, so showing a hint never changes row height. */}
        <span
          style={ghostCell}
          title={hint && !set.completed ? undefined : ghostText || undefined}
        >
          <span style={ghostValue}>{ghostText || '—'}</span>
          {hint && !set.completed && <TargetHint hint={hint} />}
        </span>

        {/* optional weight column for time tracks */}
        {exercise.tracks === 'time' && showWeightCol && (
          <FieldCell
            display={
              set.weight != null
                ? trimNum(convertWeight(set.weight, set.weightUnit === 'kg' ? 'kg' : 'lb', displayUnit))
                : ''
            }
            placeholder=""
            active={active && pad.active?.field === 'weight'}
            onOpen={() => openPad('weight')}
            ariaLabel={`${accessibleSetLabel} weight`}
          />
        )}

        {/* editable fields */}
        {fields.map((f, i) => (
          <Fragment key={f}>
            {i === 1 && showMultiply && (
              <span style={multiplySeparator} aria-hidden="true">×</span>
            )}
            <FieldCell
              display={displayFor(set, f, prefix, displayUnit, unitCtx.distanceUnit)}
              placeholder={placeholderFor(exercise, set, f, prev, displayUnit, unitCtx.distanceUnit)}
              active={active && pad.active?.field === f}
              onOpen={() => openPad(f)}
              ariaLabel={`${accessibleSetLabel} ${FIELD_LABEL[f].toLowerCase()}${f === 'reps' && set.rpe != null ? `, RPE ${trimNum(set.rpe)}` : ''}`}
              badge={f === 'reps' && set.rpe != null ? trimNum(set.rpe) : null}
            />
          </Fragment>
        ))}

        {/* Exact-set rest override; null inherits the warmup/working fallback. */}
        <button
          type="button"
          onClick={() => setRestOpen(true)}
          aria-label={
            set.restSeconds == null
              ? `${accessibleSetLabel} rest: inherit (${formatRest(inheritedRest)})`
              : `${accessibleSetLabel} rest: ${formatRest(set.restSeconds)}`
          }
          style={{
            ...restBtn,
            color: set.restSeconds == null ? 'var(--fg-subtle)' : 'var(--accent)',
            borderColor: set.restSeconds == null ? 'var(--border-muted)' : 'color-mix(in oklch, var(--accent) 45%, var(--border-muted))',
          }}
        >
          <Clock3 size={11} strokeWidth={2} />
          <span>{formatRest(displayedRest)}</span>
        </button>

        {/* ✓ complete */}
        <button
          type="button"
          onClick={() => onCompleteSet(exercise.workoutExerciseId, clientSetId)}
          aria-label={set.completed ? `Uncomplete ${accessibleSetLabel.toLowerCase()}` : `Complete ${accessibleSetLabel.toLowerCase()}`}
          aria-pressed={set.completed}
          style={{
            ...checkBtn,
            background: set.completed ? 'var(--success, var(--accent))' : 'var(--bg-elevated)',
            borderColor: set.completed ? 'var(--success, var(--accent))' : 'var(--border-muted)',
            color: set.completed ? 'var(--accent-fg)' : 'var(--fg-subtle)',
          }}
        >
          <Check size={15} strokeWidth={2.4} />
        </button>

        {/* pointer delete (×) — hidden on touch where swipe handles it */}
        <button
          type="button"
          onClick={() => onDeleteSet(clientSetId)}
          aria-label={`Delete ${accessibleSetLabel.toLowerCase()}`}
          className="gym-set-x"
          style={deleteX}
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      {exercise.tracks === 'distance_time' && set.distanceM != null && set.durationS != null && (
        <div style={{ padding: '0 50px 5px', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)', fontSize: 9.5, textAlign: 'right' }}>
          {formatPace(set.durationS, set.distanceM, paceBasisForDistanceUnit(unitCtx.distanceUnit))}
        </div>
      )}
      {restOpen && (
        <SetRestPicker
          setNumber={roundNumber}
          value={set.restSeconds}
          inheritedSeconds={inheritedRest}
          onChange={(seconds) => onUpdateSetRest(clientSetId, seconds)}
          onClose={() => setRestOpen(false)}
        />
      )}
    </div>
  )
}

function displayFor(set: ActiveSet, field: SetField, prefix: string, displayUnit: Unit, distanceUnit: ReturnType<typeof useUnitDisplay>['distanceUnit']): string {
  switch (field) {
    case 'weight': {
      if (set.weight == null) return ''
      const w = convertWeight(set.weight, set.weightUnit === 'kg' ? 'kg' : 'lb', displayUnit)
      return `${prefix}${trimNum(w)}`
    }
    case 'reps':
      return set.reps != null ? String(set.reps) : ''
    case 'durationS':
      return set.durationS != null ? secToMmss(set.durationS) : ''
    case 'distanceM':
      return set.distanceM != null ? metersLabel(set.distanceM, distanceUnit) : ''
    case 'rpe':
      return set.rpe != null ? trimNum(set.rpe) : ''
  }
}

/** The placeholder = the ghost value formatted for the field (Strong's grey text),
 *  weights converted into the display unit. */
function placeholderFor(
  ex: ActiveExercise,
  set: ActiveSet,
  field: SetField,
  prev: { weight: number | null; unit: string } | undefined,
  displayUnit: Unit,
  distanceUnit: ReturnType<typeof useUnitDisplay>['distanceUnit'],
): string {
  const g = ghostFor(ex, set, field)
  if (g == null) return ''
  const prefix = WEIGHT_PREFIX[ex.tracks] ?? ''
  switch (field) {
    case 'weight':
      return `${prefix}${trimNum(convertWeight(g, ghostWeightUnit(ex, prev), displayUnit))}`
    case 'durationS':
      return secToMmss(g)
    case 'distanceM':
      return metersLabel(g, distanceUnit)
    default:
      return trimNum(g)
  }
}

/** The exercise's own display unit (preferredUnit, lb default). */
function exUnit(ex: ActiveExercise): Unit {
  return ex.preferredUnit === 'kg' ? 'kg' : 'lb'
}

/** The stored unit of a weight ghost: the previous set's unit when the ghost came
 *  from history, else the exercise's preferred unit (targets are in that unit). */
function ghostWeightUnit(ex: ActiveExercise, prev: { weight: number | null; unit: string } | undefined): Unit {
  if (prev?.weight != null) return prev.unit === 'kg' ? 'kg' : 'lb'
  return exUnit(ex)
}

function FieldCell({
  display,
  placeholder,
  active,
  onOpen,
  ariaLabel,
  badge,
}: {
  display: string
  placeholder: string
  active: boolean
  onOpen: () => void
  ariaLabel: string
  /** Subtle corner indicator (e.g. the set's RPE) so a logged value stays visible
   *  after the numeric pad — which shows it only while open — closes. */
  badge?: string | null
}) {
  return (
    <div style={fieldCellWrap}>
      <input
        type="text"
        inputMode="none"
        readOnly
        value={display}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onFocus={onOpen}
        onClick={onOpen}
        style={{
          ...fieldInput,
          borderColor: active ? 'var(--accent)' : 'var(--border-muted)',
          background: active ? 'color-mix(in oklch, var(--accent) 8%, var(--bg-elevated))' : 'var(--bg-elevated)',
        }}
      />
      {badge && (
        <span style={rpeBadge} title={`RPE ${badge}`} aria-hidden>
          {badge}
        </span>
      )}
    </div>
  )
}

function TagMenu({
  current,
  onPick,
  onClear,
  onClose,
}: {
  current: SetType
  onPick: (t: Exclude<SetType, 'normal'>) => void
  onClear: () => void
  onClose: () => void
}) {
  return (
    <>
      <div style={menuScrim} onClick={onClose} aria-hidden />
      <div role="menu" aria-label="Set type" style={tagMenu}>
        {(['warmup', 'drop', 'failure'] as const).map((t) => {
          const chip = SET_TYPE_CHIP[t]
          return (
            <button
              key={t}
              type="button"
              role="menuitemradio"
              onClick={() => onPick(t)}
              aria-checked={current === t}
              style={{
                ...tagMenuItem,
                color: chip.color,
                fontWeight: current === t ? 700 : 500,
              }}
            >
              <span style={{ ...tagDot, background: chip.color }} aria-hidden />
              {chip.label}
            </button>
          )
        })}
        <button type="button" role="menuitem" onClick={onClear} style={{ ...tagMenuItem, color: 'var(--fg-subtle)' }}>
          Clear
        </button>
      </div>
    </>
  )
}

// ── layout ────────────────────────────────────────────────────────────────────

/** Grid template per tracks shape (set# | previous | fields… | rest | ✓ | ×). */
function rowGrid(tracks: string, showWeightCol: boolean): React.CSSProperties {
  let mid: string
  switch (tracks) {
    case 'reps':
      mid = '1fr 56px'
      break
    case 'time':
      mid = showWeightCol ? '56px 64px' : '72px'
      break
    case 'distance_time':
      mid = '64px 64px'
      break
    default: // weight tracks (weight × reps)
      mid = '58px 14px 52px'
  }
  return {
    display: 'grid',
    gridTemplateColumns: `34px minmax(44px, 1fr) ${mid} 44px 40px 24px`,
    gap: 4,
    columnGap: 4,
  }
}

// ── styles ────────────────────────────────────────────────────────────────────
const headerCell: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  textAlign: 'center',
}
const setNumBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-elevated)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
}
const ghostCell: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 1,
  minWidth: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--fg-subtle)',
  textAlign: 'center',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
}
const fieldCellWrap: React.CSSProperties = {
  position: 'relative',
}
const rpeBadge: React.CSSProperties = {
  position: 'absolute',
  top: -5,
  right: -3,
  minWidth: 15,
  height: 15,
  padding: '0 3px',
  borderRadius: 6,
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  fontWeight: 700,
  lineHeight: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
}
const multiplySeparator: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  color: 'var(--fg-subtle)',
}
const ghostValue: React.CSSProperties = {
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
/** The progression nudge: same column as Previous, one line down, accent-tinted
 *  so it reads as "next" rather than as more history. */
const targetLine: React.CSSProperties = {
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontSize: 9.5,
  lineHeight: 1.1,
  letterSpacing: '0.02em',
  color: 'var(--accent)',
}
const targetTooltip: React.CSSProperties = {
  zIndex: 120,
  maxWidth: 240,
  padding: '8px 10px',
  borderRadius: 8,
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  boxShadow: '0 10px 30px rgba(0,0,0,.28)',
  fontFamily: 'var(--font-sans)',
  fontSize: 11.5,
  lineHeight: 1.4,
}
const fieldInput: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  height: 40,
  textAlign: 'center',
  fontFamily: 'var(--font-mono)',
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--fg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  outline: 'none',
  cursor: 'pointer',
  padding: '0 2px',
}
const checkBtn: React.CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 8,
  border: '1px solid var(--border-muted)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  padding: 0,
}
const restBtn: React.CSSProperties = {
  width: 44,
  height: 40,
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 1,
  padding: 0,
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  background: 'var(--bg-elevated)',
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  fontVariantNumeric: 'tabular-nums',
  cursor: 'pointer',
}
const deleteX: React.CSSProperties = {
  width: 24,
  height: 40,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'none',
  border: 'none',
  color: 'var(--fg-subtle)',
  cursor: 'pointer',
  padding: 0,
}
const swipeDeleteBg: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  paddingRight: 16,
  background: 'color-mix(in oklch, var(--danger) 14%, transparent)',
  borderRadius: 8,
}
const menuScrim: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 40 }
const tagMenu: React.CSSProperties = {
  position: 'absolute',
  top: 34,
  left: 0,
  zIndex: 41,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 132,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  boxShadow: '0 8px 28px rgba(0,0,0,.3)',
  padding: 4,
}
const tagMenuItem: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  background: 'none',
  border: 'none',
  borderRadius: 7,
  cursor: 'pointer',
  textAlign: 'left',
}
const tagDot: React.CSSProperties = { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }
