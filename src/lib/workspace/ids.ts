/**
 * Workspace identity primitives — the ONLY workspace module the Edge runtime
 * imports.
 *
 * `src/middleware.ts` runs on the Edge runtime, where `node:async_hooks` and
 * `pg` do not exist, so it cannot import `./context` (AsyncLocalStorage) or
 * anything that reaches `@/lib/db/client`. These three constants and the
 * validator are the shared contract between the middleware that MINTS a
 * workspace id and the server code that READS one; keeping them in a
 * dependency-free module is what lets both sides agree without duplicating a
 * regex that would inevitably drift.
 */

/** Cookie carrying the visitor's workspace id. HttpOnly — the browser never
 *  needs to read it; every scoped query resolves it server-side. */
export const WORKSPACE_COOKIE = 'ws'

/** Request header the middleware stamps so the SAME request that mints a
 *  cookie can already resolve its workspace (a `Set-Cookie` only reaches the
 *  server on the NEXT request). */
export const WORKSPACE_HEADER = 'x-workspace-id'

/** 180 days, in seconds. Long enough that a judge who bookmarks the app in
 *  week 1 still finds their data in week 3. */
export const WORKSPACE_COOKIE_MAX_AGE = 180 * 24 * 60 * 60

/**
 * Strict UUID v4. Deliberately narrower than "any UUID": the id becomes a
 * Postgres schema name (`ws_<32 hex>`), so anything that is not exactly this
 * shape is rejected and replaced rather than interpolated. Case-insensitive on
 * read; `schemaNameFor` lower-cases before use.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Type guard: is this a workspace id we are willing to trust? */
export function isWorkspaceId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_V4.test(value)
}

/**
 * The Postgres schema backing a workspace: `ws_` + the id's 32 hex digits.
 * 35 characters, comfortably inside Postgres's 63-byte identifier limit, and
 * — because `isWorkspaceId` gates it — impossible to inject through.
 */
export function schemaNameFor(id: string): string {
  if (!isWorkspaceId(id)) throw new Error(`[workspace] refusing to build a schema name from ${JSON.stringify(id)}`)
  return `ws_${id.replace(/-/g, '').toLowerCase()}`
}
