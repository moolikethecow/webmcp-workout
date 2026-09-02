'use client'

/**
 * History tab (GYM_PLAN §4 "Tab: History", P2b) — the whole logged past on one
 * screen: a month calendar (dots on workout days), a workouts-per-week bar row with
 * program-era bands, and a paginated session list. Tapping a workout day opens that
 * session's detail (single) or jumps the list (multiple); tapping a session row
 * opens the SessionDetailSheet (full set log + Repeat + Save as template).
 *
 * Data comes from GET /api/gym/history (month + first page) via the local
 * history-client; Previous/Next replaces the visible 20-row page. Deleting a
 * session reloads page 1; ordinarily closing detail preserves the current page.
 * Imported sessions (304 legacy) render clean — no template chip, no notes.
 * Mobile-first (390–414px).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { HCard } from '@/components/health/primitives'
import {
  fetchSessionsPage,
  useHistory,
  type HistoryResponse,
  type SessionRow,
} from '@/components/gym/history/history-client'
import { currentMonth, shiftMonth } from '@/components/gym/history/format'
import { MonthCalendar } from '@/components/gym/history/MonthCalendar'
import { WeeklyBars } from '@/components/gym/history/WeeklyBars'
import { SessionList } from '@/components/gym/history/SessionList'
import { SessionDetailSheet } from '@/components/gym/history/SessionDetailSheet'

const PAGE = 20

export default function HistoryTab() {
  const [month, setMonth] = useState<string>(() => currentMonth())
  const [reloadKey, setReloadKey] = useState(0)
  const { data, loading, error } = useHistory(month, reloadKey)

  const [paged, setPaged] = useState<{
    page: number
    sessions: SessionRow[]
    hasMore: boolean
    source: HistoryResponse | null
  } | null>(null)
  const [loadingPage, setLoadingPage] = useState(false)

  const [openId, setOpenId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Invalidates an in-flight page request when the base payload reloads or a
  // session mutation resets the list.
  const pageRequestRef = useRef(0)
  // Page 1 comes straight from the hook payload. This avoids a transient empty
  // render while an effect copies newly-arrived data into local state.
  const currentPage = paged?.source === data ? paged : null
  const page = currentPage?.page ?? 1
  const sessions = currentPage?.sessions ?? data?.sessions ?? []
  const hasMore = currentPage?.hasMore ?? data?.hasMore ?? false

  const resetSessionPage = useCallback(() => {
    pageRequestRef.current += 1
    setPaged(null)
    setLoadingPage(false)
  }, [])

  // A month/reload payload always owns page 1. This also prevents an old page
  // request from landing after a newer base response.
  useEffect(() => {
    if (data) resetSessionPage()
  }, [data, resetSessionPage])

  const changePage = useCallback(async (targetPage: number) => {
    if (loadingPage || targetPage < 1 || (targetPage > page && !hasMore)) return

    const requestId = ++pageRequestRef.current
    setLoadingPage(true)
    try {
      const next = await fetchSessionsPage((targetPage - 1) * PAGE, PAGE)
      if (requestId !== pageRequestRef.current) return
      setPaged({ page: targetPage, sessions: next.sessions, hasMore: next.hasMore, source: data })
      listRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    } catch {
      if (requestId !== pageRequestRef.current) return
      const { toast } = await import('sonner')
      if (requestId === pageRequestRef.current) toast.error("Couldn't load that page.")
    } finally {
      if (requestId === pageRequestRef.current) setLoadingPage(false)
    }
  }, [data, hasMore, loadingPage, page])

  // Tap a workout day: single → open detail; multiple → scroll the list into view.
  const handlePickDay = useCallback((_date: string, workoutIds: string[]) => {
    if (workoutIds.length === 1) {
      setOpenId(workoutIds[0]!)
    } else if (workoutIds.length > 1) {
      listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

  const bumpReload = useCallback(() => {
    resetSessionPage()
    setReloadKey((k) => k + 1)
  }, [resetSessionPage])

  if (error && !data) {
    return (
      <HCard pad={22}>
        <p style={note}>Couldn&rsquo;t load your history.</p>
      </HCard>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{`
        .gym-history-overview {
          display: grid;
          grid-template-columns: minmax(320px, 400px) minmax(0, 1fr);
          gap: 16px;
          align-items: stretch;
        }
        @media (max-width: 820px) {
          .gym-history-overview { grid-template-columns: minmax(0, 1fr); }
        }
      `}</style>
      <div className="gym-history-overview">
        <HCard pad={16}>
          <MonthCalendar
            month={month}
            days={data?.calendar ?? []}
            onPrev={() => setMonth((m) => shiftMonth(m, -1))}
            onNext={() => setMonth((m) => shiftMonth(m, 1))}
            onPickDay={handlePickDay}
          />
        </HCard>

        <HCard pad={18}>
          <WeeklyBars weeks={data?.weeks ?? []} eras={data?.eras ?? []} unit={data?.weightUnit} />
        </HCard>
      </div>

      <div ref={listRef}>
        <HCard pad={18}>
          {loading && !data ? (
            <p style={note}>Loading history…</p>
          ) : (
            <SessionList
              sessions={sessions}
              page={page}
              hasNext={hasMore}
              loadingPage={loadingPage}
              onOpen={(id) => setOpenId(id)}
              onPrevious={() => void changePage(page - 1)}
              onNext={() => void changePage(page + 1)}
              unit={data?.weightUnit}
            />
          )}
        </HCard>
      </div>

      {openId && (
        <SessionDetailSheet
          id={openId}
          onDeleted={() => {
            setOpenId(null)
            bumpReload()
          }}
          onClose={() => {
            setOpenId(null)
          }}
        />
      )}
    </div>
  )
}

const note: React.CSSProperties = {
  margin: '12px 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13,
  color: 'var(--fg-subtle)',
  textAlign: 'center',
}
