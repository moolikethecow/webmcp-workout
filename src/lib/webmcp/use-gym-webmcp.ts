'use client'

/**
 * useGymWebMCP — register this page's tools for as long as the page is mounted.
 *
 * The whole hook is one effect and one AbortController. Mount registers, unmount
 * aborts, and aborting is what unregisters — there is no manual teardown list to
 * fall out of sync.
 *
 * The important discipline is what is NOT here: no React state is captured. A
 * tool's `execute` always fetches canonical state from the server, so a
 * registration made on first render cannot go stale, and an agent can never be
 * handed a snapshot of what the UI happened to be showing when the page loaded.
 */
import { useEffect, useState } from 'react'

import { useAgentEventStore } from './agent-events'
import { registerTools, type RegisterResult } from './register'
import { toolsForPage, type GymPage } from './tools'

export interface GymWebMcpStatus {
  /** False when the browser has no WebMCP API (the app works either way). */
  supported: boolean
  /** Names successfully registered for this page. */
  registered: string[]
}

export function useGymWebMCP(page: GymPage): GymWebMcpStatus {
  const [status, setStatus] = useState<GymWebMcpStatus>({ supported: false, registered: [] })

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    void registerTools(toolsForPage(page), controller.signal).then((result: RegisterResult) => {
      if (cancelled) return
      setStatus({ supported: result.supported, registered: result.registered })
      // Published so the UI can say, honestly, what this browser can do — a
      // browser without WebMCP is told so rather than shown "0 tools".
      useAgentEventStore.getState().setRegistration({
        checked: true,
        supported: result.supported,
        registered: result.registered,
      })
    })

    return () => {
      cancelled = true
      // Unregisters every tool registered with this signal, so the published
      // registration has to go with it.
      controller.abort()
      useAgentEventStore.getState().setRegistration({ checked: false, supported: false, registered: [] })
    }
  }, [page])

  return status
}
