'use client'

/**
 * /gym shell — the tabbed section (GYM_PLAN §2.1, §4). Copies the
 * finance `?tab=` pattern: this single client component owns the URL-driven
 * tab + the settings-sheet open state; each tab is a presentational component.
 * The `useSearchParams` read is wrapped in a <Suspense> boundary by the page
 * (build fails without it).
 *
 * Tabs: Train (default) · Plans · Templates · Body · Exercises · History, plus a gear icon
 * opening GymSettingsSheet. Deep-linkable via ?tab=. Mobile-first (390–414px).
 *
 * Train/Templates/History are P2 placeholders; Exercises is live (P1).
 */
import { useCallback, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Settings } from 'lucide-react'

import { HealthStyles, PageHead } from '@/components/health/primitives'
import { MuscleMap } from '@/components/health/MuscleMap'
import { useGymWebMCP } from '@/lib/webmcp'

import AgentActivity from './AgentActivity'
import TrainTab from './TrainTab'
import TemplatesTab from './TemplatesTab'
import HistoryTab from './HistoryTab'
import GymSettingsSheet from './GymSettingsSheet'
import { ExercisesTab } from '@/components/gym/exercises'
import PlansTab from '@/components/gym/plans/PlansTab'

const TABS = [
  { key: 'train', label: 'Train' },
  { key: 'plans', label: 'Plans' },
  { key: 'templates', label: 'Templates' },
  { key: 'body', label: 'Body' },
  { key: 'exercises', label: 'Exercises' },
  { key: 'history', label: 'History' },
] as const

type TabKey = (typeof TABS)[number]['key']

function isTabKey(v: string | null): v is TabKey {
  return v != null && TABS.some((t) => t.key === v)
}

export default function GymShell() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const urlTab = searchParams.get('tab')
  const tab: TabKey = isTabKey(urlTab) ? urlTab : 'train'

  // Tool registration follows the visible tab: History is reads-only, every
  // other tab is the live session. Registering per tab keeps the offered tool
  // list an accurate description of what makes sense here.
  useGymWebMCP(tab === 'history' ? 'history' : 'gym')

  const [settingsOpen, setSettingsOpen] = useState(false)

  const setTab = useCallback(
    (next: TabKey) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('tab', next)
      router.replace(`/gym?${params.toString()}`)
    },
    [router, searchParams],
  )

  return (
    <div className="page page-fade" style={{ maxWidth: 1040 }}>
      <HealthStyles />
      <div className="hlth-sections">
        <PageHead
          title="Gym"
          sub="Log lifts, build programs, and let your agent shape the next session from your history and constraints."
          right={
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Gym settings"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                borderRadius: 9,
                border: '1px solid var(--border-muted)',
                background: 'var(--bg-elevated)',
                cursor: 'pointer',
                flexShrink: 0,
                marginTop: 4,
              }}
            >
              <Settings size={16} color="var(--fg-muted)" />
            </button>
          }
        />

        {/* Tab bar — mirrors finance: 13px labels, active = --fg + 2px --accent underline. */}
        <div
          role="tablist"
          aria-label="Gym sections"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const current = TABS.findIndex((item) => item.key === tab)
            const next = event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? TABS.length - 1
                : (current + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length
            setTab(TABS[next]!.key)
            window.requestAnimationFrame(() => document.getElementById(`gym-tab-${TABS[next]!.key}`)?.focus())
          }}
          style={{
            display: 'flex',
            gap: 2,
            borderBottom: '1px solid var(--border-muted)',
            margin: '2px 0 2px',
            overflowX: 'auto',
          }}
        >
          {TABS.map((t) => {
            const active = t.key === tab
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`gym-tab-${t.key}`}
                aria-controls={`gym-panel-${t.key}`}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => setTab(t.key)}
                style={{
                  minHeight: 44,
                  padding: '8px 14px 10px',
                  fontSize: 13,
                  color: active ? 'var(--fg)' : 'var(--fg-subtle)',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                  marginBottom: -1,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  fontFamily: 'inherit',
                }}
              >
                {t.label}
              </button>
            )
          })}
        </div>

        <AgentActivity />

        <div role="tabpanel" id={`gym-panel-${tab}`} aria-labelledby={`gym-tab-${tab}`}>
          {tab === 'train' && <TrainTab />}
          {tab === 'plans' && <PlansTab />}
          {tab === 'templates' && <TemplatesTab />}
          {tab === 'exercises' && <ExercisesTab />}
          {tab === 'history' && <HistoryTab />}
          {tab === 'body' && <MuscleMap />}
        </div>
      </div>

      <GymSettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
