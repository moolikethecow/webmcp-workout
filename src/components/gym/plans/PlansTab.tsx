'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, ChevronDown, ChevronUp, Pause, Play, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { HCard, MonoLabel } from '@/components/health/primitives'
import { GymEmptyState } from '@/components/gym/shell/GymEmptyState'
import { useChatPageContext } from '@/lib/chat/page-context'
import type {
  PeriodizationBlock,
  TrainingPlan,
  TrainingPlanDayInput,
} from '@/lib/gym/training-plans'

interface TemplateOption {
  id: string
  name: string
}

interface DraftDay extends TrainingPlanDayInput {
  key: string
}

const makeDay = (index: number, template?: TemplateOption): DraftDay => ({
  key: crypto.randomUUID(),
  name: template?.name ?? `Day ${index + 1}`,
  templateId: template?.id ?? '',
  weekday: null,
  notes: null,
})

export default function PlansTab() {
  const [plans, setPlans] = useState<TrainingPlan[]>([])
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showBuilder, setShowBuilder] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [plansRes, templatesRes] = await Promise.all([
        fetch('/api/gym/plans', { cache: 'no-store' }),
        fetch('/api/gym/templates', { cache: 'no-store' }),
      ])
      if (!plansRes.ok || !templatesRes.ok) throw new Error('Could not load plans')
      const planJson = await plansRes.json() as { plans?: TrainingPlan[] }
      const templateJson = await templatesRes.json() as { templates?: TemplateOption[] }
      setPlans(Array.isArray(planJson.plans) ? planJson.plans : [])
      setTemplates(Array.isArray(templateJson.templates) ? templateJson.templates : [])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load plans'
      setError(message)
      toast.error("Couldn't load training plans — try again.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useChatPageContext({
    current_page: '/gym?tab=plans',
    gym_artifact: JSON.stringify({
      kind: 'training_plans',
      plans: plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        goal: plan.goal,
        status: plan.status,
        version: plan.version,
        nextDay: plan.nextDay?.name ?? null,
        days: plan.days.map((day) => ({ position: day.position + 1, name: day.name, template: day.templateName, available: day.available })),
        policy: plan.policy,
      })),
    }),
    gym_reference_rules: 'Use manage_training_plan for plan writes. Resolve ordinal day references against this ordered snapshot and re-read the canonical plan before updating it.',
  })

  const mutateStatus = async (plan: TrainingPlan, status: 'active' | 'paused' | 'archived') => {
    setBusyId(plan.id)
    try {
      const res = await fetch(`/api/gym/plans/${plan.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Update failed')
      toast.success(status === 'archived' ? 'Plan archived' : status === 'paused' ? 'Plan paused' : 'Plan resumed')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update plan')
    } finally {
      setBusyId(null)
    }
  }

  const start = async (plan: TrainingPlan) => {
    setBusyId(plan.id)
    try {
      const res = await fetch(`/api/gym/plans/${plan.id}/start`, { method: 'POST', body: '{}' })
      if (res.status === 409) {
        window.location.assign('/gym?tab=train')
        return
      }
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Start failed')
      window.location.assign('/gym?tab=train')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start plan')
      setBusyId(null)
    }
  }

  return (
    <div style={page}>
      <style>{`
        @media (max-width: 560px) {
          .gym-plan-draft-day {
            grid-template-columns: 25px minmax(0, 1fr) 44px !important;
            grid-template-areas: "number name remove" "number template remove" !important;
          }
          .gym-plan-draft-number { grid-area: number; }
          .gym-plan-draft-name { grid-area: name; }
          .gym-plan-draft-template { grid-area: template; }
          .gym-plan-draft-remove { grid-area: remove; }
        }
      `}</style>
      <div style={header}>
        <MonoLabel>Plans</MonoLabel>
        <div style={{ flex: 1 }} />
        <div style={headerActions}>
          <button
            type="button"
            style={primaryButton}
            aria-expanded={showBuilder}
            onClick={() => setShowBuilder((value) => !value)}
          >
            <Plus size={15} /> {showBuilder ? 'Close builder' : 'New plan'}
          </button>
        </div>
      </div>

      {showBuilder && (
        <PlanBuilder
          templates={templates}
          onCancel={() => setShowBuilder(false)}
          onCreated={async () => { setShowBuilder(false); await load() }}
        />
      )}

      {error && <p style={note}>Couldn&rsquo;t load training plans.</p>}
      {loading ? (
        <p style={note}>Loading plans…</p>
      ) : plans.length === 0 && !error ? (
        <HCard pad={20}>
          <GymEmptyState
            title="No training plans yet."
            body="Start with a template-backed split, then let the plan carry the workout order and progression rules."
          />
          <button type="button" style={emptyAction} onClick={() => setShowBuilder(true)}>
            <Plus size={15} /> Build your first plan
          </button>
        </HCard>
      ) : (
        <div style={grid}>
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              busy={busyId === plan.id}
              onStart={() => void start(plan)}
              onStatus={(status) => void mutateStatus(plan, status)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PlanCard({
  plan,
  busy,
  onStart,
  onStatus,
}: {
  plan: TrainingPlan
  busy: boolean
  onStart: () => void
  onStatus: (status: 'active' | 'paused' | 'archived') => void
}) {
  const [expanded, setExpanded] = useState(false)
  const policy = plan.policy.progression
  const rule = policy.type === 'double_progression'
    ? `${policy.requiredSets ?? 3}×${policy.repRange[0]}–${policy.repRange[1]} · +${policy.increment} when all sets clear`
    : policy.type.replaceAll('_', ' ')
  const nextAvailable = plan.nextDay?.available !== false

  return (
    <article style={{ height: '100%' }}>
      <HCard pad={16} style={card}>
        <div style={cardTop}>
          <div>
            <MonoLabel style={{ color: 'var(--accent)' }}>{plan.status}</MonoLabel>
            <h3 style={cardTitle}>{plan.name}</h3>
            {plan.goal && <p style={goal}>{plan.goal}</p>}
          </div>
          <span style={version}>v{plan.version}</span>
        </div>

        <div style={nextBox}>
          <MonoLabel>Next</MonoLabel>
          <strong>{plan.nextDay?.name ?? 'No day configured'}</strong>
          <span>{plan.nextDay?.templateName ?? 'Add a template'}</span>
          {!nextAvailable && <small style={unavailable}>Template archived — restore or replace it to start.</small>}
          {plan.currentBlock && <span style={blockPill}>{plan.currentBlock.name} · cycle {plan.currentBlock.cycle + 1}</span>}
        </div>

        <div style={ruleBox}>
          <span>{plan.policy.autoAdjustTargets ? 'Auto-adjusting progression' : 'Preview only · targets stay unchanged'}</span>
          <strong>{rule}</strong>
          <small>After {policy.type === 'double_progression' ? `${policy.deloadAfterMisses ?? 2} misses, deload ${policy.deloadPct ?? 10}%` : 'the stored rule clears'}</small>
        </div>

        <div style={plan.reviewDue ? reviewDueBox : reviewBox}>
          {plan.reviewDue
            ? 'Plan review due — revisit it before the next block.'
            : `Next plan review in ${plan.sessionsUntilReview} session${plan.sessionsUntilReview === 1 ? '' : 's'}.`}
        </div>

        {plan.nextTargets && plan.nextTargets.length > 0 && (
          <div style={decisions}>
            {plan.nextTargets.slice(0, 3).map((target) => (
              <div key={target.exerciseId} style={decisionRow}>
                <strong>{target.exerciseName}</strong>
                <span>{target.decision}</span>
                {!target.managed && <small>Saved prescription · not auto-adjusted</small>}
              </div>
            ))}
          </div>
        )}

        <button type="button" style={expandButton} onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {plan.days.length} day{plan.days.length === 1 ? '' : 's'} · {plan.completedSessions} completed
        </button>
        {expanded && (
          <ol style={dayList}>
            {plan.days.map((day) => (
              <li key={day.id} style={dayRow}>
                <span style={dayNumber}>{day.position + 1}</span>
                <span><strong>{day.name}</strong><small>{day.templateName} · {day.exerciseCount} exercises{day.available ? '' : ' · archived'}</small></span>
              </li>
            ))}
          </ol>
        )}

        <div style={cardActions}>
          {plan.status === 'active' ? (
            <>
              <button type="button" style={primaryButton} disabled={busy || !plan.nextDay || !nextAvailable} onClick={onStart}>
                <Play size={14} /> Start next
              </button>
              <button type="button" style={iconButton} disabled={busy} onClick={() => onStatus('paused')} aria-label={`Pause ${plan.name}`}>
                <Pause size={15} />
              </button>
            </>
          ) : (
            <button type="button" style={primaryButton} disabled={busy} onClick={() => onStatus('active')}>
              <Play size={14} /> Resume
            </button>
          )}
          <button type="button" style={iconButton} disabled={busy} onClick={() => onStatus('archived')} aria-label={`Archive ${plan.name}`}>
            <Archive size={15} />
          </button>
        </div>
      </HCard>
    </article>
  )
}

function PlanBuilder({
  templates,
  onCancel,
  onCreated,
}: {
  templates: TemplateOption[]
  onCancel: () => void
  onCreated: () => Promise<void>
}) {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [days, setDays] = useState<DraftDay[]>(() => [makeDay(0, templates[0])])
  const [sets, setSets] = useState(3)
  const [repLow, setRepLow] = useState(8)
  const [repHigh, setRepHigh] = useState(10)
  const [increment, setIncrement] = useState(5)
  const [misses, setMisses] = useState(2)
  const [periodization, setPeriodization] = useState<'none' | 'base-deload' | 'three-block'>('none')
  const [saving, setSaving] = useState(false)

  const blocks = useMemo<PeriodizationBlock[]>(() => {
    if (periodization === 'base-deload') return [
      { name: 'Build', weeks: 4 },
      { name: 'Deload', weeks: 1, volumeMultiplier: 0.6, loadMultiplier: 0.85, targetRpe: 6, deload: true },
    ]
    if (periodization === 'three-block') return [
      { name: 'Accumulation', weeks: 4, repRange: [8, 12], volumeMultiplier: 1.1 },
      { name: 'Intensification', weeks: 3, repRange: [5, 8], volumeMultiplier: 0.85, targetRpe: 8 },
      { name: 'Deload', weeks: 1, volumeMultiplier: 0.5, loadMultiplier: 0.8, targetRpe: 6, deload: true },
    ]
    return []
  }, [periodization])

  const submit = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/gym/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          goal,
          scheduleMode: 'flexible',
          days: days.map(({ key: _key, ...day }) => day),
          policy: {
            progression: {
              type: 'double_progression',
              repRange: [repLow, repHigh],
              increment,
              requiredSets: sets,
              deloadAfterMisses: misses,
              deloadPct: 10,
            },
            applyToUnconfiguredExercises: true,
            autoAdjustTargets: true,
            reviewEverySessions: Math.max(1, days.length),
            blocks,
            repeatBlocks: periodization !== 'none',
          },
        }),
      })
      const json = await res.json() as { error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Could not create plan')
      toast.success('Training plan created')
      await onCreated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create plan')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-label="New training plan">
      <HCard pad={16} style={builder}>
        <MonoLabel>New training plan</MonoLabel>
        <div style={builderGrid}>
          <label style={field}>Plan name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="4-day upper / lower" style={input} /></label>
          <label style={field}>Goal<input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Slow, repeatable strength gain" style={input} /></label>
        </div>

        <div style={sectionHeading}><MonoLabel>Workout order</MonoLabel><span>Flexible sequence; no forced weekdays.</span></div>
        <div style={draftDays}>
          {days.map((day, index) => (
            <div key={day.key} className="gym-plan-draft-day" style={draftDay}>
              <span className="gym-plan-draft-number" style={dayNumber}>{index + 1}</span>
              <input className="gym-plan-draft-name" value={day.name} onChange={(event) => setDays((current) => current.map((row) => row.key === day.key ? { ...row, name: event.target.value } : row))} aria-label={`Day ${index + 1} name`} style={input} />
              <select className="gym-plan-draft-template" value={day.templateId} onChange={(event) => {
                const template = templates.find((row) => row.id === event.target.value)
                setDays((current) => current.map((row) => row.key === day.key ? { ...row, templateId: event.target.value, name: row.name.startsWith('Day ') && template ? template.name : row.name } : row))
              }} aria-label={`Day ${index + 1} template`} style={input}>
                <option value="">Choose template</option>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              </select>
              {days.length > 1 && <button type="button" className="gym-plan-draft-remove" style={iconButton} onClick={() => setDays((current) => current.filter((row) => row.key !== day.key))} aria-label={`Remove day ${index + 1}`}>×</button>}
            </div>
          ))}
        </div>
        <button type="button" style={secondaryButton} disabled={days.length >= 7 || templates.length === 0} onClick={() => setDays((current) => [...current, makeDay(current.length, templates[0])])}>
          <Plus size={14} /> Add day
        </button>

        <div style={sectionHeading}><MonoLabel>Progression rule</MonoLabel><span>Evaluated after every session.</span></div>
        <div style={numberGrid}>
          <NumberField label="Sets" value={sets} onChange={setSets} min={1} max={8} />
          <NumberField label="Rep floor" value={repLow} onChange={setRepLow} min={1} max={30} />
          <NumberField label="Rep ceiling" value={repHigh} onChange={setRepHigh} min={repLow} max={40} />
          <NumberField label="Weight bump" value={increment} onChange={setIncrement} min={0.25} max={100} step={0.25} />
          <NumberField label="Misses before deload" value={misses} onChange={setMisses} min={1} max={8} />
        </div>
        <p style={plainRule}>Do {sets} sets at one weight. Clear {repHigh} reps on all {sets} → add {increment}. Miss the {repLow}-rep floor for {misses} sessions → deload 10%.</p>

        <label style={field}>Periodization
          <select value={periodization} onChange={(event) => setPeriodization(event.target.value as typeof periodization)} style={input}>
            <option value="none">None — run the progression rule continuously</option>
            <option value="base-deload">4 build cycles + 1 deload</option>
            <option value="three-block">4 accumulation + 3 intensification + 1 deload</option>
          </select>
        </label>

        <div style={builderActions}>
          <button type="button" style={secondaryButton} onClick={onCancel}>Cancel</button>
          <button type="button" style={primaryButton} disabled={saving || !name.trim() || days.some((day) => !day.templateId)} onClick={() => void submit()}>
            {saving ? 'Saving…' : 'Create plan'}
          </button>
        </div>
      </HCard>
    </section>
  )
}

function NumberField({ label, value, onChange, min, max, step = 1 }: { label: string; value: number; onChange: (value: number) => void; min: number; max: number; step?: number }) {
  return <label style={field}>{label}<input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} style={input} /></label>
}

const page: React.CSSProperties = { display: 'grid', gap: 16, paddingBottom: 96 }
const header: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
const headerActions: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' }
const buttonBase: React.CSSProperties = { minHeight: 32, padding: '6px 12px', borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: 13, cursor: 'pointer' }
const primaryButton: React.CSSProperties = { ...buttonBase, border: 0, background: 'var(--accent)', color: 'var(--accent-fg)' }
const secondaryButton: React.CSSProperties = { ...buttonBase, border: '1px solid var(--border-muted)', background: 'var(--bg-elevated)', color: 'var(--fg)' }
const iconButton: React.CSSProperties = { ...secondaryButton, width: 32, padding: 0 }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 14 }
const card: React.CSSProperties = { height: '100%', display: 'grid', gap: 13, alignContent: 'start' }
const cardTop: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12 }
const cardTitle: React.CSSProperties = { margin: '5px 0 0', fontFamily: 'var(--font-sans)', fontSize: 17, fontWeight: 550, color: 'var(--fg)' }
const goal: React.CSSProperties = { margin: '4px 0 0', color: 'var(--fg-muted)', fontSize: 12, lineHeight: 1.45 }
const version: React.CSSProperties = { color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)', fontSize: 10 }
const nextBox: React.CSSProperties = { padding: 12, borderRadius: 10, border: '1px solid var(--border-muted)', background: 'var(--bg-subtle)', display: 'grid', gap: 4 }
const blockPill: React.CSSProperties = { marginTop: 5, width: 'fit-content', padding: '3px 7px', borderRadius: 999, background: 'var(--bg-elevated)', color: 'var(--fg-muted)', fontSize: 10 }
const ruleBox: React.CSSProperties = { display: 'grid', gap: 3, fontSize: 11, color: 'var(--fg-muted)' }
const reviewBox: React.CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-muted)', background: 'var(--bg-subtle)', color: 'var(--fg-muted)', fontSize: 11 }
const reviewDueBox: React.CSSProperties = { ...reviewBox, borderColor: 'color-mix(in oklch, var(--accent) 35%, var(--border-muted))', color: 'var(--fg)' }
const unavailable: React.CSSProperties = { color: 'var(--danger)', marginTop: 3 }
const decisions: React.CSSProperties = { display: 'grid', gap: 7 }
const decisionRow: React.CSSProperties = { display: 'grid', gap: 2, paddingLeft: 10, borderLeft: '2px solid var(--accent)', fontSize: 11, color: 'var(--fg-muted)' }
const expandButton: React.CSSProperties = { border: 0, background: 'transparent', color: 'var(--fg-muted)', padding: '6px 0', display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', width: 'fit-content' }
const dayList: React.CSSProperties = { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 7 }
const dayRow: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'center' }
const dayNumber: React.CSSProperties = { width: 25, height: 25, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', fontSize: 10, flex: '0 0 auto' }
const cardActions: React.CSSProperties = { display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 'auto' }
const emptyAction: React.CSSProperties = { ...buttonBase, minHeight: 42, marginTop: 16, padding: '10px 16px', background: 'var(--accent)', color: 'var(--accent-fg)', border: 0, fontSize: 14 }
const builder: React.CSSProperties = { display: 'grid', gap: 16 }
const builderGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }
const field: React.CSSProperties = { display: 'grid', gap: 5, fontFamily: 'var(--font-mono)', letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--fg-subtle)', fontSize: 9.5 }
const input: React.CSSProperties = { width: '100%', minHeight: 42, border: '1px solid var(--border-muted)', borderRadius: 8, background: 'var(--bg-subtle)', color: 'var(--fg)', padding: '8px 10px', fontFamily: 'var(--font-sans)', fontSize: 13, textTransform: 'none', letterSpacing: 'normal' }
const sectionHeading: React.CSSProperties = { display: 'grid', gap: 2, marginTop: 3, fontSize: 13, color: 'var(--fg-muted)' }
const draftDays: React.CSSProperties = { display: 'grid', gap: 8 }
const draftDay: React.CSSProperties = { display: 'grid', gridTemplateColumns: '25px minmax(110px, .7fr) minmax(150px, 1fr) 44px', gridTemplateAreas: '"number name template remove"', gap: 8, alignItems: 'center' }
const numberGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }
const plainRule: React.CSSProperties = { margin: 0, padding: 11, borderRadius: 8, border: '1px solid var(--border-muted)', background: 'var(--bg-subtle)', color: 'var(--fg-muted)', fontSize: 12, lineHeight: 1.5 }
const builderActions: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 12, borderTop: '1px solid var(--border-muted)' }
const note: React.CSSProperties = { margin: 0, fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 13, lineHeight: 1.55, color: 'var(--fg-subtle)' }
