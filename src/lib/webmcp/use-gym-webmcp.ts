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
 *
 * After the page's own tools, the dashboard asks for its declarative fallback:
 * `report_training_constraint` is a `<form>` there, and a browser without the
 * declarative API (ChatGPT's) gets the same tool registered in code instead.
 * That second step is skipped wherever the form was published natively.
 */
import { useEffect, useState } from 'react'

import { useAgentEventStore } from './agent-events'
import { registerDeclarativeFallbacks, registerTools, type RegisterResult } from './register'
import { declarativeFallbacksForPage, toolsForPage, type GymPage } from './tools'

export interface GymWebMcpStatus {
  /** False until the registration attempt has resolved. */
  checked: boolean
  /** False when the browser has no WebMCP API (the app works either way). */
  supported: boolean
  /** Names live for this page: the tools this code registered, plus any
   *  form tool the browser published itself. */
  registered: string[]
  /** Names registered as code-defined stand-ins for form tools this browser
   *  did not publish. A subset of `registered`. */
  fallbacks: string[]
}

const INITIAL: GymWebMcpStatus = { checked: false, supported: false, registered: [], fallbacks: [] }

export function useGymWebMCP(page: GymPage): GymWebMcpStatus {
  const [status, setStatus] = useState<GymWebMcpStatus>(INITIAL)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    const publish = (next: GymWebMcpStatus) => {
      if (cancelled) return
      setStatus(next)
      // Published so the UI can say, honestly, what this browser can do — a
      // browser without WebMCP is told so rather than shown "0 tools".
      useAgentEventStore.getState().setRegistration({
        checked: next.checked,
        supported: next.supported,
        registered: next.registered,
      })
    }

    void (async () => {
      const own: RegisterResult = await registerTools(toolsForPage(page), controller.signal)
      publish({ checked: true, supported: own.supported, registered: own.registered, fallbacks: [] })
      if (!own.supported || cancelled) return

      const fallbacks = declarativeFallbacksForPage(page)
      if (fallbacks.length === 0) return
      const extra = await registerDeclarativeFallbacks(fallbacks, controller.signal)
      if (cancelled) return
      // Three outcomes, one truth: the name is live on this page when the
      // browser published the form itself (nothing to register, nothing
      // failed) or when the stand-in registered. A failed stand-in on a browser
      // that also did not publish the form is the only way it is absent.
      const native = extra.registered.length === 0 && extra.failed.length === 0
      const live = native ? fallbacks.map((tool) => tool.name) : extra.registered
      publish({
        checked: true,
        supported: true,
        registered: [...own.registered, ...live],
        fallbacks: extra.registered,
      })
    })()

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
