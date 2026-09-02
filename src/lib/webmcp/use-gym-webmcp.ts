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
    })

    return () => {
      cancelled = true
      // Unregisters every tool registered with this signal.
      controller.abort()
    }
  }, [page])

  return status
}
