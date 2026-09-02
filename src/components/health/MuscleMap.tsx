'use client'

/**
 * The muscle map for /health — an interactive human figure (front + back) whose
 * regions are colored by deterministic training/recovery state, with a tap panel
 * showing last-worked, weekly volume + trend, and the paired body measurement.
 * Read-only over the imported Strong workouts (via /api/health/muscle-map).
 * Mobile-first: figures scale, the panel stacks below on narrow screens.
 * Presentation: vendored anatomical artwork + motion in MuscleFigure; the panel
 * slides in per selection and its numbers count up (both reduced-motion aware).
 */
import { useEffect, useMemo, useState } from 'react'
import { animate, motion } from 'motion/react'
import { Dumbbell } from 'lucide-react'

import type { MuscleRegion } from '@/lib/fitness/muscles'
import { MuscleFigure, muscleFill, usePrefersReducedMotion, type RegionPaint } from './MuscleFigure'

type State = 'recovering' | 'ready' | 'fresh' | 'undertrained' | 'untrained'

interface RegionMeasurement {
  label: string
  unit: string
  latest: number | null
  latestDate: string | null
  delta: number | null
  readings: number
}
interface Region {
  region: MuscleRegion
  label: string
  state: State
  /** Days since last WORKED (primary or secondary). */
  daysSince: number | null
  /** Days since last trained DIRECTLY (primary mover). */
  daysSincePrimary: number | null
  weeklySets: number
  priorWeeklySets: number
  volumeTrend: -1 | 0 | 1
  exercises: string[]
  measurement: RegionMeasurement | null
  /** §10b.5 mobility lens (optional: server may predate this bundle). */
  mobilityMinutes?: number
  priorMobilityMinutes?: number
  daysSinceMobility?: number | null
}

// Session drill-down (lazy per region) — the recent sets that trained this muscle.
interface DrillSet {
  setNumber: number
  weight: number | null
  reps: number | null
  unit: string
  warmup: boolean
}
interface DrillExercise {
  name: string
  primary: boolean
  sets: DrillSet[]
}
interface DrillSession {
  date: string
  workoutName: string | null
  exercises: DrillExercise[]
}
interface MapData {
  windowDays: number
  regions: Record<MuscleRegion, Region>
  legend: { state: State; label: string; hint: string }[]
  hasData: boolean
  mobility?: {
    weekMinutes: number
    priorWeekMinutes: number
    regionsWorked: number
    targetMinutes: number
  }
}

type Lens = 'recovery' | 'mobility'

/** Mobility-lens paint: minutes vs the weekly target, mapped onto existing
 *  figure states so MuscleFigure's duotone/motion treatment carries over.
 *  none → untrained (grey) · below target → ready (amber) · on target → fresh. */
function mobilityPaintState(minutes: number, target: number): State {
  if (minutes <= 0) return 'untrained'
  if (minutes < target) return 'ready'
  return 'fresh'
}

const MOBILITY_LEGEND: { state: State; label: string; hint: string }[] = [
  { state: 'fresh', label: 'On target', hint: '≥ weekly target of hold minutes' },
  { state: 'ready', label: 'Below target', hint: 'Some hold minutes this week, under target' },
  { state: 'untrained', label: 'None', hint: 'No mobility work this week' },
]

// Mirror of lib/fitness/muscle-state STATE_META colors (client keeps a literal
// copy; the MuscleMap state-color sync test asserts they never drift).
export const STATE_COLOR: Record<State, string> = {
  recovering: 'var(--danger)',
  ready: 'var(--warning)',
  fresh: 'var(--success)',
  undertrained: 'var(--fg-subtle)',
  untrained: 'var(--border-muted)',
}
const STATE_LABEL: Record<State, string> = {
  recovering: 'Recovering',
  ready: 'Ready',
  fresh: 'Fresh',
  undertrained: 'Undertrained',
  untrained: 'No data',
}

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—'
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

// Keep Gym's canonical body figure at the same useful size as the Health Body
// measurement figure. The recent-set viewport scales with that visual footprint
// so growing the anatomy does not leave the detail panel looking artificially
// clipped. Pagination still prevents a deep history from growing the page.
const MUSCLE_FIGURE_MAX_WIDTH = 330
const SESSIONS_PER_PAGE = 3
const RECENT_SETS_MAX_HEIGHT = MUSCLE_FIGURE_MAX_WIDTH

