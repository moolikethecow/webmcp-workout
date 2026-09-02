/**
 * fetch.ts — the only way a tool talks to the server.
 *
 * Same-origin, cookie-bearing, and it never throws. A tool's `execute` must
 * always return something the agent can read; a network failure is a result,
 * not an exception, so it comes back as `{ ok: false, status: 0, json: {...} }`
 * and the tool turns it into text.
 *
 * There is no second transport. Everything the agent can do, the app's own UI
 * does through these same routes — that is what keeps the two from drifting.
 */

export interface AgentFetchResult {
  ok: boolean
  status: number
  /** Parsed JSON body, or `{ error }` when the body was not JSON. */
  json: Record<string, unknown>
}

export async function agentFetch(
  path: string,
  init: RequestInit = {},
): Promise<AgentFetchResult> {
  try {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
    const text = await response.text()
    let json: Record<string, unknown>
    try {
      const parsed: unknown = text ? JSON.parse(text) : {}
      json =
        parsed !== null && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : { value: parsed }
    } catch {
      json = { error: text.slice(0, 500) || `HTTP ${response.status}` }
    }
    return { ok: response.ok, status: response.status, json }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: { error: err instanceof Error ? err.message : 'Network request failed' },
    }
  }
}

/** Build a query string, dropping empty/undefined values. */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const rendered = search.toString()
  return rendered ? `?${rendered}` : ''
}
