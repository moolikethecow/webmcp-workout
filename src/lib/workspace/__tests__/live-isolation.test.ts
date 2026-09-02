/**
 * The only test that proves the actual claim: two visitors, two schemas, and
 * nothing written by one is visible to the other. Mocks can't show this — the
 * isolation lives in `search_path`, which only exists on a real connection.
 *
 * Skipped unless DATABASE_URL is set (`pnpm db:up` starts the local Postgres).
 * Uses freshly generated workspace ids and drops both schemas afterwards, so
 * it never collides with another agent's fixtures in the same database.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

import { closeWorkspacePool, db, unscopedDb, withWorkspaceDb } from '@/lib/db/client'
import { schemaNameFor } from '@/lib/workspace/ids'
import { ensureProvisioned, forgetProvisioned } from '@/lib/workspace/provision'

const live = !!process.env.DATABASE_URL

const A = randomUUID()
const B = randomUUID()

async function dropSchema(id: string): Promise<void> {
  await closeWorkspacePool(id)
  forgetProvisioned(id)
  await unscopedDb().execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schemaNameFor(id))} CASCADE`)
  await unscopedDb().execute(sql`DELETE FROM public.workspaces WHERE id = ${id}::uuid`)
}

afterAll(async () => {
  if (!live) return
  await dropSchema(A)
  await dropSchema(B)
})

describe.skipIf(!live)('workspace isolation (live Postgres)', () => {
  it('provisions two independent, fully seeded schemas', async () => {
    const startA = Date.now()
    await ensureProvisioned(A)
    const msA = Date.now() - startA

    const startB = Date.now()
    await ensureProvisioned(B)
    const msB = Date.now() - startB
    console.log(`[live] provision A ${msA}ms, provision B ${msB}ms`)

    for (const id of [A, B]) {
      const rows = (
        await unscopedDb().execute(sql`SELECT 1 FROM pg_namespace WHERE nspname = ${schemaNameFor(id)}`)
      ).rows
      expect(rows).toHaveLength(1)
    }

    // Each schema owns its own catalog — not a shared table in `public`.
    const counts = await Promise.all(
      [A, B].map((id) =>
        withWorkspaceDb(id, async (scoped) => {
          const rows = (await scoped.execute(sql`SELECT count(*)::int AS n FROM exercises`))
            .rows as unknown as Array<{ n: number }>
          return rows[0]!.n
        }),
      ),
    )
    expect(counts[0]).toBeGreaterThan(1_000)
    expect(counts[1]).toBe(counts[0])

    // …and the seeded athlete's history landed in both.
    for (const id of [A, B]) {
      const n = await withWorkspaceDb(id, async (scoped) => {
        const rows = (await scoped.execute(sql`SELECT count(*)::int AS n FROM workouts`))
          .rows as unknown as Array<{ n: number }>
        return rows[0]!.n
      })
      expect(n).toBeGreaterThan(0)
    }
  }, 120_000)

  it('a workout written in A is invisible in B', async () => {
    const marker = `isolation-probe-${randomUUID()}`

    await withWorkspaceDb(A, async () => {
      // Through the ambient `db` proxy — the exact path every gym module uses.
      await db.execute(sql`
        INSERT INTO workouts (name, status, started_at, ended_at)
        VALUES (${marker}, 'completed', now(), now())
      `)
    })

    const inA = await withWorkspaceDb(A, async () => {
      const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM workouts WHERE name = ${marker}`))
        .rows as unknown as Array<{ n: number }>
      return rows[0]!.n
    })
    const inB = await withWorkspaceDb(B, async () => {
      const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM workouts WHERE name = ${marker}`))
        .rows as unknown as Array<{ n: number }>
      return rows[0]!.n
    })

    expect(inA).toBe(1)
    expect(inB).toBe(0)
  }, 60_000)

  it('the second provision of an already-seeded workspace is a no-op', async () => {
    const before = await withWorkspaceDb(A, async () => {
      const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM workouts`))
        .rows as unknown as Array<{ n: number }>
      return rows[0]!.n
    })
    forgetProvisioned(A) // simulate a process restart
    await ensureProvisioned(A)
    const after = await withWorkspaceDb(A, async () => {
      const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM workouts`))
        .rows as unknown as Array<{ n: number }>
      return rows[0]!.n
    })
    expect(after).toBe(before)
  }, 60_000)
})
