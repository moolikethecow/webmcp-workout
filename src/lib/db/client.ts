/**
 * Workspace-scoped database client.
 *
 * Every visitor gets their own Postgres SCHEMA (`ws_<uuid hex>`), and every
 * gym module keeps its original single-tenant code: `import { db } from
 * '@/lib/db/client'` then `db.execute(sql\`...\`)` / `db.transaction(...)`.
 * The isolation happens entirely here.
 *
 * On each call `db` resolves the current workspace (cookie/header/override —
 * see `@/lib/workspace/context`), makes sure that workspace's schema exists
 * and is seeded, and then hands the query to a per-workspace drizzle instance
 * whose pool pins `search_path` to that schema.
 *
 * WHY `search_path` ON THE POOL'S `connect` EVENT, not the `options` startup
 * parameter: `options: '-c search_path=...'` is silently dropped by several
 * poolers (PgBouncer, Supabase's pooler, Neon's proxy) — the connection comes
 * up on `public` and one visitor reads another's rows. The `connect` handler
 * is honoured everywhere: node-postgres queues the `SET` on the client's own
 * serial query queue BEFORE handing the client to whoever is waiting for it,
 * so no query can ever run ahead of it.
 *
 * `db` is a Proxy typed as the drizzle instance rather than a hand-rolled
 * interface so that the ~30 modules doing `Parameters<typeof db.transaction>`
 * / `Pick<typeof db, 'execute'>` keep compiling unchanged. Only `execute` and
 * `transaction` are reachable (the entire codebase uses nothing else); any
 * other property throws loudly instead of resolving to `undefined`.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import { currentWorkspaceId, getWorkspaceStore, runWithWorkspace, schemaNameFor } from '@/lib/workspace/context'

type Drizzle = NodePgDatabase<Record<string, never>>

/** Max distinct workspaces holding open pools. Each is `max: 3`, so the worst
 *  case is 120 backends — fine for a single Postgres on a small VM, and the
 *  LRU means a demo weekend with hundreds of visitors never gets there. */
const MAX_POOLS = 40

interface Entry {
  pool: Pool
  db: Drizzle
}

const pools = new Map<string, Entry>()

/**
 * A Postgres restart kills every pooled connection at once, and node-postgres
 * surfaces each dead idle client as an 'error' event on its pool. With no
 * listener Node turns every one of those into an uncaught exception — a crash
 * burst per deploy. Log instead; the pool discards dead clients and dials
 * fresh ones on the next checkout.
 */
function attachErrorListener(pool: Pool, label: string): void {
  pool.on('error', (err) => {
    console.error(`[db] pool connection dropped (${label}, pool will reconnect):`, err.message)
  })
}

function createPool(): Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Keep TCP-level keepalives on so transient NAT/load-balancer drops surface
    // as errors instead of long hangs at first byte.
    keepAlive: true,
  })
}

/** The per-workspace pool + drizzle instance, creating it on first use and
 *  refreshing its LRU position. Exported for scripts and the provisioner,
 *  which need the REAL drizzle instance (the `db` proxy resolves the workspace
 *  itself and would re-enter provisioning). */
export function workspaceDrizzle(id: string): Drizzle {
  return entryFor(id).db
}

function entryFor(id: string): Entry {
  const existing = pools.get(id)
  if (existing) {
    // Re-insert to mark most-recently-used (Map preserves insertion order).
    pools.delete(id)
    pools.set(id, existing)
    return existing
  }

  const schema = schemaNameFor(id)
  const pool = createPool()
  attachErrorListener(pool, schema)
  pool.on('connect', (client) => {
    // 'connect' is emitted BEFORE pg-pool hands the client to whoever is
    // waiting for it, so this SET is first in that client's serial query queue
    // and no application query can run ahead of it. (pg logs a "client is
    // already executing a query" deprecation warning when the waiting caller's
    // query lands on top of this one — that is the queue doing its job, not a
    // race.) `schema` is derived from a validated UUID, so it cannot inject.
    void client.query(`SET search_path TO "${schema}", public`).catch((err: unknown) => {
      console.error(
        `[db] failed to pin search_path for ${schema}:`,
        err instanceof Error ? err.message : err,
      )
    })
  })

  const entry: Entry = { pool, db: drizzle(pool) }
  pools.set(id, entry)

  while (pools.size > MAX_POOLS) {
    const oldest = pools.keys().next()
    if (oldest.done) break
    const evicted = pools.get(oldest.value)
    pools.delete(oldest.value)
    void evicted?.pool.end().catch((err: unknown) => {
      console.error('[db] evicted pool failed to close:', err instanceof Error ? err.message : err)
    })
  }

  return entry
}

