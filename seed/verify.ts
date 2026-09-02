/**
 * Live verification for `seedWorkspace()`, exercised through the REAL
 * provisioning path a browser visit triggers. Run with:
 *   pnpm tsx seed/verify.ts
 *
 * Provisions one throwaway workspace via `ensureProvisioned()`
 * (src/lib/workspace/provision.ts — the same function `@/lib/db/client`'s
 * `db` proxy calls on first touch for every real visitor), asserts the
 * seeded shape/story on prod-shaped rows, then drops the schema whether or
 * not the assertions passed.
 *
 * ── A bug this script found and no longer needs to work around ──────────
 * Earlier in this task, `ensureProvisioned()` reliably threw on a fresh
 * workspace: `ensureAppSettingsSchema()` was pure `ALTER TABLE app_settings
 * ADD COLUMN ...` with nothing creating the table first, and
 * `ensureGymSchema()` unconditionally created `gym_habit_log_links` with `FK
 * REFERENCES habits(id)` / `habit_log(id)` — two tables that don't exist
 * anywhere in this repo (`src/lib/habits.ts`'s header: "Habits are not part
 * of this app"). Both were fixed concurrently by another agent while this
 * task was in flight (ensure-app-settings.ts now creates `app_settings`
 * itself; ensure-fitness.ts's `gym_habit_log_links` no longer carries those
 * FKs) — see git history on src/lib/db/ensure-app-settings.ts and
 * ensure-fitness.ts around the same time as this file. That same pass also
 * fixed a second bug this task had flagged for the record: both ensures used
 * to memoize their "already ran" promise at MODULE scope, so in the
 * multi-workspace design only the FIRST workspace touched in a given server
 * process ever actually got its schema built — every later workspace in
 * that process would have silently skipped all the DDL. Both files now key
 * their memoization by workspace id. Nothing below needs to route around
 * either issue anymore; `ensureProvisioned()` is called plainly.
 */
import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'

import { unscopedDb, workspaceDrizzle } from '../src/lib/db/client'
import { runWithWorkspace, schemaNameFor } from '../src/lib/workspace/context'
import { ensureProvisioned } from '../src/lib/workspace/provision'
import { seedWorkspace } from '../src/lib/workspace/seed'
import { computeRecords, type SetInput } from '../src/lib/gym/records'
import { EXERCISE_NAMES, WORKOUTS } from './athlete'

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile('.env.local')
  } catch {
    // fall through — rely on whatever the ambient environment already has.
  }
}

