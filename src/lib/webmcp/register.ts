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
 *   must not take the rest down with it, so each registration is
 *   awaited inside its own try/catch and the caller gets back the names that
 *   actually landed.
 *
 * Unregistration is the AbortController's job: abort the signal passed here and
 * the browser drops every tool registered with it.
 */
import type { ModelContextLike, WebMcpTool } from './types'

/** How long to give a browser that registers `<form toolname>` tools
 *  asynchronously before concluding it has not. */
const DECLARATIVE_SETTLE_MS = 300
import { devShimRequested, installDevShim } from './dev-shim'

let devShim: ModelContextLike | null = null

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
  if (fromNavigator) return fromNavigator
  // Opt-in stand-in for local verification only (see dev-shim.ts).
  if (devShimRequested()) return (devShim ??= installDevShim())
  return null
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

/**
 * Register a code-defined stand-in for a tool the page also declares as a
 * `<form toolname="…">`, but only where the browser did not publish the form.
 *
 * Chrome does: `getTools()` lists the form-derived tool, and registering a
 * second tool under the same name would be rejected anyway. ChatGPT's built-in
 * browser implements neither `getTools` nor the declarative API, so the form
 * is invisible there and the fallback is the only way the capability exists.
 *
 * A host that has `getTools` but has not listed the form after a short settle
 * is treated the same as one without it — a duplicate-name rejection is caught
 * per tool, so guessing wrong costs a console line, not the other tools.
 */
export async function registerDeclarativeFallbacks(
  tools: WebMcpTool[],
  signal: AbortSignal,
): Promise<RegisterResult> {
  const modelContext = getModelContext()
  if (!modelContext) return { registered: [], failed: [], supported: false }

  let published = new Set<string>()
  if (typeof modelContext.getTools === 'function') {
    await new Promise((resolve) => setTimeout(resolve, DECLARATIVE_SETTLE_MS))
    if (signal.aborted) return { registered: [], failed: [], supported: true }
    try {
      published = new Set((await modelContext.getTools()).map((tool) => tool.name))
    } catch (err) {
      console.warn('[webmcp] getTools() failed; assuming no declarative tools were published:', err)
    }
  }

  const missing = tools.filter((tool) => !published.has(tool.name))
  if (missing.length === 0) return { registered: [], failed: [], supported: true }
  const result = await registerTools(missing, signal)
  if (result.registered.length > 0) {
    console.info(
      `[webmcp] this browser did not publish the declarative form tool(s) ${result.registered.join(', ')}; registered a code-defined stand-in that still waits for a person to press the button.`,
    )
  }
  return result
}
