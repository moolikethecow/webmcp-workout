'use client'

/**
 * FinishSheet (GYM_PLAN §4 "Finish flow") — the bottom sheet that opens once
 * store.finish() resolves (the queue is already flushed, the workout is
 * status='completed'). It shows the session summary and the two post-finish
 * prompts, then closes back to the start surface.
 *
 * Summary: duration, total volume (in the app-wide unit), sets + exercises
 * counts, PR list with a
 * subtle celebratory glow (no confetti), and a "Gym habit ✓ logged" line when the
 * linked habit ticked.
 *
 * Post-finish prompt (behavior matrix, verdict × template presence):
 *   ┌──────────────────────┬───────────────────────────────────────────────┐
 *   │ had a template       │ verdict 'unchanged'    → no prompt              │
 *   │  (templateDiff.canUpdate) │ verdict 'values_changed' & canUpdate       │
 *   │                      │   → "Update template? [Values only] [Save as    │
 *   │                      │      new] [Keep]"                               │
 *   │                      │ verdict 'structure_changed' & canUpdate         │
 *   │                      │   → "Update template? [Update] [Values only]    │
 *   │                      │      [Save as new] [Keep original]"             │
 *   ├──────────────────────┼───────────────────────────────────────────────┤
 *   │ NO template          │ → "Save as template" name input + button        │
 *   └──────────────────────┴───────────────────────────────────────────────┘
 *
 * "Save as new" branches a DIVERGED session into its own template instead of
 * overwriting the one it came from. When the source template carries progression
 * policies, the save offers to bring them along (default on — a branched
 * programme keeping its rules is the common case; declining leaves every
 * exercise on the `last_time` default).
 *
 * Update maps to POST /apply-template-update {mode}: 'values' | 'structure'|'both'.
 * Save-as-template maps to POST /api/gym/templates {fromWorkoutId, name,
 * carryProgression}.
 * Every await → toast on failure, sheet stays open so the user can retry or dismiss.
 */
import { useState } from 'react'
import { Check, Trophy, X } from 'lucide-react'
import { toast } from 'sonner'

import { mmss } from '@/components/gym/exercises/format'
import { displayExerciseName } from '@/lib/gym/display-name'

import { applyTemplateUpdate, renameFinishedWorkout, saveWorkoutAsTemplate } from './templates-fetch'
import type { FinishSummary, WorkoutPr } from './store-contract'

const PR_KIND_LABEL: Record<WorkoutPr['kind'], string> = {
  weight: 'Top weight',
  e1rm: 'Est. 1RM',
  volume: 'Best set',
  reps: 'Most reps',
}

export function FinishSheet({
  workoutId,
  workoutName,
  summary,
  hadTemplate,
  onClose,
}: {
  workoutId: string
  /** The final workout name (for the save-as-template default). */
  workoutName: string | null
  summary: FinishSummary
  /** True when the workout ran from a template (drives which prompt shows). */
  hadTemplate: boolean
  /** Close the sheet → back to StartSurfaces (store already cleared). */
  onClose: () => void
}) {
  // Editable session name — a one-off finishes unnamed, and the finish sheet is
  // the natural naming moment. Committed (fire-and-forget) on blur and close;
  // the workout is already status='completed' so the PATCH takes the
  // completed-rename lane.
  const [sessionName, setSessionName] = useState(workoutName ?? '')
  function commitName() {
    const trimmed = sessionName.trim()
    if (trimmed === (workoutName ?? '').trim()) return
    void renameFinishedWorkout(workoutId, trimmed || null).catch(() => {})
  }
  function close() {
    commitName()
    onClose()
  }
  return (
    <div role="presentation" style={scrim} onClick={(e) => e.target === e.currentTarget && close()}>
      <style>{SHEET_CSS}</style>
      <aside className="gym-finish-sheet" role="dialog" aria-label="Workout finished">
        <button type="button" onClick={close} aria-label="Close" style={closeBtn}>
          <X size={15} strokeWidth={1.8} />
        </button>

        {/* Headline */}
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={doneBadge}>
            <Check size={18} strokeWidth={2.4} />
          </div>
          <h2 style={heading}>Workout logged</h2>
          <input
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            placeholder="Name this workout"
            aria-label="Workout name"
            enterKeyHint="done"
            style={sessionNameInput}
          />
        </div>

        {/* Stat grid */}
        <div style={statGrid}>
          <Stat label="Duration" value={mmss(summary.durationSeconds)} />
          <Stat label="Volume" value={`${summary.totalVolume.toLocaleString('en-US')} ${summary.weightUnit}`} />
          <Stat label="Sets" value={String(summary.setsCompleted)} />
          <Stat label="Exercises" value={String(summary.exercisesCompleted)} />
        </div>

        {/* Habit line */}
        {summary.habitLogged && (
          <div style={habitLine}>
            <Check size={13} strokeWidth={2.4} style={{ color: 'var(--success)' }} />
            Gym habit logged
          </div>
        )}

        {/* PRs — subtle celebratory glow */}
        {summary.prs.length > 0 && <PrList prs={summary.prs} />}

        {/* Template prompt */}
        {hadTemplate ? (
          <TemplateUpdatePrompt
            workoutId={workoutId}
            workoutName={workoutName}
            verdict={summary.templateDiff.verdict}
            canUpdate={summary.templateDiff.canUpdate}
            sourceTemplate={summary.sourceTemplate}
            onDone={close}
          />
        ) : (
          <SaveAsTemplate
            workoutId={workoutId}
            defaultName={workoutName}
            sourceTemplate={summary.sourceTemplate}
            onDone={close}
          />
        )}

        {/* Always a plain done */}
        <button type="button" onClick={close} style={doneBtn}>
          Done
        </button>
      </aside>
    </div>
  )
}

