/**
 * Regression: a page's first requests arrive together. Some go through the
 * `db` proxy, some call a DDL ensure directly (every gym route does). Before
 * 2026-09-02 the direct ensure memoized itself under the workspace key and the
 * provisioner then awaited that same memo while the memo awaited provisioning
 * — an in-process deadlock with zero Postgres backends. Live test; skipped
 * without DATABASE_URL.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'

const url = process.env.DATABASE_URL
const describeLive = url ? describe : describe.skip

describeLive('concurrent first touch of a fresh workspace', () => {
  it('provisions once and every caller resolves', async () => {
    const { runWithWorkspace, schemaNameFor } = await import('@/lib/workspace/context')
    const { ensureGymSchema } = await import('@/lib/db/ensure-fitness')
    const { db, unscopedDb, closeWorkspacePool } = await import('@/lib/db/client')
    const { forgetProvisioned } = await import('@/lib/workspace/provision')
    const id = randomUUID()
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('deadlock: first-touch calls did not resolve in 25s')), 25_000),
    )
    try {
      const results = await Promise.race([
        Promise.all([
          runWithWorkspace(id, () => db.execute(sql`select count(*)::int AS n FROM workouts`)),
          runWithWorkspace(id, () => ensureGymSchema()),
          runWithWorkspace(id, () => db.execute(sql`select count(*)::int AS n FROM exercises`)),
          runWithWorkspace(id, () => ensureGymSchema()),
        ]),
        timeout,
      ])
      const workouts = (results[0] as unknown as { rows: Array<{ n: number }> }).rows[0].n
      const exercises = (results[2] as unknown as { rows: Array<{ n: number }> }).rows[0].n
      expect(workouts).toBeGreaterThan(0)
      expect(exercises).toBeGreaterThan(1000)
    } finally {
      await closeWorkspacePool(id)
      forgetProvisioned(id)
      await unscopedDb().execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schemaNameFor(id))} CASCADE`)
      await unscopedDb().execute(sql`DELETE FROM public.workspaces WHERE id = ${id}::uuid`)
    }
  }, 40_000)
})