/** Close and forget a workspace's pool — used by the sweeper right before it
 *  drops the schema out from under it. */
export async function closeWorkspacePool(id: string): Promise<void> {
  const entry = pools.get(id)
  if (!entry) return
  pools.delete(id)
  try {
    await entry.pool.end()
  } catch (err) {
    console.error('[db] pool failed to close:', err instanceof Error ? err.message : err)
  }
}

// ---------------------------------------------------------------------------
// The unscoped (public-schema) client
// ---------------------------------------------------------------------------

let unscoped: Drizzle | null = null

/**
 * A drizzle instance with NO `search_path` override, for the cross-workspace
 * bookkeeping that by definition cannot live inside a workspace: the
 * `public.workspaces` registry, `CREATE SCHEMA`, `DROP SCHEMA`. Never use it
 * for application data.
 */
export function unscopedDb(): Drizzle {
  if (!unscoped) {
    const pool = createPool()
    attachErrorListener(pool, 'public')
    unscoped = drizzle(pool)
  }
  return unscoped
}

// ---------------------------------------------------------------------------
// The workspace-scoped `db` every gym module imports
// ---------------------------------------------------------------------------

async function resolve(): Promise<Drizzle> {
  const id = await currentWorkspaceId()
  if (!getWorkspaceStore()?.provisioning) {
    // Imported lazily: `./provision` imports this module (for `unscopedDb` and
    // `workspaceDrizzle`) and pulls in the 1300-row seed catalog. A static
    // import would be a cycle AND would load that JSON into every process that
    // merely touches the db.
    const { ensureProvisioned } = await import('@/lib/workspace/provision')
    await ensureProvisioned(id)
  }
  return workspaceDrizzle(id)
}

/** Property reads that are introspection, not a query: returning `undefined`
 *  keeps `await`, `console.log`, structured cloning and vitest's pretty-print
 *  from exploding on the proxy. */
const PASSTHROUGH = new Set(['then', 'catch', 'finally', 'constructor', 'toJSON', 'inspect', '$brand'])

const METHODS: Record<string, unknown> = {
  execute: (query: Parameters<Drizzle['execute']>[0]) => resolve().then((d) => d.execute(query)),
  transaction: (
    fn: Parameters<Drizzle['transaction']>[0],
    config?: Parameters<Drizzle['transaction']>[1],
  ) => resolve().then((d) => d.transaction(fn, config)),
}

export const db: Drizzle = new Proxy({} as Drizzle, {
  get(_target, prop) {
    if (typeof prop === 'symbol' || PASSTHROUGH.has(prop)) return undefined
    if (prop in METHODS) return METHODS[prop]
    throw new Error(
      `[db] db.${String(prop)} is not available on the workspace-scoped client. ` +
        'Only db.execute() and db.transaction() are proxied; use raw SQL, or ' +
        'workspaceDrizzle(id) if you genuinely need the underlying drizzle instance.',
    )
  },
})

export type DB = typeof db

/** Run `fn` against a specific workspace — for scripts, the sweeper and tests.
 *  Inside it, the ambient `db` resolves to `id` regardless of any request. */
export function withWorkspaceDb<T>(id: string, fn: (db: Drizzle) => Promise<T>): Promise<T> {
  return runWithWorkspace(id, () => fn(db))
}
