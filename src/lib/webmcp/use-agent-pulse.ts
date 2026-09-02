'use client'

/**
 * useAgentPulse — "this row was just changed by the agent".
 *
 * The store holds a timestamp per exercise; a component needs a boolean that
 * goes false again on its own, so the hook owns one timer. Nothing here decides
 * how the highlight looks — that is a CSS class, and it is inert under
 * prefers-reduced-motion.
 */
import { useEffect, useState } from 'react'

import { AGENT_PULSE_MS, agentTouchedAt, useAgentEventStore } from './agent-events'

export function useAgentPulse(name: string | null | undefined): boolean {
  const touched = useAgentEventStore((state) => state.touched)
  const at = name ? agentTouchedAt(touched, name) : null
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (at == null) return
    const remaining = at + AGENT_PULSE_MS - Date.now()
    if (remaining <= 0) return
    setNow(Date.now())
    const timer = setTimeout(() => setNow(Date.now()), remaining)
    return () => clearTimeout(timer)
  }, [at])

  return at != null && now - at < AGENT_PULSE_MS
}
