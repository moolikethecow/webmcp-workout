'use client'

/**
 * ExerciseDetailSheet — the per-exercise drill-in (GYM_PLAN §4 "Tab: Exercises").
 * Renders as a bottom sheet on mobile and a right-side panel ≥ md (the app's
 * scrim + slide pattern; behavior matches the people star-map modal / detail
 * panel). Sections:
 *   - hero: looping GIF / legacy image when media exists; absent otherwise
 *     (the Muscles section already owns the anatomy map)
 *   - name + category/equipment/level chips
 *   - MiniMuscleMap (primary full accent, secondary dimmed)
 *   - instructions (numbered, collapsible past 3)
 *   - RecordsBlock (null-safe, respects excludedFromE1rm)
 *   - charts (e1RM / volume / best-set — house SVG MetricChart)
 *   - history (collapsible sessions)
 *   - footer actions: Track / Dislike (+reason), rest seconds (working/warmup),
 *     preferred unit — PATCH with optimistic update + toast.error rollback.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'

import { SecHead } from '@/components/health/primitives'
import { MetricChart } from '@/components/health/charts'
import {
  applyLoadCorrection,
  listLoadCorrections,
  patchGymExercise,
  previewLoadCorrection,
  revertLoadCorrection,
  useGymExercise,
} from '@/lib/gym-client/fetch'
import type {
  ExerciseDetail,
  ExercisePatch,
  ExerciseRecords,
  HistorySession,
  LoadBasis,
  LoadCorrection,
  LoadCorrectionPreview,
  PreferredUnit,
  SetType,
} from '@/lib/gym-client/types'
import type { DistanceUnit } from '@/lib/units/system'
import { ExerciseImage } from './ExerciseImage'
import { MiniMuscleMap } from './MiniMuscleMap'
import { GripRecordsBlock } from './GripRecordsBlock'
import { RecordsBlock } from './RecordsBlock'
import { meters, num, setLabel, shortStamp, titleCase } from './format'
import { displayExerciseName } from '@/lib/gym/display-name'

const SET_TYPE_TAG: Record<SetType, { short: string; color: string } | null> = {
  normal: null,
  warmup: { short: 'W', color: 'var(--fg-subtle)' },
  drop: { short: 'D', color: 'var(--warning)' },
  failure: { short: 'F', color: 'var(--danger)' },
}

export function ExerciseDetailSheet({
  id,
  seed,
  aiPending,
  onClose,
  onExerciseChanged,
}: {
  id: string
  /** A freshly-created exercise to seed the sheet (opens instantly, no wait). */
  seed?: ExerciseDetail
  /** Show the "Filling in the details…" shimmer while catalog metadata lands. */
  aiPending?: boolean
  onClose: () => void
  /** Fires after a preference PATCH succeeds so an open logger can safely
   * refresh its active-workout read model without dropping queued edits. */
  onExerciseChanged?: (patch: ExercisePatch) => void
}) {
  const { data, loading, error } = useGymExercise(id)

  // Prefer the fetched detail; fall back to the seed so the panel renders
  // immediately after a create.
  const exercise: ExerciseDetail | null = data?.exercise ?? seed ?? null
  const records: ExerciseRecords | null = data?.records ?? null
  const history: HistorySession[] = data?.history ?? []
  const charts = data?.charts ?? null
  const weightUnit: PreferredUnit = data?.weightUnit ?? 'lb'
  const distanceUnit = data?.distanceUnit ?? 'm'

  // Escape-to-close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const showShimmer = aiPending && !data // once real data lands, drop the shimmer

  return (
    <div role="presentation" style={scrim} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <style>{SHEET_CSS}</style>
      <aside className="gym-sheet" role="dialog" aria-label={exercise ? exercise.name : 'Exercise detail'}>
        <button type="button" onClick={onClose} aria-label="Close" style={closeBtn}>
          <X size={15} strokeWidth={1.8} />
        </button>

        {error && !exercise && <p style={note}>Couldn&rsquo;t load this exercise.</p>}

        {!exercise && loading && <p style={note}>Loading…</p>}

        {exercise && (
          <>
            <Hero exercise={exercise} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <h2 style={title}>{displayExerciseName(exercise.name)}</h2>
              {exercise.aiFilled && (
                <Sparkles size={13} strokeWidth={1.8} style={{ color: 'var(--accent)' }} aria-label="AI-filled" />
              )}
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {exercise.category && <Chip>{titleCase(exercise.category)}</Chip>}
              {exercise.equipment && <Chip>{titleCase(exercise.equipment)}</Chip>}
              {exercise.level && <Chip>{titleCase(exercise.level)}</Chip>}
              {exercise.isCustom && <Chip>Custom</Chip>}
            </div>

            {showShimmer && (
              <div className="gym-shimmer" style={shimmerBar}>
                Filling in the details…
              </div>
            )}

            {/* Muscle map */}
            {exercise.regions.length > 0 && (
              <section style={section}>
                <SecHead num="01">Muscles</SecHead>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <MiniMuscleMap regions={exercise.regions} size={150} showLabels />
                </div>
              </section>
            )}

            {/* Instructions */}
            {exercise.instructions && exercise.instructions.length > 0 && (
              <section style={section}>
                <SecHead num="02">How to</SecHead>
                <Instructions steps={exercise.instructions} />
              </section>
            )}

            {/* Records */}
            {records && (
              <section style={section}>
                <SecHead num="03">Records</SecHead>
                {exercise.loadBasis === 'per_side' && (
                  <p style={{ ...note, margin: '0 0 10px', textAlign: 'left' }}>Load records are per side. Volume includes both matched sides.</p>
                )}
                <RecordsBlock records={records} distanceUnit={distanceUnit} perSide={exercise.loadBasis === 'per_side'} />
                <GripRecordsBlock
                  gripRecords={data?.gripRecords}
                  perSide={exercise.loadBasis === 'per_side'}
                />
              </section>
            )}

            {/* Charts */}
            {charts && (charts.e1rm.length > 0 || charts.volume.length > 0 || charts.bestSet.length > 0) && (
              <section style={section}>
                <SecHead num="04">Trends</SecHead>
                <ChartRow label="Estimated 1RM" unit={`${weightUnit}${exercise.loadBasis === 'per_side' ? '/side' : ''}`} series={charts.e1rm} />
                <ChartRow label="Volume" unit={weightUnit} series={charts.volume} />
                <ChartRow label="Best set" unit={weightUnit} series={charts.bestSet} />
              </section>
            )}

            {/* History */}
            {history.length > 0 && (
              <section style={section}>
                <SecHead num="05">History</SecHead>
                <History sessions={history} distanceUnit={distanceUnit} loadBasis={exercise.loadBasis} />
              </section>
            )}

            {/* Footer actions (prefs) */}
            <section style={{ ...section, borderTop: '1px solid var(--border-muted)', paddingTop: 16 }}>
              <SecHead num="06">Preferences</SecHead>
              <Preferences exercise={exercise} onExerciseChanged={onExerciseChanged} />
            </section>
          </>
        )}
      </aside>
    </div>
  )
}

