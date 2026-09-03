/**
 * Minimal WebMCP types for this app's tool layer.
 *
 * `@mcp-b/webmcp-types` is installed as a dev dependency and is the reference
 * for the shape, but we do not import it here for two reasons:
 *
 *   1. Its `execute` is declared as `(input) => …` — a single argument. The API
 *      this app targets (and the one Chrome ships) passes an execution context
 *      as the second argument: `execute(args, { signal })`. We use the signal,
 *      so we need the two-argument signature.
 *   2. Its `tool.d.ts` imports `ToolAnnotations` from `@modelcontextprotocol/server`,
 *      an unlisted peer that is not installed here. That resolves only because
 *      `skipLibCheck` is on; relying on it would be fragile.
 *
 * These declarations are deliberately small and structural: anything assignable
 * to `WebMcpTool` is assignable to the browser's `registerTool` argument.
 */

/** A JSON Schema draft-07 object schema — what `inputSchema` must be. */
export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}

export interface WebMcpToolAnnotations {
  /** True when the tool only reads. Agents use it to decide what needs consent. */
  readOnlyHint?: boolean
  /** True when the tool's result can contain content the user did not author. */
  untrustedContentHint?: boolean
  [key: string]: unknown
}

export interface TextContent {
  type: 'text'
  text: string
}

/** Every tool in this app answers with exactly one text block of JSON. */
export interface WebMcpToolResult {
  content: TextContent[]
  isError?: boolean
}

export interface WebMcpExecuteContext {
  signal?: AbortSignal
}

export interface WebMcpTool {
  name: string
  description: string
  inputSchema: JsonSchemaObject
  annotations?: WebMcpToolAnnotations
  execute: (
    args: Record<string, unknown>,
    context?: WebMcpExecuteContext,
  ) => Promise<WebMcpToolResult>
}

export interface WebMcpRegisterOptions {
  signal?: AbortSignal
}

/** A tool as `getTools()` reports it: only the name is relied on here. */
export interface RegisteredToolLike {
  name: string
  [key: string]: unknown
}

/** The slice of `document.modelContext` this app uses. `getTools` is optional
 *  because not every host implements it (ChatGPT's browser omits it along with
 *  the declarative API); its presence is itself a capability signal. */
export interface ModelContextLike {
  registerTool(tool: WebMcpTool, options?: WebMcpRegisterOptions): Promise<void> | void
  getTools?(): Promise<RegisteredToolLike[]>
}
