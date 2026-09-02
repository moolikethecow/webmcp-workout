/**
 * shared.ts — the result envelope every tool uses, plus the post-mutation
 * refresh.
 *
 * Two rules, applied everywhere:
 *
 *   A tool never throws. Agents recover far better from a text error than from
 *   a rejected promise, so a failure comes back as one text block that starts
 *   with "Error:" and carries the server's own message.
 *
 *   A successful mutation is always followed by `afterMutation`, which bumps
 *   the app's data-sync version (so the open page refetches canonical state)
 *   and appends a line to the agent-events feed (so the person watching the
 *   screen can see what just changed and who changed it).
 */
import { recordAgentEvent } from '@/lib/webmcp/agent-events'
import { invalidateResources } from '@/lib/stores/data-sync-store'

import type { AgentFetchResult } from '../fetch'
import type { WebMcpToolResult } from '../types'

export function ok(payload: unknown): WebMcpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

export function fail(message: string): WebMcpToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

/** Turn a non-2xx response into agent-readable text, keeping the server's body. */
export function failFrom(result: AgentFetchResult, fallback: string): WebMcpToolResult {
  const body = result.json
  const message =
    typeof body.error === 'string' && body.error ? body.error : `${fallback} (HTTP ${result.status})`
  const extra = { ...body }
  delete extra.error
  const detail = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : ''
  return fail(`${message}${detail}`)
}

/** Refresh the open page and record the change in the visible agent feed.
 *  `exercises` are the movements this mutation touched (`['*']` = all of them),
 *  which is what makes the affected rows pulse instead of silently changing. */
export function afterMutation(tool: string, summary: string, exercises?: string[]): void {
  invalidateResources(['gym'])
  recordAgentEvent(tool, summary, exercises)
}

/** Read a string arg, trimmed; undefined when absent or empty. */
export function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Read a finite number arg; undefined when absent or not a number. */
export function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  return typeof value === 'boolean' ? value : undefined
}
