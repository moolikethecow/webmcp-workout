/**
 * register.ts — put this page's tools on the browser's model context.
 *
 * Two things matter here and nothing else does:
 *
 *   Feature detection. WebMCP ships behind a flag; most visitors will not have
 *   it. The app must work identically without it, so an absent API is a normal
 *   outcome, logged once at info level, not an error.
 *
 *   Per-tool isolation. `registerTool` validates the schema. One malformed tool
 *   must not take the other eleven down with it, so each registration is
 *   awaited inside its own try/catch and the caller gets back the names that
 *   actually landed.
 *
 * Unregistration is the AbortController's job: abort the signal passed here and
 * the browser drops every tool registered with it.
 */
import type { ModelContextLike, WebMcpTool } from './types'

let absenceLogged = false

/** `document.modelContext` is canonical; `navigator.modelContext` is the older
 *  Chromium preview surface and is kept only as a fallback. */
export function getModelContext(): ModelContextLike | null {
  if (typeof document === 'undefined') return null
  const fromDocument = (document as unknown as { modelContext?: ModelContextLike }).modelContext
  if (fromDocument) return fromDocument
  const fromNavigator =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as unknown as { modelContext?: ModelContextLike }).modelContext
  return fromNavigator ?? null
}

export interface RegisterResult {
  registered: string[]
  /** Tools whose registration threw, with the reason. Empty on a clean run. */
  failed: Array<{ name: string; error: string }>
  /** False when the browser has no WebMCP support (the common case today). */
  supported: boolean
}

export async function registerTools(
  tools: WebMcpTool[],
  signal: AbortSignal,
): Promise<RegisterResult> {
  const modelContext = getModelContext()
  if (!modelContext) {
    if (!absenceLogged) {
      absenceLogged = true
      // Info, not warn: a browser without WebMCP is not misconfigured. Chrome
      // needs chrome://flags/#enable-webmcp-testing (or an origin trial token);
      // ChatGPT's in-app browser has it on.
      console.info(
        '[webmcp] document.modelContext is not available — the app works normally, but agent tools are not registered. See docs/WEBMCP.md.',
      )
    }
    return { registered: [], failed: [], supported: false }
  }

  const registered: string[] = []
  const failed: RegisterResult['failed'] = []
  for (const tool of tools) {
    if (signal.aborted) break
    try {
      await modelContext.registerTool(tool, { signal })
      registered.push(tool.name)
    } catch (err) {
      failed.push({ name: tool.name, error: err instanceof Error ? err.message : String(err) })
      console.warn(`[webmcp] failed to register "${tool.name}":`, err)
    }
  }
  return { registered, failed, supported: true }
}