let failures = 0
function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`)
  } else {
    failures += 1
    console.error(`  FAIL ${message}`)
  }
}

async function main(): Promise<void> {
  const id = randomUUID()
  const schema = schemaNameFor(id)
  console.log(`[verify] workspace ${id} -> schema "${schema}"`)

  console.log('[verify] ensureProvisioned() — schema + ensureGymSchema/ensureAppSettingsSchema + seedWorkspace')
  await ensureProvisioned(id)
  const wsDb = workspaceDrizzle(id)

  // `ensureProvisioned()` already calls `seedWorkspace()` once (that's the
  // real flow). Call it again directly to prove idempotency independent of
  // the provisioning wrapper, and once more via `resetWorkspace`-adjacent
  // re-seed is intentionally NOT exercised here — that's a distinct code
  // path (`resetWorkspace`) with its own truncate-then-reseed contract.
  const now = new Date()
  const again = await seedWorkspace(wsDb, { now })
  assert(again.seeded === false, 'seedWorkspace() is a no-op once the workspace is already seeded')

  console.log('[verify] assertions')

  // 1. 18 completed workouts.
  const workoutCountRows = (
    await wsDb.execute(sql`SELECT count(*)::int AS n FROM workouts WHERE status = 'completed'`)
  ).rows as unknown as Array<{ n: number }>
  assert(workoutCountRows[0]?.n === 18, `18 completed workouts (got ${workoutCountRows[0]?.n})`)

  // 2. Incline DB press top-set sequence, oldest to newest.
  const inclineRows = (
    await wsDb.execute(sql`
      SELECT w.started_at::text AS started_at, ws.set_number, ws.weight::float AS weight, ws.reps
      FROM workout_sets ws
      JOIN workout_exercises we ON ws.workout_exercise_id = we.id
      JOIN workouts w ON we.workout_id = w.id
      JOIN exercises e ON we.exercise_id = e.id
      WHERE e.name = ${EXERCISE_NAMES.inclineBench}
        AND ws.set_type = 'normal'
        AND w.status = 'completed'
      ORDER BY w.started_at ASC, ws.set_number ASC
    `)
  ).rows as unknown as Array<{ started_at: string; set_number: number; weight: number; reps: number }>

  const bySession = new Map<string, Array<{ weight: number; reps: number }>>()
  for (const row of inclineRows) {
    const list = bySession.get(row.started_at) ?? []
    list.push({ weight: row.weight, reps: row.reps })
    bySession.set(row.started_at, list)
  }
  const sessions = [...bySession.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, s]) => s)
  const expected = [
    { weight: 65, reps: [10, 10, 9] },
    { weight: 70, reps: [9, 9, 8] },
    { weight: 70, reps: [10, 10, 9] },
    { weight: 75, reps: [8, 8, 8] },
    { weight: 75, reps: [9, 9, 8] },
    { weight: 75, reps: [10, 10, 10] },
  ]
  assert(sessions.length === 6, `incline press appears in exactly 6 sessions (got ${sessions.length})`)
  const sequenceMatches =
    sessions.length === expected.length &&
    sessions.every(
      (s, i) =>
        s.length === expected[i]!.reps.length &&
        s.every((set, j) => set.weight === expected[i]!.weight && set.reps === expected[i]!.reps[j]),
    )
  assert(
    sequenceMatches,
    `incline press progression matches 65x10,10,9 -> 70x9,9,8 -> 70x10,10,9 -> 75x8,8,8 -> 75x9,9,8 -> 75x10,10,10 (got ${JSON.stringify(sessions)})`,
  )

  // 3. Muscle map: readiness spread across >=8 trained regions, with the
  // specific story the seed was built to demonstrate. `buildMuscleMap` reads
  // through the workspace-scoped `db` proxy (not `wsDb`), so it must run
  // inside `runWithWorkspace` to resolve to this workspace.
  const map = await runWithWorkspace(id, async () => {
    const { buildMuscleMap } = await import('../src/lib/fitness/muscle-map')
    return buildMuscleMap(now)
  })
  const trainedRegions = Object.values(map.regions).filter((r) => r.state !== 'untrained')
  assert(
    trainedRegions.length >= 8,
    `muscle map has data for >=8 regions (got ${trainedRegions.length}: ${trainedRegions.map((r) => r.region).join(', ')})`,
  )
  assert(
    map.regions.hamstrings.state === 'undertrained',
    `hamstrings read 'undertrained' (got '${map.regions.hamstrings.state}', daysSince=${map.regions.hamstrings.daysSince})`,
  )
  assert(
    map.regions.calves.state === 'undertrained',
    `calves read 'undertrained' (got '${map.regions.calves.state}', daysSince=${map.regions.calves.daysSince})`,
  )
  assert(
    map.regions.chest.daysSince !== null && map.regions.chest.daysSince <= 2,
    `chest was trained yesterday (daysSince=${map.regions.chest.daysSince})`,
  )
  assert(
    map.regions.triceps.daysSince !== null && map.regions.triceps.daysSince <= 2,
    `triceps was trained yesterday (daysSince=${map.regions.triceps.daysSince})`,
  )
  assert(
    map.regions.mid_back.daysSince !== null && map.regions.mid_back.daysSince >= 5,
    `back (mid_back) hasn't been hit in 5+ days (daysSince=${map.regions.mid_back.daysSince})`,
  )

  // 4. Records exist and reflect the logged history.
  const rawSets = (
    await wsDb.execute(sql`
      SELECT w.started_at::text AS date, ws.weight::float AS weight, ws.reps, ws.set_type
      FROM workout_sets ws
      JOIN workout_exercises we ON ws.workout_exercise_id = we.id
      JOIN workouts w ON we.workout_id = w.id
      JOIN exercises e ON we.exercise_id = e.id
      WHERE e.name = ${EXERCISE_NAMES.inclineBench} AND w.status = 'completed'
      ORDER BY w.started_at ASC, ws.set_number ASC
    `)
  ).rows as unknown as Array<{ date: string; weight: number; reps: number; set_type: string }>
  const setInputs: SetInput[] = rawSets.map((r) => ({
    setType: r.set_type as SetInput['setType'],
    weight: r.weight,
    unit: 'lb',
    reps: r.reps,
    distanceM: null,
    durationS: null,
    loadBasis: 'total',
    side: null,
    date: r.date.slice(0, 10),
  }))
  const records = computeRecords(setInputs, 'weight_reps')
  assert(records.bestWeight?.value === 75, `incline press bestWeight is 75 (got ${records.bestWeight?.value})`)
  assert(records.bestE1rm != null, 'incline press has a computed e1RM record')

  // 5. Templates, plan, and the resolved-only injury exist.
  const templateRows = (
    await wsDb.execute(sql`SELECT name FROM workout_templates ORDER BY position`)
  ).rows as unknown as Array<{ name: string }>
  assert(
    templateRows.map((r) => r.name).join(',') === 'Upper A,Lower A',
    `templates are exactly Upper A, Lower A (got ${templateRows.map((r) => r.name).join(', ')})`,
  )
  const planRows = (
    await wsDb.execute(sql`SELECT count(*)::int AS n FROM training_plans WHERE name = 'Base Block'`)
  ).rows as unknown as Array<{ n: number }>
  assert(planRows[0]?.n === 1, "'Base Block' training plan exists")
  const activeInjuryRows = (
    await wsDb.execute(sql`SELECT count(*)::int AS n FROM injuries WHERE resolved_at IS NULL OR resolved_at > now()`)
  ).rows as unknown as Array<{ n: number }>
  assert(activeInjuryRows[0]?.n === 0, 'no active injuries (the seeded one is resolved)')
  const resolvedInjuryRows = (
    await wsDb.execute(sql`SELECT count(*)::int AS n FROM injuries WHERE resolved_at IS NOT NULL`)
  ).rows as unknown as Array<{ n: number }>
  assert(resolvedInjuryRows[0]?.n === 1, 'exactly one resolved injury exists')

  // 6. Full catalog landed.
  const catalogRows = (await wsDb.execute(sql`SELECT count(*)::int AS n FROM exercises`))
    .rows as unknown as Array<{ n: number }>
  assert(catalogRows[0]?.n === 1318, `all 1318 catalog exercises inserted (got ${catalogRows[0]?.n})`)
  const totalWorkoutExercises = WORKOUTS.reduce((n, w) => n + w.exercises.length, 0)
  console.log(`[verify] (info) athlete data touches ${totalWorkoutExercises} workout_exercise rows across 18 sessions`)

  // ── Cleanup ──────────────────────────────────────────────────────────
  await unscopedDb().execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`)
  await unscopedDb().execute(sql`DELETE FROM public.workspaces WHERE id = ${id}::uuid`)

  if (failures > 0) {
    console.error(`\n[verify] ${failures} assertion(s) FAILED`)
    process.exitCode = 1
  } else {
    console.log('\n[verify] all assertions passed')
  }
}

main()
  .catch((err) => {
    console.error('[verify] crashed:', err)
    process.exitCode = 1
  })
  .finally(() => {
    // Per-workspace pg pools (workspaceDrizzle) and the unscoped pool have no
    // natural end-of-script signal — force the process to exit rather than
    // hang on open sockets.
    process.exit(process.exitCode ?? 0)
  })
