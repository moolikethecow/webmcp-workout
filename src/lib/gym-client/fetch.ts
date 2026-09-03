'use client'

/**
 * Client fetch layer for the Gym Exercises surfaces — mirrors the shape of
 * lib/health-client/fetch.ts (plain `fetch` + a per-key in-flight/result cache
 * + a manual-generation bump for invalidation + tiny useState-backed hooks). No
 * new data layer, no SWR/React-Query dependency: same primitives the /health
 * redesign uses.
 *
 * Cache scope: LIST payloads are keyed by their full query URL. DETAIL payloads
 * are keyed by exercise id. A create/patch mutation invalidates the whole gym
 * cache and bumps the generation so mounted hooks refetch.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import type {
  ExerciseCreateResponse,
  ExerciseDetailResponse,
  ExerciseListResponse,
  ExercisePatch,
  ExerciseQuery,
  LoadCorrection,
  LoadCorrectionPreview,
} from './types'

// ── fetch + cache ─────────────────────────────────────────────────────────
const cache = new Map<string, Promise<unknown>>()

async function fetchPath(path: string): Promise<unknown> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json()
}

function cached(path: string): Promise<unknown> {
  let p = cache.get(path)
  if (!p) {
    p = fetchPath(path).catch((err) => {
      cache.delete(path) // never poison the cache with a rejected promise
      throw err
    })
    cache.set(path, p)
  }
  return p
}

/** Drop every cached gym payload (called after a mutation). */
export function invalidateGymCache(): void {
  cache.clear()
}

/** Test-only: reset the module cache + generation between cases. */
export function __resetGymClientForTests(): void {
  cache.clear()
  generation = 0
  genListeners.forEach((l) => l())
}

// ── generation store (bump → mounted hooks refetch) ─────────────────────────
let generation = 0
const genListeners = new Set<() => void>()
function bumpGeneration(): void {
  generation++
  genListeners.forEach((l) => l())
}
function useGeneration(): number {
  return useSyncExternalStore(
    (cb) => {
      genListeners.add(cb)
      return () => genListeners.delete(cb)
    },
    () => generation,
    () => 0,
  )
}

export interface GymData<T> {
  data: T | null
  loading: boolean
  error: boolean
}

/** Fetch a gym path with caching; keeps the previous payload while a new path
 *  loads (stale-while-switching, so filter toggles don't flicker). Pass null to
 *  render idle. */
function useGymData<T>(path: string | null): GymData<T> {
  const gen = useGeneration()
  const [state, setState] = useState<GymData<T>>({ data: null, loading: path != null, error: false })

  useEffect(() => {
    if (!path) return
    let alive = true
    setState((s) => ({ ...s, loading: true, error: false }))
    cached(path)
      .then((d) => {
        if (alive) setState({ data: d as T, loading: false, error: false })
      })
      .catch(() => {
        if (alive) setState((s) => ({ ...s, loading: false, error: true }))
      })
    return () => {
      alive = false
    }
  }, [path, gen])

  return state
}

// ── query URL builder ───────────────────────────────────────────────────────
export function exercisesPath(query: ExerciseQuery): string {
  const p = new URLSearchParams()
  if (query.q) p.set('q', query.q)
  if (query.muscle) p.set('muscle', query.muscle)
  if (query.equipment) p.set('equipment', query.equipment)
  if (query.filter) p.set('filter', query.filter)
  if (query.limit != null) p.set('limit', String(query.limit))
  if (query.offset != null) p.set('offset', String(query.offset))
  const qs = p.toString()
  return `/api/gym/exercises${qs ? `?${qs}` : ''}`
}

/** The exercise catalog list, filtered/paginated per the query. */
export function useGymExercises(query: ExerciseQuery): GymData<ExerciseListResponse> {
  return useGymData<ExerciseListResponse>(exercisesPath(query))
}

/** One exercise's full detail (records + history + charts). Pass null id for idle. */
export function useGymExercise(id: string | null): GymData<ExerciseDetailResponse> {
  return useGymData<ExerciseDetailResponse>(id ? `/api/gym/exercises/${encodeURIComponent(id)}` : null)
}

// ── mutations ───────────────────────────────────────────────────────────────

/** Create-from-search: POST {name}. Invalidates the list cache on success so a
 *  subsequent list refetch shows the new row. Throws on a non-ok response. */
export async function createGymExercise(name: string): Promise<ExerciseCreateResponse> {
  const res = await fetch('/api/gym/exercises', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`create exercise → ${res.status}`)
  const payload = (await res.json()) as ExerciseCreateResponse
  invalidateGymCache()
  bumpGeneration()
  return payload
}

/** PATCH per-exercise preferences. Returns the updated exercise. Callers own the
 *  optimistic update + rollback (this only performs the network write); on
 *  success it invalidates the cache so future reads are fresh. */
export async function patchGymExercise(
  id: string,
  patch: ExercisePatch,
): Promise<ExerciseDetailResponse['exercise']> {
  const res = await fetch(`/api/gym/exercises/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`patch exercise → ${res.status}`)
  const payload = (await res.json()) as { exercise: ExerciseDetailResponse['exercise'] }
  invalidateGymCache()
  bumpGeneration()
  return payload.exercise
}

function correctionPath(id: string): string {
  return `/api/gym/exercises/${encodeURIComponent(id)}/load-corrections`
}

export async function listLoadCorrections(id: string): Promise<LoadCorrection[]> {
  const res = await fetch(correctionPath(id))
  if (!res.ok) throw new Error(`load corrections → ${res.status}`)
  const payload = (await res.json()) as { corrections: LoadCorrection[] }
  return payload.corrections
}

export async function previewLoadCorrection(
  id: string,
  scope: { startDate?: string | null; endDate?: string | null; divisor?: number },
): Promise<LoadCorrectionPreview> {
  const res = await fetch(correctionPath(id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'preview', ...scope }),
  })
  if (!res.ok) throw new Error(`preview load correction → ${res.status}`)
  return ((await res.json()) as { preview: LoadCorrectionPreview }).preview
}

export async function applyLoadCorrection(
  id: string,
  scope: { startDate?: string | null; endDate?: string | null; divisor?: number; reason?: string },
): Promise<{ correction: LoadCorrection; preview: LoadCorrectionPreview }> {
  const res = await fetch(correctionPath(id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'apply', ...scope }),
  })
  if (!res.ok) throw new Error(`apply load correction → ${res.status}`)
  const payload = (await res.json()) as { correction: LoadCorrection; preview: LoadCorrectionPreview }
  invalidateGymCache()
  bumpGeneration()
  return payload
}

export async function revertLoadCorrection(id: string, correctionId: string): Promise<void> {
  const res = await fetch(correctionPath(id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'revert', correctionId }),
  })
  if (!res.ok) throw new Error(`revert load correction → ${res.status}`)
  invalidateGymCache()
  bumpGeneration()
}

/** Reusable debounce hook (250ms search box). */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

/** Exposed for tests that assert mutation-driven refetches. */
export { bumpGeneration as __bumpGymGeneration }