// ── PR list ──────────────────────────────────────────────────────────────────
/** One exercise's PRs, condensed from the flat per-kind list — a session can
 * beat top weight, e1RM, best set, and reps for the same exercise all at
 * once, and that's one row, not four. */
interface PrGroup {
  exerciseName: string
  isDebut: boolean
  entries: WorkoutPr[]
}

function groupPrs(prs: WorkoutPr[]): PrGroup[] {
  const groups = new Map<string, PrGroup>()
  for (const pr of prs) {
    let group = groups.get(pr.exerciseName)
    if (!group) {
      group = { exerciseName: displayExerciseName(pr.exerciseName), isDebut: pr.isDebut ?? false, entries: [] }
      groups.set(pr.exerciseName, group)
    }
    group.entries.push(pr)
  }
  return [...groups.values()]
}

function PrList({ prs }: { prs: WorkoutPr[] }) {
  const groups = groupPrs(prs)
  // A debut exercise (no prior history at all) trivially "beats" every kind —
  // call those out as first logs rather than inflating the PR headline.
  const records = groups.filter((g) => !g.isDebut)
  const firstLogs = groups.filter((g) => g.isDebut)
  return (
    <div className="gym-pr-card" style={prCard}>
      {records.length > 0 && (
        <>
          <div style={prHead}>
            <Trophy size={13} strokeWidth={1.9} style={{ color: 'var(--accent)' }} />
            <span>{records.length === 1 ? 'New personal record' : `${records.length} new records`}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {records.map((group) => (
              <PrGroupRow key={group.exerciseName} group={group} />
            ))}
          </div>
        </>
      )}
      {firstLogs.length > 0 && (
        <div style={{ marginTop: records.length > 0 ? 12 : 0 }}>
          <div style={prHead}>
            <span>{firstLogs.length === 1 ? 'Logged for the first time' : `${firstLogs.length} logged for the first time`}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {firstLogs.map((group) => (
              <PrGroupRow key={group.exerciseName} group={group} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PrGroupRow({ group }: { group: PrGroup }) {
  return (
    <div style={prRow}>
      <span style={prName}>{group.exerciseName}</span>
      <span style={prMeta}>
        {group.entries.map((pr, i) => (
          <span key={pr.kind}>
            {i > 0 && ' · '}
            <span style={prKind}>{PR_KIND_LABEL[pr.kind]}</span>{' '}
            <span style={prNum}>{formatPrValue(pr)}</span>
            {pr.prev != null && <span style={prPrev}> from {formatPrPrev(pr)}</span>}
          </span>
        ))}
      </span>
    </div>
  )
}

function formatPrValue(pr: WorkoutPr): string {
  if (pr.kind === 'reps') return `${pr.value} reps`
  return `${pr.value} ${pr.unit}`
}
function formatPrPrev(pr: WorkoutPr): string {
  if (pr.prev == null) return ''
  if (pr.kind === 'reps') return `${pr.prev}`
  return `${pr.prev} ${pr.unit}`
}

// ── template-update prompt (workout HAD a template) ─────────────────────────
function TemplateUpdatePrompt({
  workoutId,
  workoutName,
  verdict,
  canUpdate,
  sourceTemplate,
  onDone,
}: {
  workoutId: string
  workoutName: string | null
  verdict: FinishSummary['templateDiff']['verdict']
  canUpdate: boolean
  sourceTemplate: FinishSummary['sourceTemplate']
  onDone: () => void
}) {
  const [busy, setBusy] = useState<'structure' | 'values' | 'both' | null>(null)
  const [applied, setApplied] = useState(false)
  const [branching, setBranching] = useState(false)

  // Nothing to prompt when there's no deviation (or we can't update).
  if (!canUpdate || verdict === 'unchanged') return null

  async function apply(mode: 'structure' | 'values' | 'both') {
    setBusy(mode)
    try {
      await applyTemplateUpdate(workoutId, mode)
      setApplied(true)
      toast.success(mode === 'values' ? 'Template values updated' : 'Template updated')
      onDone()
    } catch {
      toast.error("Couldn't update the template")
    } finally {
      setBusy(null)
    }
  }

  if (applied) return null

  // Branching keeps the original untouched — the name input replaces the choices
  // rather than sitting under them, so there's one decision on screen at a time.
  if (branching) {
    return (
      <SaveAsTemplate
        workoutId={workoutId}
        defaultName={workoutName}
        sourceTemplate={sourceTemplate}
        title="Save this session as a new template"
        onCancel={() => setBranching(false)}
        onDone={onDone}
      />
    )
  }

  const structural = verdict === 'structure_changed'

  return (
    <div style={promptCard}>
      <div style={promptTitle}>
        {structural
          ? 'This session changed the template — update it?'
          : 'Weights or reps changed — update the template?'}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {structural && (
          <PromptBtn primary onClick={() => void apply('both')} loading={busy === 'both'}>
            Update template
          </PromptBtn>
        )}
        <PromptBtn
          primary={!structural}
          onClick={() => void apply('values')}
          loading={busy === 'values'}
        >
          {structural ? 'Values only' : 'Update values'}
        </PromptBtn>
        <PromptBtn onClick={() => setBranching(true)}>Save as new</PromptBtn>
        <PromptBtn onClick={onDone}>Keep original</PromptBtn>
      </div>
    </div>
  )
}

// ── save-as-template (workout had NO template) ──────────────────────────────
function SaveAsTemplate({
  workoutId,
  defaultName,
  sourceTemplate,
  title = 'Save this workout as a template?',
  onCancel,
  onDone,
}: {
  workoutId: string
  defaultName: string | null
  /** Present when this session ran from a template — drives the progression offer. */
  sourceTemplate: FinishSummary['sourceTemplate']
  title?: string
  /** Back out to the update choices (only shown when branching from a template). */
  onCancel?: () => void
  onDone: () => void
}) {
  const [name, setName] = useState(defaultName ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // Default ON: a branched programme almost always wants the same rules. Turning
  // it off leaves every exercise on the last_time default.
  const [carryProgression, setCarryProgression] = useState(true)
  const carryable = sourceTemplate?.progressionExercises ?? 0

  async function save() {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      await saveWorkoutAsTemplate(workoutId, trimmed, {
        carryProgression: carryable > 0 && carryProgression,
      })
      setSaved(true)
      toast.success(
        carryable > 0 && carryProgression
          ? `Saved "${trimmed}" with ${carryable} progression rule${carryable === 1 ? '' : 's'}`
          : `Saved "${trimmed}" as a template`,
      )
      onDone()
    } catch {
      toast.error("Couldn't save that template")
    } finally {
      setSaving(false)
    }
  }

  if (saved) return null

  return (
    <div style={promptCard}>
      <div style={promptTitle}>{title}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
          placeholder="Template name"
          aria-label="Template name"
          style={nameInput}
        />
        <PromptBtn primary onClick={() => void save()} loading={saving} disabled={!name.trim()}>
          Save
        </PromptBtn>
        {onCancel && <PromptBtn onClick={onCancel}>Back</PromptBtn>}
      </div>
      {carryable > 0 && (
        <label style={carryRow}>
          <input
            type="checkbox"
            checked={carryProgression}
            onChange={(e) => setCarryProgression(e.target.checked)}
            style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
          />
          <span>
            Carry over {carryable} progression rule{carryable === 1 ? '' : 's'} from{' '}
            {sourceTemplate?.name}
          </span>
        </label>
      )}
    </div>
  )
}

// ── small bits ───────────────────────────────────────────────────────────────
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statCell}>
      <div style={statVal}>{value}</div>
      <div style={statLabel}>{label}</div>
    </div>
  )
}

function PromptBtn({
  children,
  onClick,
  primary,
  loading,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  primary?: boolean
  loading?: boolean
  disabled?: boolean
}) {
  const off = disabled || loading
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={off}
      style={{
        padding: '9px 14px',
        fontFamily: 'var(--font-mono)',
        fontSize: 11.5,
        letterSpacing: '0.03em',
        borderRadius: 8,
        cursor: off ? 'default' : 'pointer',
        border: `1px solid ${primary ? 'var(--accent)' : 'var(--border-muted)'}`,
        background: primary ? 'var(--accent)' : 'var(--bg-elevated)',
        color: primary ? 'var(--accent-fg)' : 'var(--fg-muted)',
        opacity: off ? 0.6 : 1,
        whiteSpace: 'nowrap',
      }}
    >
      {loading ? 'Working…' : children}
    </button>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────
const SHEET_CSS = `
.gym-finish-sheet {
  position: fixed; z-index: 60;
  background: var(--bg); border: 1px solid var(--border);
  box-shadow: var(--shadow-floating, 0 12px 48px rgba(0,0,0,.5));
  overflow-y: auto; -webkit-overflow-scrolling: touch;
  left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 440px; max-width: 92vw; max-height: 88vh;
  border-radius: 16px; padding: 26px 22px 22px;
  animation: gym-finish-in .24s cubic-bezier(.16,1,.3,1);
}
@keyframes gym-finish-in { from { transform: translate(-50%, calc(-50% + 16px)); opacity: .5; } to { transform: translate(-50%, -50%); opacity: 1; } }
.gym-pr-card { animation: gym-pr-glow 2.6s ease-in-out infinite alternate; }
@keyframes gym-pr-glow {
  from { box-shadow: 0 0 0 1px color-mix(in oklch, var(--accent) 25%, transparent); }
  to   { box-shadow: 0 0 20px 1px color-mix(in oklch, var(--accent) 30%, transparent); }
}
@media (max-width: 700px) {
  .gym-finish-sheet {
    left: 0; right: 0; top: auto; bottom: 0; transform: none;
    width: 100%; max-width: 100%; max-height: 92vh;
    border-radius: 16px 16px 0 0;
    animation: gym-finish-up .26s cubic-bezier(.16,1,.3,1);
  }
  @keyframes gym-finish-up { from { transform: translateY(20px); opacity: .5; } to { transform: none; opacity: 1; } }
}
@media (prefers-reduced-motion: reduce) {
  .gym-finish-sheet, .gym-pr-card { animation: none !important; }
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
}
const doneBadge: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 44,
  height: 44,
  borderRadius: '50%',
  background: 'color-mix(in oklch, var(--success) 18%, transparent)',
  color: 'var(--success)',
  marginBottom: 10,
}
const heading: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontWeight: 400,
  fontSize: 24,
  letterSpacing: '-0.01em',
  margin: 0,
  color: 'var(--fg)',
}
const sessionNameInput: React.CSSProperties = {
  display: 'block',
  width: '78%',
  margin: '6px auto 0',
  padding: '4px 8px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13.5,
  textAlign: 'center',
  color: 'var(--fg-muted)',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px dashed var(--border-muted)',
  borderRadius: 0,
  outline: 'none',
}
const statGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: 8,
  marginBottom: 14,
}
const statCell: React.CSSProperties = {
  padding: '10px 6px',
  borderRadius: 10,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  textAlign: 'center',
}
const statVal: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--fg)',
  fontVariantNumeric: 'tabular-nums',
}
const statLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  marginTop: 3,
}
const habitLine: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  color: 'var(--fg-muted)',
  marginBottom: 14,
}
const prCard: React.CSSProperties = {
  padding: 14,
  borderRadius: 12,
  background: 'color-mix(in oklch, var(--accent) 7%, var(--bg-elevated))',
  border: '1px solid color-mix(in oklch, var(--accent) 35%, var(--border-muted))',
  marginBottom: 14,
}
const prHead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 10,
}
const prRow: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
}
const prName: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--fg)',
}
const prMeta: React.CSSProperties = {
  display: 'block',
}
const prKind: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const prNum: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--fg)',
  fontVariantNumeric: 'tabular-nums',
}
const prPrev: React.CSSProperties = {
  fontWeight: 400,
  fontSize: 10.5,
  color: 'var(--fg-subtle)',
}
const promptCard: React.CSSProperties = {
  padding: 14,
  borderRadius: 12,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  marginBottom: 14,
}
const promptTitle: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 13.5,
  color: 'var(--fg)',
  lineHeight: 1.4,
}
const nameInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '9px 11px',
  fontSize: 14,
  fontFamily: 'var(--font-sans)',
  color: 'var(--fg)',
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  outline: 'none',
}
const carryRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 10,
  fontSize: 12.5,
  lineHeight: 1.35,
  color: 'var(--fg-muted)',
  cursor: 'pointer',
}
const doneBtn: React.CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  fontFamily: 'var(--font-sans)',
  fontSize: 14.5,
  fontWeight: 500,
  color: 'var(--fg-muted)',
  background: 'transparent',
  border: '1px solid var(--border-muted)',
  borderRadius: 12,
  cursor: 'pointer',
}