// ── hero: two-frame crossfade or muscle-SVG ─────────────────────────────────
function Hero({ exercise }: { exercise: ExerciseDetail }) {
  const frames = exercise.images ?? []
  if (frames.length === 0) return null
  // Dataset entries carry one looping GIF. Render it once rather than placing
  // two copies into the old JPG crossfade (which would double-decode the GIF).
  if (frames[0]?.endsWith('.gif')) {
    return (
      <div style={heroWrap}>
        <ExerciseImage imagePath={frames[0]} regions={exercise.regions} alt={`${displayExerciseName(exercise.name)} demo`} size={200} radius={14} eager />
      </div>
    )
  }
  // Two-frame crossfade (1.2s CSS alternate). If only one frame exists, it just
  // shows statically.
  const frameA = frames[0]!
  const frameB = frames[1] ?? frames[0]!
  return (
    <div style={heroWrap}>
      <div style={{ position: 'relative', width: 200, height: 200 }} className="gym-hero-frames">
        <div className="gym-frame gym-frame-a" style={heroFrame}>
          <ExerciseImage imagePath={frameA} regions={exercise.regions} alt={`${displayExerciseName(exercise.name)} start`} size={200} radius={14} eager />
        </div>
        <div className="gym-frame gym-frame-b" style={heroFrame}>
          <ExerciseImage imagePath={frameB} regions={exercise.regions} alt={`${displayExerciseName(exercise.name)} end`} size={200} radius={14} eager />
        </div>
      </div>
    </div>
  )
}

