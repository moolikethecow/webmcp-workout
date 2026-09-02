/**
 * Resolving "which workspace is this call for?".
 *
 * Two sources, in priority order:
 *
 *  1. An explicit `AsyncLocalStorage` override (`runWithWorkspace`). Scripts,
 *     the provisioner, the sweeper and tests have no HTTP request to read, and
 *     an override also lets one request deliberately act on another workspace.
 *  2. The current request — the `x-workspace-id` header the middleware stamps
 *     (correct even on the very first visit, where the cookie has been minted
 *     but not yet echoed back), falling back to the `ws` cookie.
 *
 * Nothing here touches the database. `@/lib/db/client` calls
 * `currentWorkspaceId()` on every `execute`/`transaction`, so this module must
 * stay cheap and free of cycles.
 *
 * `next/headers` is imported DYNAMICALLY on purpose: it is a server-only module
 * that throws at import time outside a React server context, and this file is
 * pulled in (transitively, via the db client) by every unit test in the tree.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import { WORKSPACE_COOKIE, WORKSPACE_HEADER, isWorkspaceId } from './ids'

export { WORKSPACE_COOKIE, WORKSPACE_HEADER, isWorkspaceId, schemaNameFor, WORKSPACE_COOKIE_MAX_AGE } from './ids'

/**
 * Thrown when a DB call cannot be attributed to a workspace — no override, no
 * header, no cookie. Routes translate this into a 400: it means the caller
 * skipped the middleware (a direct server-side fetch, a stray cron), not that
 * anything is broken.
 */
export class NoWorkspaceError extends Error {
  readonly code = 'NO_WORKSPACE'
  constructor(message = 'No workspace in scope: request carried no ws cookie or x-workspace-id header') {
    super(message)
    this.name = 'NoWorkspaceError'
  }
}

export interface WorkspaceStore {
  readonly id: string
  /**
   * True while this workspace's schema is being created and migrated. The db
   * client checks it to skip `ensureProvisioned()` — without it the DDL issued
   * BY the provisioner would re-enter the provisioner and await its own
   * in-flight promise, deadlocking the first request to every new workspace.
   */
  readonly provisioning: boolean
}

const storage = new AsyncLocalStorage<WorkspaceStore>()

/** The active override, if any. Synchronous — the db client needs it before it
 *  decides whether to provision. */
export function getWorkspaceStore(): WorkspaceStore | undefined {
  return storage.getStore()
}

/**
 * Run `fn` with `id` as the ambient workspace, overriding any request cookie.
 * Used by scripts, the reset route, the sweeper and tests.
 */
export function runWithWorkspace<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (!isWorkspaceId(id)) throw new Error(`[workspace] runWithWorkspace called with an invalid id: ${JSON.stringify(id)}`)
  return storage.run({ id, provisioning: false }, fn)
}

/** `runWithWorkspace`, but flagged so nested db calls skip provisioning.
 *  Internal to `./provision` — see `WorkspaceStore.provisioning`. */
export function runProvisioning<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (!isWorkspaceId(id)) throw new Error(`[workspace] runProvisioning called with an invalid id: ${JSON.stringify(id)}`)
  return storage.run({ id, provisioning: true }, fn)
}

/**
 * The workspace this call belongs to. Throws `NoWorkspaceError` when there is
 * none — never guesses, never falls back to a shared default schema, because a
 * silent fallback would leak one visitor's history into another's browser.
 */
export async function currentWorkspaceId(): Promise<string> {
  const store = storage.getStore()
  if (store) return store.id

  // Outside a request (a script that forgot `runWithWorkspace`, a module
  // top-level side effect) both of these throw; that is the NoWorkspaceError
  // path, not an error worth surfacing on its own.
  let headerValue: string | null = null
  let cookieValue: string | null = null
  try {
    const { headers, cookies } = await import('next/headers')
    try {
      headerValue = (await headers()).get(WORKSPACE_HEADER)
    } catch {
      headerValue = null
    }
    if (!isWorkspaceId(headerValue)) {
      try {
        cookieValue = (await cookies()).get(WORKSPACE_COOKIE)?.value ?? null
      } catch {
        cookieValue = null
      }
    }
  } catch {
    // next/headers is unavailable entirely (plain node script, some test envs).
  }

  if (isWorkspaceId(headerValue)) return headerValue
  if (isWorkspaceId(cookieValue)) return cookieValue
  throw new NoWorkspaceError()
}

/**
 * Memoization key for the per-process DDL gates in `@/lib/db/ensure-*`.
 * Identical to `currentWorkspaceId()` except that "no workspace" is a KEY
 * (`__none__`) rather than a throw — those ensures are called from contexts
 * (tests with a fully mocked db) where the absence of a workspace is normal
 * and must not turn into an exception.
 */
export async function currentWorkspaceKey(): Promise<string> {
  try {
    return await currentWorkspaceId()
  } catch {
    return '__none__'
  }
}

/** True while the current async chain is the provisioner itself. */
export function inProvisioning(): boolean {
  return storage.getStore()?.provisioning === true
}

type ProvisionHook = (id: string) => Promise<void>
let provisionHook: ProvisionHook | null = null
/** Registered by `./provision` at module load; lets the DDL ensure functions
 *  defer to the provisioner without importing it (which would be a cycle). */
export function setProvisionHook(hook: ProvisionHook): void {
  provisionHook = hook
}
/**
 * Called by every DDL ensure function before it memoizes anything. Outside the
 * provisioner, an ensure must NOT run the DDL itself: it hands off to
 * provisioning and returns true ("already handled"). Otherwise a route's
 * ensure call and the provisioner's ensure call memoize under the same key and
 * wait on each other — a pure in-process deadlock that only appears when a
 * page's first requests arrive together (2026-09-02).
 */
export async function deferToProvisioner(): Promise<boolean> {
  if (inProvisioning()) return false
  let id: string
  try {
    id = await currentWorkspaceId()
  } catch {
    return false
  }
  if (!provisionHook) {
    // `./provision` imports this module; resolve it lazily at first use so the
    // hand-off works no matter which module was evaluated first.
    const mod = await import('./provision')
    provisionHook = mod.ensureProvisioned
  }
  await provisionHook(id)
  return true
}
