'use client'

/**
 * Client fetch layer for the Gym Templates builder — same primitives as
 * lib/gym-client/fetch.ts (plain fetch + a per-key cache + a generation bump for
 * invalidation + tiny useState hooks). No SWR/React-Query dependency.
 *
 * Cache scope: the card list is keyed by its query URL; each editor payload is
 * keyed by template id. Any mutation clears the whole templates cache and bumps
 * the generation so mounted hooks refetch.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'

import type {
  TemplateCardsResponse,
  TemplateEditorData,
  TemplateEditorPayload,
} from './types'

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
      cache.delete(path)
      throw err
    })
    cache.set(path, p)
  }
  return p
}

/** Drop every cached template payload (called after a mutation). */
export function invalidateTemplatesCache(): void {
  cache.clear()
}

/** Test-only: reset the module cache + generation between cases. */
export function __resetTemplatesClientForTests(): void {
  cache.clear()
  generation = 0
  genListeners.forEach((l) => l())
}

// ── generation store ─────────────────────────────────────────────────────────
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

export interface TemplatesData<T> {
  data: T | null
  loading: boolean
  error: boolean
}

function useTemplatesData<T>(path: string | null): TemplatesData<T> {
  const gen = useGeneration()
  const [state, setState] = useState<TemplatesData<T>>({
    data: null,
    loading: path != null,
    error: false,
  })

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

// ── reads ──────────────────────────────────────────────────────────────────

/** The folder-grouped card list. `archived` toggles the restore view. */
export function useTemplateCards(archived = false): TemplatesData<TemplateCardsResponse> {
  return useTemplatesData<TemplateCardsResponse>(
    `/api/gym/templates?view=cards${archived ? '&archived=1' : ''}`,
  )
}

/** One template's full editor payload. Pass null id for idle (a fresh "new"). */
export function useTemplateEditor(id: string | null): TemplatesData<{ template: TemplateEditorData }> {
  return useTemplatesData<{ template: TemplateEditorData }>(
    id ? `/api/gym/templates/${encodeURIComponent(id)}` : null,
  )
}

// ── mutations (caller owns optimistic UI + rollback) ─────────────────────────

async function mutate(path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`)
  const payload = res.status === 204 ? null : await res.json().catch(() => null)
  invalidateTemplatesCache()
  bumpGeneration()
  return payload
}

/** Create a template from the builder payload → the new editor data. */
export async function createTemplate(
  payload: TemplateEditorPayload,
): Promise<TemplateEditorData> {
  const out = (await mutate('/api/gym/templates', 'POST', payload)) as {
    template: TemplateEditorData
  }
  return out.template
}

/** Replace-all save of an existing template → the reloaded editor data. */
export async function saveTemplate(
  id: string,
  payload: TemplateEditorPayload,
): Promise<TemplateEditorData> {
  const out = (await mutate(
    `/api/gym/templates/${encodeURIComponent(id)}`,
    'PATCH',
    payload,
  )) as { template: TemplateEditorData }
  return out.template
}

/** Duplicate a template → the new card summary. */
export async function duplicateTemplate(id: string): Promise<void> {
  await mutate('/api/gym/templates', 'POST', { duplicateOf: id })
}

/** Archive a template (soft delete). */
export async function archiveTemplate(id: string): Promise<void> {
  await mutate(`/api/gym/templates/${encodeURIComponent(id)}`, 'DELETE')
}

/** Restore an archived template. */
export async function restoreTemplate(id: string): Promise<void> {
  await mutate(`/api/gym/templates/${encodeURIComponent(id)}`, 'PATCH', { archived: false })
}
