/**
 * Live data-sync bus (2026-06-29).
 *
 * Chat actions mutate server-side data (a chat-driven `update_task` writes the
 * DB), but the page the user is looking at holds its rows in component state and
 * never hears about it — so the edit only appears after a manual refresh. This
 * tiny Zustand store closes that gap without any realtime infra: when a chat
 * turn finishes, `useChatStream` inspects the executed tool calls, maps them to
 * the resources they touched, and bumps a per-resource version counter here.
 * Pages subscribe via `useLiveRefresh(resource, refetch)` and refetch when their
 * counter changes.
 *
 * Deliberately client-only and single-direction: the chat response IS the
 * signal. Cross-device sync (phone edit → laptop updates) would need a websocket
 * or Postgres LISTEN/NOTIFY and is out of scope.
 */
'use client'

import { create } from 'zustand'

/** The page-level data domains a chat tool can invalidate. */
export type ResourceKey =
  | 'tasks'
  | 'goals'
  | 'calendar'
  | 'finance'
  | 'habits'
  | 'notes'
  | 'health'
  | 'nutrition'
  | 'food'
  | 'mindfulness'
  | 'music'
  | 'gym'
  | 'memory'
  | 'notifications'
  | 'review'
  | 'skills'
  | 'plans'

interface DataSyncState {
  /** Monotonic per-resource counter; bumped each time the resource is invalidated. */
  versions: Record<string, number>
  /** Bump the counter for each named resource (deduped). No-op on an empty list. */
  invalidate: (resources: ResourceKey[]) => void
}

export const useDataSyncStore = create<DataSyncState>((set) => ({
  versions: {},
  invalidate: (resources) => {
    if (!resources.length) return
    set((state) => {
      const next = { ...state.versions }
      for (const r of resources) next[r] = (next[r] ?? 0) + 1
      return { versions: next }
    })
  },
}))

/** Imperative entry point for non-React callers (e.g. the SSE handler). */
export function invalidateResources(resources: ResourceKey[]): void {
  useDataSyncStore.getState().invalidate(resources)
}
