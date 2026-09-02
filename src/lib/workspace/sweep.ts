/**
 * Dropping abandoned workspaces.
 *
 * Every visitor's schema is real Postgres storage (~1300 catalog rows plus the
 * seeded demo history), so a public demo accumulates them. A workspace nobody
 * has touched in `olderThanDays` is dropped whole — schema and registry row.
 *
 * Default 14 days, generous on purpose: judging runs for about three weeks and
 * a judge who comes back to their bookmark must find their data, not a fresh
 * demo athlete.
 *
 * `last_seen_at` is written by `provision.ts`'s throttled heartbeat, so it
 * tracks real use, not merely provisioning.
 */
import { sql } from 'drizzle-orm'

import { closeWorkspacePool, unscopedDb } from '@/lib/db/client'

import { isWorkspaceId, schemaNameFor } from './ids'
import { ensureWorkspaceRegistry, forgetProvisioned } from './provision'

export interface SweepResult {
  /** Workspace ids whose schema and registry row are gone. */
  dropped: string[]
  /** Ids that were selected but failed to drop (logged, not thrown). */
  failed: string[]
}

export async function dropStaleWorkspaces(olderThanDays = 14): Promise<SweepResult> {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    throw new Error(`[workspace] dropStaleWorkspaces: olderThanDays must be >= 1, got ${olderThanDays}`)
  }
  await ensureWorkspaceRegistry()

  const rows = (
    await unscopedDb().execute(sql`
      SELECT id::text AS id FROM public.workspaces
      WHERE last_seen_at < now() - make_interval(days => ${Math.floor(olderThanDays)})
      ORDER BY last_seen_at ASC
    `)
  ).rows as unknown as Array<{ id: string }>

  const dropped: string[] = []
  const failed: string[] = []

  for (const row of rows) {
    if (!isWorkspaceId(row.id)) {
      // Can't happen through the app (the column is uuid), but a hand-inserted
      // row must never reach schemaNameFor's interpolation.
      failed.push(row.id)
      continue
    }
    try {
      // Close the pool FIRST: dropping a schema its connections still have on
      // their search_path leaves them pointing at nothing.
      await closeWorkspacePool(row.id)
      forgetProvisioned(row.id)
      await unscopedDb().execute(
        sql`DROP SCHEMA IF EXISTS ${sql.identifier(schemaNameFor(row.id))} CASCADE`,
      )
      await unscopedDb().execute(sql`DELETE FROM public.workspaces WHERE id = ${row.id}::uuid`)
      dropped.push(row.id)
    } catch (err) {
      console.error(
        `[workspace] failed to drop ${row.id}:`,
        err instanceof Error ? err.message : err,
      )
      failed.push(row.id)
    }
  }

  return { dropped, failed }
}
