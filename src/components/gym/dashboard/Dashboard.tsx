'use client'

/**
 * The dashboard at `/` — one screen that answers "what now?" and shows the
 * agent what it is working with.
 *
 * Everything here is a read of the same routes the agent's tools call, so the
 * page and the agent can never describe different states: the active session,
 * today's draft, per-region readiness, the training constraints in force, and
 * the last five sessions. The page registers the dashboard tool set on mount,
 * which is the whole install story — open it in a WebMCP browser and the tools
 * are there.
 *
 * Mobile-first (390–414px single column), two columns from 900px.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

import { HCard, HealthStyles, MonoLabel, PageHead, SecHead } from '@/components/health/primitives'
import { BRAND } from '@/lib/brand'
import { INJURY_SITE_LABELS, type InjurySite } from '@/lib/gym/injury-profile'
import { useGymWebMCP } from '@/lib/webmcp'
import AgentActivity from '@/components/gym/shell/AgentActivity'

import { ReadinessBlock, type RegionReadinessRow } from './ReadinessBlock'

/** The three prompts the demo is built around. Verbatim — they are the script. */
export const DEMO_PROMPTS = [
  "My shoulder's bugging me and I've got 30 minutes. Keep what I've done, work around the shoulder, hit whatever's freshest.",
  'What should I do next?',
  'Before I go heavier on incline bench, am I actually progressing?',
] as const

interface ActiveSummary {
  id: string
  name: string | null
  exercises: number
}
interface DraftSummary {
  name: string
  exercises: number
}
interface ConstraintRow {
  id: string
  region: InjurySite
  label: string | null
  severity: string | null
}
interface SessionSummary {
  id: string
  name: string | null
  date: string
  exerciseCount: number
  setCount: number
  volume: number
}

interface DashboardData {
  active: ActiveSummary | null
  draft: DraftSummary | null
  readiness: RegionReadinessRow[]
  constraints: ConstraintRow[]
  sessions: SessionSummary[]
  weightUnit: string
}

const EMPTY: DashboardData = {
  active: null,
  draft: null,
  readiness: [],
  constraints: [],
  sessions: [],
  weightUnit: 'lb',
}

/** A read that never throws: a dead route degrades one block, not the page. */
async function readJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

