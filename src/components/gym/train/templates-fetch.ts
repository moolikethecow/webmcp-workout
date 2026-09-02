'use client'

/**
 * Train-tab client fetch for the templates start surface + save-as-template
 * (GYM_PLAN §4, P2a). Small, self-contained: one GET hook for the start screen and
 * one POST for "save as template". Mirrors lib/gym-client/fetch.ts conventions
 * (plain fetch, throw-on-non-ok) without pulling the exercises cache in.
 */
import { useCallback, useEffect, useState } from 'react'

import type {
  CreatedTemplate,
  TemplatesStartResponse,
} from '@/lib/gym/templates-read'

export interface StartSurfaceData {
  data: TemplatesStartResponse | null
  loading: boolean
  error: boolean
  /** Refetch (e.g. after a workout finishes → last-workout changes). */
  reload: () => void
}

/**
 * Load the Train start surface (templates + last workout). Refetches on `reload()`
 * and whenever `enabled` flips true (so it fetches only when there's NO active
 * workout — no wasted call mid-session).
 */
export function useStartSurface(enabled: boolean): StartSurfaceData {
  const [data, setData] = useState<TemplatesStartResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    setLoading(true)
    setError(false)
    fetch('/api/gym/templates')
      .then((res) => {
        if (!res.ok) throw new Error(`templates → ${res.status}`)
        return res.json()
      })
      .then((d: TemplatesStartResponse) => {
        if (alive) {
          setData(d)
          setLoading(false)
        }
      })
      .catch(() => {
        if (alive) {
          setError(true)
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [enabled, nonce])

  return { data, loading, error, reload }
}

/** POST "save as template". Throws on a non-ok response. */
export async function saveWorkoutAsTemplate(
  fromWorkoutId: string,
  name: string,
  opts: { carryProgression?: boolean } = {},
): Promise<CreatedTemplate> {
  const res = await fetch('/api/gym/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromWorkoutId,
      name,
      carryProgression: opts.carryProgression === true,
    }),
  })
  if (!res.ok) throw new Error(`save template → ${res.status}`)
  const payload = (await res.json()) as { template: CreatedTemplate }
  return payload.template
}

/** POST apply-template-update from the finish sheet. Throws on a non-ok response. */
export async function applyTemplateUpdate(
  workoutId: string,
  mode: 'structure' | 'values' | 'both',
): Promise<void> {
  const res = await fetch(
    `/api/gym/workouts/${encodeURIComponent(workoutId)}/apply-template-update`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    },
  )
  if (!res.ok) throw new Error(`apply template update → ${res.status}`)
}

/** PATCH the (just-completed) workout's name from the finish sheet. The route
 *  falls through to the completed-row rename once the workout is no longer
 *  active. Throws on a non-ok response. */
export async function renameFinishedWorkout(workoutId: string, name: string | null): Promise<void> {
  const res = await fetch(`/api/gym/workouts/${encodeURIComponent(workoutId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`rename workout → ${res.status}`)
}
