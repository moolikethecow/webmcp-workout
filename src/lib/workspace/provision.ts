/**
 * Workspace provisioning — turning a freshly minted `ws` cookie into a real,
 * fully seeded Postgres schema.
 *
 * Flow, once per workspace id per process:
 *
 *   public.workspaces row?  ──yes─▸ (schema still there?) ──yes─▸ done
 *          │no                                  │no
 *          ▼                                    ▼
 *   CREATE SCHEMA ws_… ──▸ ensureGymSchema() + ensureAppSettingsSchema()
 *   ──▸ seedWorkspace() (catalog + the demo athlete) ──▸ stamp seeded_at
 *
 * The DDL and the seed run inside `runProvisioning(id, …)` so the `db` client
 * routes them into the new schema AND skips re-entering this module (see
 * `WorkspaceStore.provisioning`).
 *
 * `public.workspaces` is the durable "already done" marker: without it every
 * request after a restart would pay a `pg_namespace` round-trip. The
 * in-process `provisioned` Set is the hot path — one DB check per id per
 * process, then nothing.
 */
import { sql } from 'drizzle-orm'

import { unscopedDb, workspaceDrizzle } from '@/lib/db/client'
import { ensureAppSettingsSchema } from '@/lib/db/ensure-app-settings'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'

import { isWorkspaceId, runProvisioning, schemaNameFor } from './context'
import { seedWorkspace } from './seed'

/** Ids known-good in THIS process — the hot path skips every query. */
const provisioned = new Set<string>()
/** In-flight provisions, so N concurrent first requests do the work ONCE. */
const inflight = new Map<string, Promise<void>>()
/** Last `last_seen_at` write per id (epoch ms), throttling the sweeper's clock. */
const touchedAt = new Map<string, number>()

const TOUCH_INTERVAL_MS = 10 * 60_000

let registryPromise: Promise<void> | null = null

/** The cross-workspace registry. Lives in `public`, created on first use like
 *  every other table in this app (there are no migrations to run). */
async function ensureRegistry(): Promise<void> {
  if (!registryPromise) {
    registryPromise = (async () => {
      await unscopedDb().execute(sql`
        CREATE TABLE IF NOT EXISTS public.workspaces (
          id UUID PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          seeded_at TIMESTAMPTZ
        )
      `)
      await unscopedDb().execute(
        sql`CREATE INDEX IF NOT EXISTS idx_workspaces_last_seen ON public.workspaces(last_seen_at)`,
      )
    })().catch((err: unknown) => {
      registryPromise = null
      throw err
    })
  }
  await registryPromise
}

/** Exposed for the sweeper, which reads the registry before any request has
 *  necessarily provisioned anything in this process. */
export { ensureRegistry as ensureWorkspaceRegistry }

/** Bump `last_seen_at`, at most once per 10 minutes per id. Fire-and-forget:
 *  a failed heartbeat must never fail a user's request. */
function touch(id: string): void {
  const now = Date.now()
  if (now - (touchedAt.get(id) ?? 0) < TOUCH_INTERVAL_MS) return
  touchedAt.set(id, now)
  void unscopedDb()
    .execute(sql`UPDATE public.workspaces SET last_seen_at = now() WHERE id = ${id}::uuid`)
    .catch((err: unknown) => {
      console.error('[workspace] last_seen_at heartbeat failed:', err instanceof Error ? err.message : err)
    })
}

async function provision(id: string): Promise<void> {
  await ensureRegistry()
  const schema = schemaNameFor(id)

  const known = (
    await unscopedDb().execute(
      sql`SELECT (seeded_at IS NOT NULL) AS seeded FROM public.workspaces WHERE id = ${id}::uuid`,
    )
  ).rows as unknown as Array<{ seeded: boolean }>

  if (known[0]?.seeded) {
    // Trust the registry only if the schema is actually still there — a manual
    // DROP SCHEMA (or a half-finished sweep) must re-provision, not 500 every
    // query with "relation does not exist".
    const ns = (
      await unscopedDb().execute(sql`SELECT 1 FROM pg_namespace WHERE nspname = ${schema}`)
    ).rows
    if (ns.length > 0) return
  }

  await unscopedDb().execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`)
  await unscopedDb().execute(
    sql`INSERT INTO public.workspaces (id) VALUES (${id}::uuid) ON CONFLICT (id) DO NOTHING`,
  )

  await runProvisioning(id, async () => {
    // ensureGymSchema() calls ensureAppSettingsSchema() itself, but the gym
    // lane is the one that CREATES app_settings' gym columns — calling both
    // explicitly keeps this readable and costs one memoized no-op.
    await ensureAppSettingsSchema()
    await ensureGymSchema()
    await seedWorkspace(workspaceDrizzle(id), { now: new Date() })
  })

  await unscopedDb().execute(
    sql`UPDATE public.workspaces SET seeded_at = now(), last_seen_at = now() WHERE id = ${id}::uuid`,
  )
  touchedAt.set(id, Date.now())
}

/**
 * Make sure `id`'s schema exists, is migrated and is seeded. Idempotent,
 * concurrency-safe, and after the first call in a process it is a Set lookup
 * plus a throttled heartbeat.
 */
export async function ensureProvisioned(id: string): Promise<void> {
  if (!isWorkspaceId(id)) throw new Error(`[workspace] ensureProvisioned called with an invalid id: ${JSON.stringify(id)}`)

  if (provisioned.has(id)) {
    touch(id)
    return
  }

  let pending = inflight.get(id)
  if (!pending) {
    pending = provision(id)
      .then(() => {
        provisioned.add(id)
      })
      .finally(() => {
        // Cleared either way: a failure must be retried by the next request
        // rather than cached as a permanently poisoned promise.
        inflight.delete(id)
      })
    inflight.set(id, pending)
  }
  await pending
}

/** Forget a workspace's provisioning state — for the sweeper and for tests
 *  that drop a schema out from under the process. */
export function forgetProvisioned(id: string): void {
  provisioned.delete(id)
  inflight.delete(id)
  touchedAt.delete(id)
}

/** Registry metadata for `GET /api/workspace`. */
export async function workspaceInfo(
  id: string,
): Promise<{ id: string; createdAt: string | null; seededAt: string | null }> {
  await ensureRegistry()
  const rows = (
    await unscopedDb().execute(sql`
      SELECT created_at::text AS created_at, seeded_at::text AS seeded_at
      FROM public.workspaces WHERE id = ${id}::uuid
    `)
  ).rows as unknown as Array<{ created_at: string | null; seeded_at: string | null }>
  return { id, createdAt: rows[0]?.created_at ?? null, seededAt: rows[0]?.seeded_at ?? null }
}