export function MuscleMap() {
  const [data, setData] = useState<MapData | null>(null)
  const [err, setErr] = useState(false)
  const [view, setView] = useState<'front' | 'back'>('front')
  const [lens, setLens] = useState<Lens>('recovery')
  // held = the LOCKED region (an explicit tap); it survives mouse-out and drives
  // the panel until you tap it again or hit Back. hoverPreview = the last muscle
  // the cursor/focus is over — only used when nothing is held (#1040).
  const [held, setHeld] = useState<MuscleRegion | null>(null)
  const [hoverPreview, setHoverPreview] = useState<MuscleRegion | null>(null)

  // Tap acts as a hold-toggle: tapping the held muscle releases it; tapping a
  // different muscle switches the lock.
  const toggleHold = (region: MuscleRegion) =>
    setHeld((cur) => (cur === region ? null : region))

  // A held joint region is stale once you leave the mobility lens (joints are
  // only tappable there), so drop the lock on any lens switch. The front/back
  // flip intentionally keeps the lock — today's cross-view behavior survives.
  useEffect(() => {
    setHeld(null)
  }, [lens])

  useEffect(() => {
    const load = () =>
      fetch('/api/health/muscle-map')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: MapData) => setData(d))
        .catch(() => setErr(true))
    void load()
    const onImport = () => void load()
    window.addEventListener('gym:history-imported', onImport)
    return () => window.removeEventListener('gym:history-imported', onImport)
  }, [])

  const paint = useMemo(() => {
    const out: Partial<Record<MuscleRegion, RegionPaint>> = {}
    if (!data) return out
    const target = data.mobility?.targetMinutes ?? 10
    for (const region of Object.values(data.regions)) {
      const state =
        lens === 'mobility'
          ? mobilityPaintState(region.mobilityMinutes ?? 0, target)
          : region.state
      out[region.region] = { color: STATE_COLOR[state], state }
    }
    return out
  }, [data, lens])

  if (err) return <p style={noteStyle}>Couldn’t load the muscle map.</p>
  if (!data) return <p style={noteStyle}>Loading…</p>
  if (!data.hasData) {
    return (
      <p style={noteStyle}>
        No workout data yet — import a Strong export to light up the muscle map.
      </p>
    )
  }

  // Held wins; otherwise fall back to the live hover/focus preview.
  const activeRegion = held ?? hoverPreview
  const sel = activeRegion ? data.regions[activeRegion] : null

  return (
    <section>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <h3 style={headerStyle}>
          <Dumbbell size={12} strokeWidth={1.7} style={{ verticalAlign: -1, marginRight: 6 }} />
          Muscle map <span style={subtle}>(last {data.windowDays}d)</span>
        </h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={toggleWrap} role="tablist" aria-label="Map lens">
            {(['recovery', 'mobility'] as const).map((l) => (
              <button
                key={l}
                role="tab"
                aria-selected={lens === l}
                onClick={() => setLens(l)}
                style={{ ...toggleBtn, ...(lens === l ? toggleBtnActive : {}) }}
              >
                {l === 'recovery' ? 'Recovery' : 'Mobility'}
              </button>
            ))}
          </div>
          <div style={toggleWrap} role="tablist" aria-label="Figure view">
            {(['front', 'back'] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                style={{ ...toggleBtn, ...(view === v ? toggleBtnActive : {}) }}
              >
                {v === 'front' ? 'Front' : 'Back'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {lens === 'mobility' && data.mobility && (
        <p style={{ ...noteStyle, padding: '0 0 10px' }}>
          This week:{' '}
          <span style={{ fontFamily: 'var(--font-mono)', fontStyle: 'normal', color: 'var(--fg)' }}>
            {fmt(data.mobility.weekMinutes)} min
          </span>{' '}
          across {data.mobility.regionsWorked} region{data.mobility.regionsWorked === 1 ? '' : 's'}
          {data.mobility.priorWeekMinutes > 0 && ` (prior week ${fmt(data.mobility.priorWeekMinutes)} min)`}
          {' · '}target {data.mobility.targetMinutes} min/muscle
        </p>
      )}

      {lens === 'mobility' && <AssessmentBlock />}

      <div style={grid}>
        {/* Figure */}
        <div style={figureCol}>
          <div style={{ width: '100%', maxWidth: MUSCLE_FIGURE_MAX_WIDTH, margin: '0 auto' }}>
            <MuscleFigure
              view={view}
              paint={paint}
              selected={held}
              onSelect={toggleHold}
              onHoverRegion={setHoverPreview}
              mobilityRegions={lens === 'mobility'}
            />
          </div>
          <Legend legend={lens === 'mobility' ? MOBILITY_LEGEND : data.legend} />
        </div>

        {/* Detail panel */}
        <div style={panelCol}>
          {sel ? (
            <RegionPanel
              key={`${sel.region}-${lens}`}
              region={sel}
              lens={lens}
              target={data.mobility?.targetMinutes ?? 10}
              // Back only when the panel is LOCKED — touch users can't reliably
              // re-tap a tiny region to untoggle, so give them an explicit release.
              onBack={held ? () => setHeld(null) : undefined}
            />
          ) : (
            <div style={{ ...panelCard, color: 'var(--fg-subtle)' }}>
              <p style={{ margin: 0, fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 13 }}>
                {lens === 'mobility'
                  ? 'Tap a muscle to see its stretch minutes this week against the weekly target.'
                  : 'Tap a muscle to see when it was last worked, its weekly volume, your measurements, and the recent sets that trained it.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/** Animated number — counts up from 0 on first reveal (per panel mount).
 *  Reduced motion renders the final value immediately. */
function CountUp({ value, unit }: { value: number; unit?: string }) {
  const reduced = usePrefersReducedMotion()
  const [display, setDisplay] = useState(reduced ? value : 0)
  useEffect(() => {
    if (reduced) {
      setDisplay(value)
      return
    }
    const controls = animate(0, value, {
      duration: 0.65,
      ease: [0.2, 0.8, 0.2, 1],
      onUpdate: (v) => setDisplay(v),
    })
    return () => controls.stop()
  }, [value, reduced])
  // match the target's precision while animating so "12" never flashes "11.7"
  const text = Number.isInteger(value) ? String(Math.round(display)) : display.toFixed(1)
  return (
    <span style={{ fontFamily: 'var(--font-mono)' }}>
      {text}
      {unit ? ` ${unit}` : ''}
    </span>
  )
}

/** "185 × 5", "12 reps" (bodyweight), "45 s" (timed) — one set, compactly. */
function fmtSet(s: DrillSet): string {
  if (s.weight != null && s.weight > 0) return `${fmt(s.weight)} × ${s.reps ?? '—'}`
  if (s.reps != null) return `${s.reps} reps`
  return '—'
}

/** ‹ Back — releases a held panel. Only rendered when the selection is locked;
 *  the primary release is re-tapping the muscle, but a tiny region is an
 *  unreliable touch target, so this gives an always-hittable deselect (#1040). */
function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} aria-label="Back to hover preview" style={backBtn}>
      ‹ Back
    </button>
  )
}

function RegionPanel({
  region,
  lens,
  target,
  onBack,
}: {
  region: Region
  lens: Lens
  target: number
  /** Present only when the panel is held (locked) — renders the ‹ Back release. */
  onBack?: () => void
}) {
  const reduced = usePrefersReducedMotion()
  const trendArrow = region.volumeTrend > 0 ? '↑' : region.volumeTrend < 0 ? '↓' : '→'
  const trendColor =
    region.volumeTrend > 0 ? 'var(--success)' : region.volumeTrend < 0 ? 'var(--danger)' : 'var(--fg-subtle)'
  const mobility = lens === 'mobility'
  const mobMinutes = region.mobilityMinutes ?? 0
  const mobPrior = region.priorMobilityMinutes ?? 0
  const mobState = mobilityPaintState(mobMinutes, target)

  // Lazily load the recent sets that trained this muscle (grouped by workout).
  // Recovery lens only — the drill-down is the strength log; mobility shows
  // minutes, not sets.
  const [sessions, setSessions] = useState<DrillSession[] | null>(null)
  const [loadingSessions, setLoadingSessions] = useState(true)
  const [sessionPage, setSessionPage] = useState(0)
  useEffect(() => {
    if (mobility) return
    let alive = true
    setSessions(null)
    setLoadingSessions(true)
    setSessionPage(0)
    fetch(`/api/health/muscle-map/sessions?region=${region.region}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { sessions: DrillSession[] }) => {
        if (alive) setSessions(d.sessions ?? [])
      })
      .catch(() => {
        if (alive) setSessions([])
      })
      .finally(() => {
        if (alive) setLoadingSessions(false)
      })
    return () => {
      alive = false
    }
  }, [region.region, mobility])
  const sessionPageCount = sessions ? Math.max(1, Math.ceil(sessions.length / SESSIONS_PER_PAGE)) : 1
  const pagedSessions = sessions?.slice(sessionPage * SESSIONS_PER_PAGE, sessionPage * SESSIONS_PER_PAGE + SESSIONS_PER_PAGE)

  if (mobility) {
    return (
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        style={panelCard}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
            {onBack && <BackButton onBack={onBack} />}
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: 16, color: 'var(--fg)' }}>{region.label}</span>
          </div>
          <span style={{ ...pill, background: STATE_COLOR[mobState], color: 'var(--bg)' }}>
            {MOBILITY_LEGEND.find((l) => l.state === mobState)?.label ?? ''}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          <Row label="Last stretched">
            {region.daysSinceMobility == null
              ? 'never'
              : region.daysSinceMobility === 0
                ? 'today'
                : `${region.daysSinceMobility}d ago`}
          </Row>
          <Row label="This week">
            <CountUp value={mobMinutes} unit={`/ ${target} min`} />{' '}
            {mobPrior > 0 && (
              <span style={{ color: 'var(--fg-subtle)' }}>(prior {fmt(mobPrior)} min)</span>
            )}
          </Row>
        </div>
        <p style={{ margin: '14px 0 0', fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 12, color: 'var(--fg-subtle)' }}>
          Counted from logged holds — stretch, mobility drill, and soft-tissue minutes, weighted like strength credit.
        </p>
      </motion.div>
    )
  }

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      style={panelCard}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          {onBack && <BackButton onBack={onBack} />}
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 16, color: 'var(--fg)' }}>{region.label}</span>
        </div>
        <span
          style={{
            ...pill,
            background: STATE_COLOR[region.state],
            color: 'var(--bg)',
            transition: reduced ? undefined : 'background 450ms ease',
          }}
        >
          {STATE_LABEL[region.state]}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <Row label="Last worked">
          {region.daysSince == null ? 'never' : region.daysSince === 0 ? 'today' : `${region.daysSince}d ago`}
        </Row>
        {region.daysSincePrimary != null && region.daysSincePrimary !== region.daysSince && (
          <Row label="Last direct">
            {region.daysSincePrimary === 0 ? 'today' : `${region.daysSincePrimary}d ago`}
          </Row>
        )}
        <Row label="This week">
          <CountUp value={region.weeklySets} unit="sets" />{' '}
          <span style={{ color: trendColor }}>
            {trendArrow} {region.priorWeeklySets > 0 ? `from ${fmt(region.priorWeeklySets)}` : ''}
          </span>
        </Row>
        {region.measurement && region.measurement.latest != null && (
          <Row label={region.measurement.label}>
            <CountUp value={region.measurement.latest} unit={region.measurement.unit} />
            {region.measurement.delta != null && region.measurement.delta !== 0 && (
              <span style={{ color: 'var(--fg-subtle)', marginLeft: 6 }}>
                ({region.measurement.delta > 0 ? '+' : ''}
                {fmt(region.measurement.delta)} all-time)
              </span>
            )}
            <span style={{ color: 'var(--fg-subtle)', marginLeft: 6, fontSize: 11 }}>
              · {fmtDate(region.measurement.latestDate)}
            </span>
          </Row>
        )}
      </div>

      {/* Recent sets — the actual log, grouped by workout then exercise. Capped
          to roughly the figure's height + paginated so a deep training history
          can't push the page down past the body map (§1029). */}
      <div style={{ marginTop: 14, borderTop: '1px solid var(--border-muted)', paddingTop: 12 }}>
        <div style={{ ...subtle, marginBottom: 8 }}>RECENT SETS</div>
        {loadingSessions && <div style={{ ...subtle, color: 'var(--fg-subtle)' }}>loading…</div>}
        {!loadingSessions && sessions && sessions.length === 0 && (
          <p style={{ margin: 0, fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 12.5, color: 'var(--fg-subtle)' }}>
            No sets in the last 120 days.
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: RECENT_SETS_MAX_HEIGHT, overflowY: 'auto' }}>
          {pagedSessions?.map((s, i) => (
            <div key={`${s.date}-${i}`}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-muted)' }}>
                  {fmtDate(s.date)}
                </span>
                {s.workoutName && (
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-subtle)' }}>
                    {s.workoutName}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 2 }}>
                {s.exercises.map((ex) => (
                  <div key={ex.name} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg)' }}>
                      {ex.name}
                      {!ex.primary && <span style={{ ...subtle, marginLeft: 5 }}>assist</span>}
                    </span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {ex.sets.map((set, j) => (
                        <span key={j} style={{ ...chip, opacity: set.warmup ? 0.5 : 1 }} title={set.warmup ? 'warmup' : undefined}>
                          {fmtSet(set)}
                          {set.unit && set.weight != null && set.weight > 0 ? <span style={{ color: 'var(--fg-subtle)' }}> {set.unit}</span> : null}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {sessions && sessions.length > SESSIONS_PER_PAGE && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              onClick={() => setSessionPage((p) => Math.max(0, p - 1))}
              disabled={sessionPage === 0}
              style={{ ...toggleBtn, border: '1px solid var(--border-muted)', borderRadius: 6, opacity: sessionPage === 0 ? 0.4 : 1 }}
            >
              ‹ Prev
            </button>
            <span style={subtle}>
              {sessionPage + 1} / {sessionPageCount}
            </span>
            <button
              type="button"
              onClick={() => setSessionPage((p) => Math.min(sessionPageCount - 1, p + 1))}
              disabled={sessionPage >= sessionPageCount - 1}
              style={{ ...toggleBtn, border: '1px solid var(--border-muted)', borderRadius: 6, opacity: sessionPage >= sessionPageCount - 1 ? 0.4 : 1 }}
            >
              Next ›
            </button>
          </div>
        )}
      </div>
    </motion.div>
  )
}

// ── ROM self-test battery (§10b.7 — opt-in, passive stamp, never prompted) ────

interface AssessmentTest {
  key: string
  label: string
  unit: string
  perSide: boolean
}
interface AssessmentData {
  tests: AssessmentTest[]
  summary: {
    lastAssessedAt: string | null
    tests: Array<{ testKey: string; label: string; unit: string; side: string | null; latest: number; delta: number | null }>
  }
}

/** "3d ago" / "5w ago" — coarse, calm. */
function agoText(iso: string): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
  if (days === 0) return 'today'
  if (days < 14) return `${days}d ago`
  return `${Math.round(days / 7)}w ago`
}

function AssessmentBlock() {
  const [data, setData] = useState<AssessmentData | null>(null)
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/gym/mobility-assessments')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: AssessmentData) => setData(d))
      .catch(() => setData(null))
  }, [])

  if (!data) return null

  interface AssessField {
    id: string
    testKey: string
    side: 'left' | 'right' | null
    label: string
    unit: string
  }
  const fields: AssessField[] = data.tests.flatMap((t): AssessField[] =>
    t.perSide
      ? [
          { id: `${t.key}:left`, testKey: t.key, side: 'left', label: `${t.label} — L`, unit: t.unit },
          { id: `${t.key}:right`, testKey: t.key, side: 'right', label: `${t.label} — R`, unit: t.unit },
        ]
      : [{ id: t.key, testKey: t.key, side: null, label: t.label, unit: t.unit }],
  )
  const distanceUnit = data.tests.find((t) => t.unit !== 'score')?.unit ?? 'cm'
  const distanceUnitLabel = distanceUnit === 'in' ? 'inches' : 'centimeters'

  async function save() {
    const entries = fields
      .map((f) => ({ f, raw: values[f.id]?.trim() }))
      .filter((x) => x.raw && Number.isFinite(Number(x.raw)))
      .map((x) => ({ test_key: x.f.testKey, side: x.f.side, value: Number(x.raw) }))
    if (entries.length === 0) return
    setSaving(true)
    try {
      const r = await fetch('/api/gym/mobility-assessments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      })
      if (r.ok) {
        const d = (await r.json()) as { summary: AssessmentData['summary'] }
        setData((cur) => (cur ? { ...cur, summary: d.summary } : cur))
        setValues({})
        setOpen(false)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={subtle}>
          ROM SELF-TESTS{' '}
          <span style={{ textTransform: 'none', letterSpacing: 0 }}>
            · {data.summary.lastAssessedAt ? `last assessed ${agoText(data.summary.lastAssessedAt)}` : 'optional — never required'}
          </span>
        </span>
        <button type="button" onClick={() => setOpen((v) => !v)} style={{ ...toggleBtn, border: '1px solid var(--border-muted)', borderRadius: 6 }}>
          {open ? 'Close' : 'Check in'}
        </button>
      </div>

      {!open && data.summary.tests.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
          {data.summary.tests.map((t) => (
            <span key={`${t.testKey}:${t.side ?? ''}`} style={chip}>
              {t.label}
              {t.side ? ` (${t.side === 'left' ? 'L' : 'R'})` : ''}: {fmt(t.latest)} {t.unit === 'score' ? '' : t.unit}
              {t.delta != null && t.delta !== 0 && (
                <span style={{ color: t.delta < 0 && t.unit !== 'score' ? 'var(--success)' : 'var(--fg-subtle)' }}>
                  {' '}
                  ({t.delta > 0 ? '+' : ''}
                  {fmt(t.delta)})
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {open && (
        <div style={{ ...panelCard, marginTop: 8 }}>
          <p style={{ margin: '0 0 10px', fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 12, color: 'var(--fg-subtle)' }}>
            Fill what you measured — any subset is fine. Distances in {distanceUnitLabel} (toe touch: negative = past your toes); overhead reach 0–100 vs the reference pose.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
            {fields.map((f) => (
              <label key={f.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-muted)' }}>{f.label}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  value={values[f.id] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                  aria-label={f.label}
                  style={assessInput}
                />
              </label>
            ))}
          </div>
          <button type="button" onClick={() => void save()} disabled={saving} style={saveBtn}>
            {saving ? 'Saving…' : 'Save check-in'}
          </button>
        </div>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
      <span style={subtle}>{label}</span>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg)', textAlign: 'right' }}>
        {children}
      </span>
    </div>
  )
}

function Legend({ legend }: { legend: { state: State; label: string; hint: string }[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 12, justifyContent: 'center' }}>
      {legend.map((l) => (
        <span key={l.state} title={l.hint} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              // same duotone mix the figure paints with, so the legend matches the body
              background: muscleFill({ color: STATE_COLOR[l.state], state: l.state }, false),
              boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${STATE_COLOR[l.state]} 45%, transparent)`,
            }}
          />
          <span style={subtle}>{l.label}</span>
        </span>
      ))}
    </div>
  )
}

const headerStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  margin: 0,
}
// Match Health's ~700px stacking point: two 330px columns + gap sit side-by-side
// when useful, while min(100%, …) prevents the anatomy from overflowing phones.
const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 330px), 1fr))',
  gap: 20,
  alignItems: 'start',
}
const figureCol: React.CSSProperties = { minWidth: 0 }
const panelCol: React.CSSProperties = { minWidth: 0 }
const panelCard: React.CSSProperties = {
  padding: '14px 16px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
}
const toggleWrap: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--border-muted)',
  borderRadius: 6,
  overflow: 'hidden',
}
const toggleBtn: React.CSSProperties = {
  padding: '4px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  background: 'transparent',
  color: 'var(--fg-subtle)',
  border: 'none',
  cursor: 'pointer',
  transition: 'background 180ms ease, color 180ms ease',
}
const toggleBtnActive: React.CSSProperties = { background: 'var(--accent)', color: 'var(--accent-fg)' }
const backBtn: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  background: 'transparent',
  color: 'var(--fg-subtle)',
  border: '1px solid var(--border-muted)',
  borderRadius: 6,
  padding: '2px 8px',
  cursor: 'pointer',
  flexShrink: 0,
}
const subtle: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-subtle)' }
const pill: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  padding: '2px 7px',
  borderRadius: 10,
}
const chip: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 11,
  color: 'var(--fg-muted)',
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 4,
  padding: '2px 6px',
}
const assessInput: React.CSSProperties = {
  width: 72,
  padding: '5px 8px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--fg)',
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 6,
}
const saveBtn: React.CSSProperties = {
  marginTop: 10,
  padding: '7px 14px',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
}
const noteStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13,
  color: 'var(--fg-subtle)',
  padding: '12px 0',
}
