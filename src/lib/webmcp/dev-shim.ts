/**
 * dev-shim.ts — an opt-in stand-in for `document.modelContext`.
 *
 * Installed only when the page is opened with `?webmcp=shim` (or
 * `localStorage.webmcpShim === '1'`), so a plain browser can exercise the
 * registered tools exactly the way an agent would: `window.__webmcp.tools()`
 * lists them, `window.__webmcp.call(name, args)` executes one and returns the
 * tool's text result. It never runs in a browser that has the real API.
 */
import type { ModelContextLike, WebMcpTool, WebMcpToolResult } from './types'

export interface DevShimHandle {
  tools(): Array<{ name: string; description: string; readOnly: boolean }>
  call(name: string, args?: Record<string, unknown>): Promise<WebMcpToolResult>
}

declare global {
  interface Window {
    __webmcp?: DevShimHandle
  }
}

export function devShimRequested(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (new URLSearchParams(window.location.search).get('webmcp') === 'shim') {
      window.localStorage.setItem('webmcpShim', '1')
      return true
    }
    return window.localStorage.getItem('webmcpShim') === '1'
  } catch {
    return false
  }
}

export function installDevShim(): ModelContextLike {
  const tools = new Map<string, WebMcpTool>()
  const shim: ModelContextLike = {
    async registerTool(tool, options) {
      tools.set(tool.name, tool)
      options?.signal?.addEventListener('abort', () => {
        if (tools.get(tool.name) === tool) tools.delete(tool.name)
      })
    },
  }
  window.__webmcp = {
    tools: () =>
      [...tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        readOnly: t.annotations?.readOnlyHint === true,
      })),
    call: async (name, args = {}) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`no such tool: ${name}`)
      return tool.execute(args, { signal: new AbortController().signal })
    },
  }
  console.info('[webmcp] dev shim installed — window.__webmcp.tools() / .call(name, args)')
  return shim
}