// ── instructions ────────────────────────────────────────────────────────────
function Instructions({ steps }: { steps: string[] }) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? steps : steps.slice(0, 3)
  return (
    <div>
      <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {shown.map((s, i) => (
          <li key={i} style={{ display: 'flex', gap: 10 }}>
            <span style={stepNum}>{i + 1}</span>
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13.5, lineHeight: 1.5, color: 'var(--fg-muted)' }}>{s}</span>
          </li>
        ))}
      </ol>
      {steps.length > 3 && (
        <button type="button" onClick={() => setExpanded((v) => !v)} style={moreBtn}>
          {expanded ? 'Show less' : `Show ${steps.length - 3} more steps`}
          <ChevronDown size={12} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
        </button>
      )}
    </div>
  )
}

// ── one chart lane ──────────────────────────────────────────────────────────
function ChartRow({
  label,
  unit,
  series,
}: {
  label: string
  unit: string
  series: { date: string; value: number }[]
}) {
  if (series.length === 0) return null
  const last = series[series.length - 1]!
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={chartLabel}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
          {num(last.value)} {unit}
        </span>
      </div>
      <MetricChart series={series} type="area" height={72} color="var(--accent)" round={0} />
    </div>
  )
}

// ── history (collapsible sessions) ──────────────────────────────────────────
function History({
  sessions,
  distanceUnit,
  loadBasis,
}: {
  sessions: HistorySession[]
  distanceUnit: DistanceUnit
  loadBasis: LoadBasis
}) {
  const [openId, setOpenId] = useState<string | null>(sessions[0]?.workoutId ?? null)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {sessions.map((s) => {
        const open = openId === s.workoutId
        const working = new Set(
          s.sets.filter((x) => x.setType !== 'warmup').map((x) => x.logicalSetId),
        ).size
        return (
          <div key={s.workoutId} style={sessionCard}>
            <button
              type="button"
              onClick={() => setOpenId((cur) => (cur === s.workoutId ? null : s.workoutId))}
              aria-expanded={open}
              style={sessionHead}
            >
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)' }}>{shortStamp(s.date)}</span>
                {s.workoutName && <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-subtle)' }}>{s.workoutName}</span>}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-subtle)' }}>{working} sets</span>
                <ChevronDown size={13} style={{ color: 'var(--fg-subtle)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
              </span>
            </button>
            {open && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '0 10px 10px' }}>
                {s.sets.map((set) => {
                  const tag = SET_TYPE_TAG[set.setType]
                  return (
                    <span key={`${set.logicalSetId}:${set.side ?? 'both'}`} style={{ ...setChip, opacity: set.setType === 'warmup' ? 0.55 : 1 }}>
                      {set.distanceM != null
                        ? `${meters(set.distanceM, distanceUnit)}${set.durationS != null ? ` · ${Math.round(set.durationS)}s` : ''}`
                        : set.durationS != null
                          ? `${Math.round(set.durationS)}s`
                        : setLabel(set.weight, set.reps, loadBasis === 'per_side' ? `${set.unit}/side` : set.unit)}
                      {loadBasis === 'per_side' && (
                        <span style={{ color: 'var(--fg-subtle)', marginLeft: 4 }}>
                          {set.side === 'left' ? 'L' : set.side === 'right' ? 'R' : 'Both'}
                        </span>
                      )}
                      {tag && <span style={{ color: tag.color, marginLeft: 4, fontWeight: 600 }}>{tag.short}</span>}
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── preferences footer (PATCH with optimistic + rollback) ───────────────────
function Preferences({
  exercise,
  onExerciseChanged,
}: {
  exercise: ExerciseDetail
  onExerciseChanged?: (patch: ExercisePatch) => void
}) {
  // Local mirror of the mutable prefs; optimistic on change, rolled back on a
  // failed PATCH (repo convention: restore in place + toast.error).
  const [tracked, setTracked] = useState(exercise.tracked)
  const [disliked, setDisliked] = useState(exercise.disliked)
  const [dislikeReason, setDislikeReason] = useState(exercise.dislikeReason ?? '')
  const [showReason, setShowReason] = useState(false)
  const [rest, setRest] = useState<number | ''>(exercise.defaultRestSeconds ?? '')
  const [restWarmup, setRestWarmup] = useState<number | ''>(exercise.restSecondsWarmup ?? '')
  const [unit, setUnit] = useState<PreferredUnit | ''>(exercise.preferredUnit ?? '')
  const [loadBasis, setLoadBasis] = useState<LoadBasis>(exercise.loadBasis)
  const [activeCorrectionCount, setActiveCorrectionCount] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  // Keep the reason box in sync if the seed changes underneath.
  const seededRef = useRef(exercise.id)
  useEffect(() => {
    if (seededRef.current !== exercise.id) {
      seededRef.current = exercise.id
      setTracked(exercise.tracked)
      setDisliked(exercise.disliked)
      setDislikeReason(exercise.dislikeReason ?? '')
      setRest(exercise.defaultRestSeconds ?? '')
      setRestWarmup(exercise.restSecondsWarmup ?? '')
      setUnit(exercise.preferredUnit ?? '')
      setLoadBasis(exercise.loadBasis)
    }
  }, [exercise])
  useEffect(() => setLoadBasis(exercise.loadBasis), [exercise.loadBasis])

  /** Apply an optimistic patch; on failure, run `rollback` and toast. */
  async function persist(patch: ExercisePatch, rollback: () => void) {
    setSaving(true)
    try {
      await patchGymExercise(exercise.id, patch)
      onExerciseChanged?.(patch)
    } catch {
      rollback()
      toast.error("Couldn't save that change")
    } finally {
      setSaving(false)
    }
  }

  function toggleTracked() {
    const next = !tracked
    setTracked(next)
    void persist({ tracked: next }, () => setTracked(!next))
  }

  function toggleDisliked() {
    const next = !disliked
    setDisliked(next)
    if (next) {
      setShowReason(true)
      void persist({ disliked: true }, () => { setDisliked(false); setShowReason(false) })
    } else {
      setShowReason(false)
      void persist({ disliked: false, dislikeReason: null }, () => setDisliked(true))
    }
  }

  function saveReason() {
    const reason = dislikeReason.trim() || null
    void persist({ disliked: true, dislikeReason: reason }, () => {})
    setShowReason(false)
  }

  function commitRest(field: 'defaultRestSeconds' | 'restSecondsWarmup', raw: string, prev: number | '') {
    const val = raw.trim() === '' ? null : Number.parseInt(raw, 10)
    if (val != null && (Number.isNaN(val) || val < 0)) return
    void persist({ [field]: val } as ExercisePatch, () => {
      if (field === 'defaultRestSeconds') setRest(prev)
      else setRestWarmup(prev)
    })
  }

  function commitUnit(next: PreferredUnit) {
    const prev = unit
    setUnit(next)
    void persist({ preferredUnit: next }, () => setUnit(prev))
  }

  function commitLoadBasis(next: LoadBasis) {
    if (next === loadBasis) return
    const prev = loadBasis
    setLoadBasis(next)
    void persist({ loadBasis: next }, () => setLoadBasis(prev))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Track + Dislike toggles */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Toggle on={tracked} onClick={toggleTracked} disabled={saving}>
          {tracked ? 'Tracked' : 'Track'}
        </Toggle>
        <Toggle on={disliked} onClick={toggleDisliked} disabled={saving} danger>
          {disliked ? 'Disliked' : 'Dislike'}
        </Toggle>
      </div>

      {showReason && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={dislikeReason}
            onChange={(e) => setDislikeReason(e.target.value)}
            placeholder="Why? (optional)"
            aria-label="Dislike reason"
            style={reasonInput}
          />
          <button type="button" onClick={saveReason} style={miniSave}>Save</button>
        </div>
      )}

      {/* Rest seconds (working + warmup) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <NumField
          label="Rest (working)"
          value={rest}
          suffix="s"
          onChange={setRest}
          onCommit={(raw) => commitRest('defaultRestSeconds', raw, rest)}
        />
        <NumField
          label="Rest (warmup)"
          value={restWarmup}
          suffix="s"
          onChange={setRestWarmup}
          onCommit={(raw) => commitRest('restSecondsWarmup', raw, restWarmup)}
        />
      </div>

      {/* Preferred unit */}
      <div>
        <div style={prefLabel}>Entered load</div>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-muted)', borderRadius: 8, overflow: 'hidden' }}>
          {([
            ['total', 'Total'],
            ['per_side', 'Per side'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => commitLoadBasis(value)}
              aria-pressed={loadBasis === value}
              disabled={saving || (value === 'total' && activeCorrectionCount !== 0)}
              aria-describedby="load-basis-help"
              style={{
                padding: '7px 14px',
                minHeight: 44,
                fontFamily: 'var(--font-sans)',
                fontSize: 12,
                background: loadBasis === value ? 'var(--accent)' : 'transparent',
                color: loadBasis === value ? 'var(--accent-fg)' : 'var(--fg-subtle)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <p id="load-basis-help" style={{ ...note, margin: '6px 0 0', textAlign: 'left' }}>
          {activeCorrectionCount == null
            ? 'Checking history corrections…'
            : activeCorrectionCount > 0
              ? 'Undo the active correction below before switching this exercise back to Total.'
              : loadBasis === 'per_side'
                ? 'Log one side’s weight. Both is the default; Split lets left and right differ. This changes existing Both-row volume immediately.'
                : 'The entered number is the total load. Use history cleanup below to normalize combined side loads atomically.'}
        </p>
      </div>

      <div>
        <div style={prefLabel}>Preferred unit</div>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-muted)', borderRadius: 8, overflow: 'hidden' }}>
          {(['lb', 'kg'] as const).map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => commitUnit(u)}
              aria-pressed={unit === u}
              disabled={saving}
              style={{
                padding: '6px 16px',
                minHeight: 44,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                background: unit === u ? 'var(--accent)' : 'transparent',
                color: unit === u ? 'var(--accent-fg)' : 'var(--fg-subtle)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {u}
            </button>
          ))}
        </div>
      </div>

      <StrongHistoryCleanup
        exerciseId={exercise.id}
        showEditor={loadBasis === 'per_side'}
        onActiveCount={setActiveCorrectionCount}
        onLoadBasisChanged={(next) => {
          setLoadBasis(next)
          onExerciseChanged?.({ loadBasis: next })
        }}
      />
    </div>
  )
}

function StrongHistoryCleanup({
  exerciseId,
  showEditor,
  onActiveCount,
  onLoadBasisChanged,
}: {
  exerciseId: string
  showEditor: boolean
  onActiveCount: (count: number) => void
  onLoadBasisChanged: (basis: LoadBasis) => void
}) {
  const [corrections, setCorrections] = useState<LoadCorrection[]>([])
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [preview, setPreview] = useState<LoadCorrectionPreview | null>(null)
  const [busy, setBusy] = useState<'load' | 'preview' | 'apply' | 'revert' | null>('load')
  const [expanded, setExpanded] = useState(showEditor)

  const refresh = useCallback(async (): Promise<LoadCorrection[] | null> => {
    try {
      const rows = await listLoadCorrections(exerciseId)
      setCorrections(rows)
      onActiveCount(rows.length)
      return rows
    } catch {
      toast.error("Couldn't load history corrections")
      return null
    } finally {
      setBusy(null)
    }
  }, [exerciseId, onActiveCount])

  useEffect(() => {
    setBusy('load')
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (showEditor) setExpanded(true)
  }, [showEditor])

  const scope = {
    startDate: startDate || null,
    endDate: endDate || null,
    divisor: 2,
  }

  async function runPreview() {
    setBusy('preview')
    try {
      setPreview(await previewLoadCorrection(exerciseId, scope))
    } catch {
      toast.error("Couldn't preview that correction")
    } finally {
      setBusy(null)
    }
  }

  async function applyPreview() {
    if (!preview || preview.affectedSets === 0) return
    setBusy('apply')
    try {
      await applyLoadCorrection(exerciseId, {
        ...scope,
        reason: 'Combined load normalized to per-side weight',
      })
      setPreview(null)
      await refresh()
      onLoadBasisChanged('per_side')
      toast.success(`Corrected ${preview.affectedSets} sets`)
    } catch {
      setBusy(null)
      toast.error("Couldn't apply that correction")
    }
  }

  async function undo(correction: LoadCorrection) {
    setBusy('revert')
    try {
      await revertLoadCorrection(exerciseId, correction.id)
      const remaining = await refresh()
      if (remaining) {
        onLoadBasisChanged(remaining.length > 0 ? 'per_side' : correction.previousLoadBasis)
      }
      toast.success('Original weights restored')
    } catch {
      setBusy(null)
      toast.error("Couldn't restore those weights")
    }
  }

  const editorVisible = showEditor || expanded
  if (!editorVisible && corrections.length === 0) {
    return (
      <div style={{ borderTop: '1px solid var(--border-muted)', paddingTop: 14 }}>
        <button type="button" onClick={() => setExpanded(true)} style={{ ...moreBtn, minHeight: 44, marginTop: 0 }}>
          Normalize combined history…
        </button>
      </div>
    )
  }

  return (
    <div style={{ borderTop: '1px solid var(--border-muted)', paddingTop: 14 }}>
      <div style={prefLabel}>History cleanup</div>
      <p style={{ ...note, margin: '4px 0 10px', textAlign: 'left' }}>
        If past sets were logged with both sides added together, preview a divide-by-2 correction. The raw values stay recoverable.
      </p>
      {editorVisible && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={historyDateLabel}>
          From (optional)
          <input type="date" value={startDate} max={endDate || undefined} onChange={(e) => { setStartDate(e.target.value); setPreview(null) }} style={historyDateInput} />
        </label>
        <label style={historyDateLabel}>
          To (optional)
          <input type="date" value={endDate} min={startDate || undefined} onChange={(e) => { setEndDate(e.target.value); setPreview(null) }} style={historyDateInput} />
        </label>
      </div>}
      {editorVisible && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => void runPreview()} disabled={busy != null} style={miniSave}>
          {busy === 'preview' ? 'Checking…' : 'Preview'}
        </button>
        {preview && (
          <span style={{ ...note, margin: 0, textAlign: 'left' }}>
            {preview.affectedSets} sets · {preview.firstDate ?? '—'} to {preview.lastDate ?? '—'}
          </span>
        )}
      </div>}
      {preview && preview.affectedSets > 0 && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'var(--bg-subtle)' }}>
          <p style={{ ...note, margin: '0 0 8px', textAlign: 'left' }}>
            {preview.minRawWeight != null && preview.maxRawWeight != null
              ? `${num(preview.minRawWeight)}–${num(preview.maxRawWeight)} lb becomes ${num(preview.minCorrectedWeight ?? 0)}–${num(preview.maxCorrectedWeight ?? 0)} lb/side. `
              : 'Each stored weight will be halved. '}
            Matched volume stays {Math.round(preview.correctedMatchedVolume).toLocaleString()} lb.
          </p>
          <button type="button" onClick={() => void applyPreview()} disabled={busy != null} style={miniSave}>
            {busy === 'apply' ? 'Correcting…' : `Correct ${preview.affectedSets} sets`}
          </button>
        </div>
      )}
      {preview?.affectedSets === 0 && <p style={{ ...note, margin: '8px 0 0', textAlign: 'left' }}>No completed sets match that range.</p>}
      {corrections.map((correction) => (
        <div key={correction.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <span style={{ ...note, margin: 0, textAlign: 'left' }}>
            {correction.affectedSets} sets · {correction.startDate ?? 'first'} to {correction.endDate ?? 'latest'} · ÷{correction.divisor}
          </span>
          <button type="button" onClick={() => void undo(correction)} disabled={busy != null} style={{ ...moreBtn, minHeight: 44, marginTop: 0, padding: '0 8px' }}>Undo</button>
        </div>
      ))}
    </div>
  )
}

function NumField({
  label,
  value,
  suffix,
  onChange,
  onCommit,
}: {
  label: string
  value: number | ''
  suffix?: string
  onChange: (v: number | '') => void
  onCommit: (raw: string) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={prefLabel}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={value}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          onFocus={(e) => e.target.select()}
          enterKeyHint="done"
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          onBlur={(e) => onCommit(e.target.value)}
          style={numInput}
        />
        {suffix && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)' }}>{suffix}</span>}
      </span>
    </label>
  )
}

// ── small bits ───────────────────────────────────────────────────────────────
function Chip({ children }: { children: React.ReactNode }) {
  return <span style={chip}>{children}</span>
}

function Toggle({
  on,
  onClick,
  disabled,
  danger,
  children,
}: {
  on: boolean
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: React.ReactNode
}) {
  const activeColor = danger ? 'var(--danger)' : 'var(--accent)'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      style={{
        padding: '8px 16px',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.05em',
        borderRadius: 8,
        cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${on ? activeColor : 'var(--border-muted)'}`,
        background: on ? activeColor : 'var(--bg-elevated)',
        color: on ? 'var(--accent-fg)' : 'var(--fg-muted)',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  )
}

// ── styles ─────────────────────────────────────────────────────────────────
const SHEET_CSS = `
.gym-sheet {
  position: fixed; z-index: 60;
  background: var(--bg); border: 1px solid var(--border);
  box-shadow: var(--shadow-floating, 0 12px 48px rgba(0,0,0,.5));
  overflow-y: auto; -webkit-overflow-scrolling: touch;
  right: 0; top: 0; bottom: 0; width: 440px; max-width: 92vw;
  border-radius: 16px 0 0 16px; padding: 22px 22px 40px;
  animation: gym-slide-in .22s cubic-bezier(.16,1,.3,1);
}
@keyframes gym-slide-in { from { transform: translateX(24px); opacity: .6; } to { transform: none; opacity: 1; } }
@keyframes gym-slide-up { from { transform: translateY(24px); opacity: .6; } to { transform: none; opacity: 1; } }
.gym-frame { position: absolute; inset: 0; }
.gym-frame-b { opacity: 0; animation: gym-xfade 1.2s ease-in-out infinite alternate; }
@keyframes gym-xfade { from { opacity: 0; } to { opacity: 1; } }
.gym-shimmer { background: linear-gradient(90deg, var(--bg-subtle) 25%, var(--bg-elevated) 50%, var(--bg-subtle) 75%); background-size: 200% 100%; animation: gym-shimmer 1.4s ease-in-out infinite; }
@keyframes gym-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
@media (max-width: 700px) {
  .gym-sheet {
    left: 0; right: 0; top: auto; bottom: 0; width: 100%; max-width: 100%;
    max-height: 92vh; border-radius: 16px 16px 0 0;
    animation: gym-slide-up .24s cubic-bezier(.16,1,.3,1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .gym-sheet, .gym-frame-b, .gym-shimmer { animation: none !important; }
  .gym-frame-b { opacity: 1; }
}
`
const scrim: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 55,
  background: 'color-mix(in oklch, var(--bg) 55%, transparent)',
  backdropFilter: 'blur(2px)',
}
const closeBtn: React.CSSProperties = {
  position: 'absolute',
  top: 14,
  right: 14,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: 8,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  zIndex: 2,
}
const heroWrap: React.CSSProperties = { display: 'flex', justifyContent: 'center', paddingTop: 8 }
const heroFrame: React.CSSProperties = { position: 'absolute', inset: 0 }
const title: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontWeight: 400,
  fontSize: 24,
  letterSpacing: '-0.01em',
  margin: 0,
  color: 'var(--fg)',
}
const section: React.CSSProperties = { marginTop: 26 }
const chip: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-muted)',
  borderRadius: 6,
  padding: '3px 8px',
}
const shimmerBar: React.CSSProperties = {
  marginTop: 12,
  padding: '8px 12px',
  borderRadius: 8,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--fg-subtle)',
  border: '1px solid var(--border-muted)',
}
const stepNum: React.CSSProperties = {
  flexShrink: 0,
  width: 20,
  height: 20,
  borderRadius: 6,
  background: 'var(--bg-subtle)',
  color: 'var(--accent)',
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  fontWeight: 600,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const moreBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  marginTop: 10,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--accent)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
}
const chartLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const sessionCard: React.CSSProperties = {
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  background: 'var(--bg-elevated)',
  overflow: 'hidden',
}
const sessionHead: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: 10,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
}
const setChip: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 11.5,
  color: 'var(--fg-muted)',
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 5,
  padding: '2px 7px',
}
const prefLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const numInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  fontSize: 14,
  fontFamily: 'var(--font-mono)',
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  outline: 'none',
}
const historyDateLabel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.04em',
  color: 'var(--fg-subtle)',
}
const historyDateInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 8px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  minHeight: 44,
  colorScheme: 'dark',
}
const reasonInput: React.CSSProperties = {
  flex: 1,
  padding: '8px 10px',
  fontSize: 13,
  fontFamily: 'var(--font-sans)',
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  outline: 'none',
}
const miniSave: React.CSSProperties = {
  padding: '8px 14px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  border: 'none',
  borderRadius: 8,
  minHeight: 44,
  cursor: 'pointer',
}
const note: React.CSSProperties = {
  margin: '30px 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13,
  color: 'var(--fg-subtle)',
  textAlign: 'center',
}
