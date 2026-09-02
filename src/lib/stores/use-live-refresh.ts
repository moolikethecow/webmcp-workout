/**
 * useLiveRefresh — page-side half of the live data-sync bus (2026-06-29).
 *
 * A page calls this with the resource(s) it renders and a refetch callback. When
 * a chat tool mutates one of those resources, `useChatStream` bumps the version
 * counter in `data-sync-store`, and this hook fires the callback so the page
 * reloads in place.
 *
 *   useLiveRefresh('tasks', () => fetchTasks(activeTab))
 *   useLiveRefresh(['tasks', 'goals'], reload)
 *
 * The callback is held in a ref, so it does NOT need to be stable (an inline
 * arrow is fine) and always sees fresh state. The initial mount is skipped — the
 * page already did its own first load — so this only fires on genuine
 * post-action invalidations.
 */
'use client'

import { useEffect, useRef } from 'react'
import { useDataSyncStore, type ResourceKey } from '@/lib/stores/data-sync-store'

export function useLiveRefresh(
  resources: ResourceKey | ResourceKey[],
  refetch: () => void,
): void {
  const keys = Array.isArray(resources) ? resources : [resources]
  // Stable key for the dependency list so re-renders with the same resources
  // don't churn the effect.
  const keyId = keys.join(',')

  // Sum of the relevant counters — changes whenever ANY listed resource is
  // invalidated.
  const version = useDataSyncStore((s) =>
    keys.reduce((sum, k) => sum + (s.versions[k] ?? 0), 0),
  )

  const refetchRef = useRef(refetch)
  refetchRef.current = refetch

  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    refetchRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, keyId])
}