export default function Dashboard() {
  useGymWebMCP('dashboard')

  const [data, setData] = useState<DashboardData>(EMPTY)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const [active, plan, readiness, injuries, history] = await Promise.all([
      readJson('/api/gym/workouts/active'),
      readJson('/api/gym/plan'),
      readJson('/api/gym/agent/readiness'),
      readJson('/api/gym/injuries?active=1'),
      readJson('/api/gym/history?limit=5'),
    ])

    const activeExercises = Array.isArray(active?.exercises) ? active.exercises : []
    const proposal = (plan?.proposal ?? null) as
      | { payload?: { name?: string; exercises?: unknown[] } }
      | null
    const proposalExercises = Array.isArray(proposal?.payload?.exercises)
      ? proposal.payload.exercises
      : []
    const sessions = Array.isArray(history?.sessions)
      ? (history.sessions as SessionSummary[]).slice(0, 5)
      : []

    setData({
      active:
        active && typeof active.id === 'string'
          ? {
              id: active.id,
              name: typeof active.name === 'string' ? active.name : null,
              exercises: activeExercises.length,
            }
          : null,
      draft: proposal
        ? { name: proposal.payload?.name ?? 'Today’s draft', exercises: proposalExercises.length }
        : null,
      readiness: Array.isArray(readiness?.regions) ? (readiness.regions as RegionReadinessRow[]) : [],
      constraints: Array.isArray(injuries?.injuries) ? (injuries.injuries as ConstraintRow[]) : [],
      sessions,
      weightUnit: typeof history?.weightUnit === 'string' ? history.weightUnit : 'lb',
    })
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="page page-fade" style={{ maxWidth: 1040 }}>
      <HealthStyles />
      <style>{`
        .gym-dash-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 16px;
          align-items: start;
        }
        @media (min-width: 900px) {
          .gym-dash-grid { grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); }
        }
      `}</style>

      <div className="hlth-sections">
        <PageHead title={BRAND.name} sub={BRAND.tagline} />

        <AgentActivity showStatus />

        <div className="gym-dash-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <section>
              <SecHead num="01">Today</SecHead>
              <HCard pad={16}>
                {loading ? (
                  <p style={note}>Loading…</p>
                ) : data.active ? (
                  <>
                    <MonoLabel>In progress</MonoLabel>
                    <p style={headline}>{data.active.name ?? 'Workout'}</p>
                    <p style={note}>
                      {data.active.exercises} exercise{data.active.exercises === 1 ? '' : 's'} on the board.
                    </p>
                    <Link href="/gym" style={cta}>
                      Open the logger
                    </Link>
                  </>
                ) : data.draft ? (
                  <>
                    <MonoLabel>Drafted</MonoLabel>
                    <p style={headline}>{data.draft.name}</p>
                    <p style={note}>
                      {data.draft.exercises} exercise{data.draft.exercises === 1 ? '' : 's'}, not started yet.
                    </p>
                    <Link href="/gym" style={cta}>
                      Review and start
                    </Link>
                  </>
                ) : (
                  <>
                    <MonoLabel>Nothing running</MonoLabel>
                    <p style={headline}>No session yet today.</p>
                    <p style={note}>Start one yourself, or ask your agent to draft it.</p>
                    <Link href="/gym" style={cta}>
                      Start a workout
                    </Link>
                  </>
                )}
              </HCard>
            </section>

            <section>
              <SecHead num="02">Recent training</SecHead>
              <HCard pad={16}>
                {data.sessions.length === 0 ? (
                  <p style={note}>{loading ? 'Loading…' : 'No completed sessions yet.'}</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {data.sessions.map((session, index) => (
                      <div key={session.id} style={{ ...row, borderTop: index === 0 ? 'none' : row.borderTop }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--fg)' }}>
                          {session.name ?? 'Workout'}
                        </span>
                        <span style={meta}>
                          {shortDate(session.date)} · {session.setCount} sets ·{' '}
                          {Math.round(session.volume ?? 0).toLocaleString()} {data.weightUnit}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </HCard>
            </section>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <section>
              <SecHead num="03">Readiness</SecHead>
              <HCard pad={16}>
                {loading && data.readiness.length === 0 ? (
                  <p style={note}>Loading…</p>
                ) : (
                  <ReadinessBlock regions={data.readiness} />
                )}
              </HCard>
            </section>

            <section>
              <SecHead num="04">Training constraints</SecHead>
              <HCard pad={16}>
                {data.constraints.length === 0 ? (
                  <p style={note}>{loading ? 'Loading…' : 'No active constraints.'}</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {data.constraints.map((constraint, index) => (
                      <div
                        key={constraint.id}
                        style={{ ...row, borderTop: index === 0 ? 'none' : row.borderTop }}
                      >
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--fg)' }}>
                          {constraint.label?.trim() || INJURY_SITE_LABELS[constraint.region] || constraint.region}
                        </span>
                        <span style={meta}>{constraint.severity ?? 'noted'}</span>
                      </div>
                    ))}
                  </div>
                )}
                <p style={{ ...note, marginTop: 10 }}>
                  Constraints shape what can be drafted or swapped in. They are training limits, not medical advice.
                </p>
              </HCard>
            </section>

            <section>
              <SecHead num="05">Work with your agent</SecHead>
              <HCard pad={16}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {DEMO_PROMPTS.map((prompt, index) => (
                    <p key={prompt} style={{ ...prompts, borderTop: index === 0 ? 'none' : prompts.borderTop }}>
                      “{prompt}”
                    </p>
                  ))}
                </div>
                <p style={{ ...note, marginTop: 10 }}>
                  Open this page in ChatGPT&rsquo;s browser or Chrome with WebMCP enabled; the tools register
                  automatically.
                </p>
              </HCard>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 'Mar 4' — terse, no year unless it isn't this one. */
function shortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: '2-digit' }),
  })
}

// ── styles ──────────────────────────────────────────────────────────────────
const headline: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 19,
  color: 'var(--fg)',
  margin: '8px 0 4px',
}
const note: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  color: 'var(--fg-subtle)',
  margin: 0,
}
const cta: React.CSSProperties = {
  display: 'inline-block',
  marginTop: 12,
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  textDecoration: 'none',
  borderBottom: '1px solid var(--accent)',
  paddingBottom: 2,
}
const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 0',
  borderTop: '1px solid var(--border-muted)',
}
const meta: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
}
const prompts: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13.5,
  lineHeight: 1.55,
  color: 'var(--fg-muted)',
  margin: 0,
  padding: '9px 0',
  borderTop: '1px solid var(--border-muted)',
}
