'use client'

/**
 * Client data layer for the History tab (fenced to components/gym/history/**). A
 * thin `fetch` + useState hook pair — same primitives as lib/gym-client/fetch.ts
 * and lib/health-client/fetch.ts (no SWR/React-Query). Kept local to the History
 * feature so the tab owns its own fetch/mutation surface.
 *
 * Contract mirrors the routes:
 *   GET  /api/gym/history?month=&offset=&limit=  → HistoryResponse
 *   GET  /api/gym/history/[id]                    → SessionDetail
 *   POST /api/gym/workouts { from:'workout', workoutId } → start "Repeat"
 *   POST /api/gym/templates { fromWorkoutId, name }      → "Save as template"
 *   DELETE /api/gym/history/[id]                         → remove session + owned habit tick
 */
import { useEffect, useRef, useState } from 'react'
import type { DistanceUnit } from '@/lib/units/system'

// ── client type contract (mirrors lib/gym/history-read.ts) ──────────────────
export interface CalendarDay {
  date: string
  workoutIds: string[]
  count: number
}
export interface WeekBar {
  weekStart: string
  workouts: number
  volumeLb: number
  volume?: number
}
export interface SessionRow {
  id: string
  name: string | null
  date: string
  durationSeconds: number | null
  exerciseCount: number
  setCount: number
  volumeLb: number
  volume?: number
  prCount?: number
  templateId: string | null
  templateName: string | null
}
export interface ProgramEra {
  templateId: string | null
  templateName: string | null
  firstDate: string
  lastDate: string
  sessions: number
}
export interface HistoryResponse {
  weightUnit?: 'lb' | 'kg'
  distanceUnit?: DistanceUnit
  calendar: CalendarDay[]
  weeks: WeekBar[]
  sessions: SessionRow[]
  hasMore: boolean
  eras: ProgramEra[]
}

export type SetType = 'warmup' | 'normal' | 'drop' | 'failure' | string
export interface SessionDetailSet {
  /** workout_sets row id — the edit target for per-set rest. */
  id: string
  setNumber: number
  setType: SetType
  weight: number | null
  unit: string
  reps: number | null
  distanceM: number | null
  durationS: number | null
  rpe: number | null
  /** Rest taken after this set (seconds); null when unknown. */
  restSeconds: number | null
  side: 'left' | 'right' | null
  logicalSetId: string
  completed: boolean
}
export interface SessionDetailExercise {
  workoutExerciseId: string
  exerciseId: string
  name: string
  tracks: string
  loadBasis: 'total' | 'per_side'
  primaryMuscle: string | null
  supersetGroup: number | null
  notes: string | null
  sets: SessionDetailSet[]
}
export interface SessionDetail {
  id: string
  name: string | null
  date: string
  durationSeconds: number | null
  notes: string | null
  templateId: string | null
  templateName: string | null
  exerciseCount: number
  setCount: number
  volumeLb: number
  volume?: number
  weightUnit?: 'lb' | 'kg'
  distanceUnit?: DistanceUnit
  exercises: SessionDetailExercise[]
}

// ── query URL builder ────────────────────────────────────────────────────────
export function historyPath(opts: { month?: string; offset?: number; limit?: number }): string {
  const p = new URLSearchParams()
  if (opts.month) p.set('month', opts.month)
  if (opts.offset != null) p.set('offset', String(opts.offset))
  if (opts.limit != null) p.set('limit', String(opts.limit))
  const qs = p.toString()
  return `/api/gym/history${qs ? `?${qs}` : ''}`
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return (await res.json()) as T
}

// ── one-shot fetch hook (month header + first page) ─────────────────────────
export interface HistoryState {
  data: HistoryResponse | null
  loading: boolean
  error: boolean
}

/**
 * Load the History payload for a month. `reloadKey` bumps to force a refetch (after
 * a Repeat/Save mutation). Keeps the previous payload visible while a new month
 * loads (no flicker on month change).
 */
export function useHistory(month: string, reloadKey = 0): HistoryState {
  const [state, setState] = useState<HistoryState>({ data: null, loading: true, error: false })

  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true, error: false }))
    getJson<HistoryResponse>(historyPath({ month }))
      .then((d) => alive && setState({ data: d, loading: false, error: false }))
      .catch(() => alive && setState((s) => ({ ...s, loading: false, error: true })))
    return () => {
      alive = false
    }
  }, [month, reloadKey])

  return state
}

/** Fetch one page of sessions (used by load-more). Returns the raw response. */
export function fetchSessionsPage(offset: number, limit: number): Promise<HistoryResponse> {
  return getJson<HistoryResponse>(historyPath({ offset, limit }))
}

// ── one session's detail (lazy, on sheet open) ──────────────────────────────
export interface SessionDetailState {
  data: SessionDetail | null
  loading: boolean
  error: boolean
}

export function useSessionDetail(id: string | null): SessionDetailState {
  const [state, setState] = useState<SessionDetailState>({
    data: null,
    loading: id != null,
    error: false,
  })
  // Guard against a stale response landing after the id changed.
  const reqIdRef = useRef(0)

  useEffect(() => {
    if (!id) {
      setState({ data: null, loading: false, error: false })
      return
    }
    const reqId = ++reqIdRef.current
    setState({ data: null, loading: true, error: false })
    getJson<SessionDetail>(`/api/gym/history/${encodeURIComponent(id)}`)
      .then((d) => {
        if (reqId === reqIdRef.current) setState({ data: d, loading: false, error: false })
      })
      .catch(() => {
        if (reqId === reqIdRef.current) setState({ data: null, loading: false, error: true })
      })
  }, [id])

  return state
}

// ── mutations ────────────────────────────────────────────────────────────────

/** Start a fresh active workout copying a specific completed session's structure
 *  (History "Repeat"). Resolves on the created ActiveWorkout, or throws — a 409
 *  (a workout already active) is surfaced as a thrown error the caller toasts. */
export async function repeatWorkout(workoutId: string): Promise<{ conflict: boolean }> {
  const res = await fetch('/api/gym/workouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'workout', workoutId }),
  })
  if (res.status === 409) return { conflict: true }
  if (!res.ok) throw new Error(`repeat workout → ${res.status}`)
  return { conflict: false }
}

/** Save a completed session as a reusable template ("Save as template"). */
export async function saveWorkoutAsTemplate(fromWorkoutId: string, name: string): Promise<void> {
  const res = await fetch('/api/gym/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromWorkoutId, name }),
  })
  if (!res.ok) throw new Error(`save template → ${res.status}`)
}

export interface DeleteSessionResult {
  deleted: true
  habitCompletionRemoved: boolean
}

/** Permanently delete a completed session. The server owns linked-habit
 * provenance and removes the completion only when the workout created it. */
export async function deleteSession(workoutId: string): Promise<DeleteSessionResult> {
  const res = await fetch(`/api/gym/history/${encodeURIComponent(workoutId)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`delete session → ${res.status}`)
  return (await res.json()) as DeleteSessionResult
}

/** Edit the rest taken after one set in a completed session (null clears it). */
export async function updateSetRest(
  workoutId: string,
  setId: string,
  restSeconds: number | null,
): Promise<void> {
  const res = await fetch(`/api/gym/history/${encodeURIComponent(workoutId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setId, restSeconds }),
  })
  if (!res.ok) throw new Error(`update set rest → ${res.status}`)
}
