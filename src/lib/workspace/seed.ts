/**
 * Demo-workspace seeding: the fictional athlete "Sam" + the full exercise
 * catalog, written as raw SQL against whatever connection the caller hands
 * in. This module intentionally has NO dependency on `src/lib/db/client.ts`
 * (the app-wide singleton) or on `src/lib/db/schema.ts` (drizzle table
 * objects) — every visitor gets their own Postgres schema, and this file
 * must work against ANY of them, not just the default one a global pool
 * happens to be pointed at. All writes go through the `db`/`tx` argument the
 * caller supplies via `db.execute(sql\`...\`)`.
 *
 * PRECONDITION: the caller has already run `ensureGymSchema()` +
 * `ensureAppSettingsSchema()` against the SAME connection/schema this `db`
 * targets, so `exercises`, `workouts`, `workout_sets`, `workout_templates`,
 * `template_exercises`, `template_sets`, `training_plans`,
 * `training_plan_days`, `training_plan_versions`, `gyms`, and `injuries` all
 * already exist with their full gym-lane columns. This module never runs
 * DDL — see `seed/verify.ts` for why that ensure step can't happen in here
 * (it hangs off a different, hard-wired connection).
 *
 * Row shapes mirror exactly what the app itself writes (see
 * `src/lib/gym/active-workout.ts` `executeSetUpsert` / `materializeSetPrescriptions`
 * and `src/lib/gym/finish.ts`): `status='completed'`, `ended_at` set,
 * `completed=true` + `completed_at` stamped on every set, `set_type` is
 * `'warmup'` or `'normal'` (never `'working'` — that value doesn't exist in
 * this schema), `weight_unit='lb'`, real `client_set_id`/`logical_set_id`
 * UUIDs, and `revision=0` on every workout (nothing here ever re-opens a
 * session, so the optimistic-concurrency counter never advances).
 */
import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

// seed/** lives outside src/, so this can't go through the `@/*` alias
// (tsconfig only maps `@/*` to `./src/*`).
import catalog from '../../../seed/catalog.json'
import {
  EXERCISE_NAMES,
  GYM,
  RESOLVED_INJURY,
  TEMPLATES,
  TRAINING_PLAN,
  UNIT,
  WORKOUTS,
  restSecondsFor,
  workoutStartDate,
  type ExerciseKey,
} from '../../../seed/athlete'

/** Minimal shape this module needs — works for the app-wide db AND a
 *  one-off `drizzle(new Pool({ ... }))` a caller builds for a specific
 *  schema. No generic schema parameter required. */
export type SeedDb = NodePgDatabase<Record<string, never>>

interface CatalogRow {
  name: string
  category: string | null
  primary_muscle: string | null
  secondary_muscles: string[]
  equipment: string | null
  force: string | null
  mechanic: string | null
  level: string | null
  instructions: string[]
  images: string[]
  slug: string
  tracks: string
  modality: string
  per_side: boolean
  /** The canonical lower-case catalog name (== src/lib/fitness/exercise-
   *  catalog.json's `name`). This is what goes in `exercises.name` — the
   *  app's name-keyword muscle mapping (lib/fitness/muscles.ts) and
   *  `displayExerciseName()` both expect the raw form, not the title-cased
   *  `name` field this file also carries for convenience. */
  raw_name: string
  /** Added by a sibling agent after this task started; present on every row
   *  as of this writing, but read defensively in case a future catalog
   *  refresh drops it for some rows. */
  injury_profile?: unknown
}

const CATALOG = catalog as unknown as CatalogRow[]

const CATALOG_BATCH_SIZE = 200

/** Round to the nearest 5 (never below 5) — used for warmup weights. */
function warmupWeight(workingWeight: number): number {
  return Math.max(5, Math.round((workingWeight * 0.5) / 5) * 5)
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

async function insertCatalog(tx: SeedDb): Promise<void> {
  for (let start = 0; start < CATALOG.length; start += CATALOG_BATCH_SIZE) {
    const batch = CATALOG.slice(start, start + CATALOG_BATCH_SIZE)
    const rows = batch.map(
      (row) => sql`(
        ${row.raw_name},
        ${row.category},
        ${row.primary_muscle},
        ${JSON.stringify(row.secondary_muscles ?? [])}::jsonb,
        ${row.equipment},
        ${row.force},
        ${row.mechanic},
        ${row.level},
        ${JSON.stringify(row.instructions ?? [])}::jsonb,
        ${JSON.stringify(row.images ?? [])}::jsonb,
        ${row.slug},
        ${row.tracks},
        ${row.modality},
        ${row.per_side},
        'total',
        false,
        ${row.injury_profile != null ? JSON.stringify(row.injury_profile) : null}::jsonb
      )`,
    )
    await tx.execute(sql`
      INSERT INTO exercises (
        name, category, primary_muscle, secondary_muscles, equipment, force, mechanic, level,
        instructions, images, catalog_slug, tracks, modality, per_side, load_basis, is_custom,
        injury_profile
      ) VALUES ${sql.join(rows, sql`, `)}
      ON CONFLICT (name) DO NOTHING
    `)
  }
}

/** Resolve every athlete exercise name to its catalog-row id. Throws (loudly,
 *  by name) if any name in seed/athlete.ts doesn't exist in the catalog —
 *  that's a seed-data bug, not a runtime condition to swallow. */
async function resolveExerciseIds(tx: SeedDb): Promise<Record<ExerciseKey, string>> {
  const keys = Object.keys(EXERCISE_NAMES) as ExerciseKey[]
  const names = keys.map((k) => EXERCISE_NAMES[k])
  const rows = (
    await tx.execute(sql`
      SELECT id, name FROM exercises
      WHERE name IN (${sql.join(
        names.map((n) => sql`${n}`),
        sql`, `,
      )})
    `)
  ).rows as unknown as Array<{ id: string; name: string }>
  const byName = new Map(rows.map((r) => [r.name, r.id]))
  const out = {} as Record<ExerciseKey, string>
  for (const key of keys) {
    const name = EXERCISE_NAMES[key]
    const id = byName.get(name)
    if (!id) {
      throw new Error(
        `seed/athlete.ts exercise key "${key}" (name "${name}") was not found in the seeded catalog`,
      )
    }
    out[key] = id
  }
  return out
}

// ---------------------------------------------------------------------------
// Gym
// ---------------------------------------------------------------------------

async function insertGym(tx: SeedDb): Promise<string> {
  const equipment = JSON.stringify(GYM.equipment)
  const [row] = (
    await tx.execute(sql`
      INSERT INTO gyms (name, equipment, notes, is_default)
      VALUES (${GYM.name}, ${equipment}::jsonb, ${GYM.notes}, true)
      RETURNING id
    `)
  ).rows as unknown as Array<{ id: string }>
  return row!.id
}

// ---------------------------------------------------------------------------
// Templates (+ template_exercises + template_sets)
// ---------------------------------------------------------------------------

type TemplateKey = keyof typeof TEMPLATES

/** Most recent (smallest daysAgo) working weight/reps logged for an exercise,
 *  across the whole seeded history — what a template's scalar target_* columns
 *  and template_sets rows should show as "current". */
function latestPrescription(key: ExerciseKey): { weight: number; reps: number } {
  const sorted = [...WORKOUTS].sort((a, b) => a.daysAgo - b.daysAgo)
  for (const workout of sorted) {
    const entry = workout.exercises.find((e) => e.key === key)
    if (entry && entry.sets.length > 0) {
      const last = entry.sets[entry.sets.length - 1]!
      return { weight: last.weight, reps: last.reps }
    }
  }
  throw new Error(`seed/athlete.ts: no logged history for exercise key "${key}"`)
}

async function insertTemplates(
  tx: SeedDb,
  exerciseIds: Record<ExerciseKey, string>,
): Promise<Record<TemplateKey, string>> {
  const templateIds = {} as Record<TemplateKey, string>
  let position = 0
  for (const templateKey of Object.keys(TEMPLATES) as TemplateKey[]) {
    const spec = TEMPLATES[templateKey]
    const [templateRow] = (
      await tx.execute(sql`
        INSERT INTO workout_templates (name, position, source)
        VALUES (${spec.name}, ${position}, 'user')
        RETURNING id
      `)
    ).rows as unknown as Array<{ id: string }>
    const templateId = templateRow!.id
    templateIds[templateKey] = templateId
    position += 1

    for (let exPos = 0; exPos < spec.exercises.length; exPos += 1) {
      const exSpec = spec.exercises[exPos]!
      const exerciseId = exerciseIds[exSpec.key]
      const { weight, reps } = latestPrescription(exSpec.key)
      const restSeconds = restSecondsFor(exSpec.key)
      const progression = exSpec.progression ? JSON.stringify(exSpec.progression) : null

      const [teRow] = (
        await tx.execute(sql`
          INSERT INTO template_exercises (
            template_id, exercise_id, position, target_sets, target_reps,
            rest_seconds, target_weight, target_weight_unit, progression
          ) VALUES (
            ${templateId}, ${exerciseId}, ${exPos}, ${exSpec.targetSets}, ${exSpec.targetReps},
            ${restSeconds}, ${weight}, ${UNIT}, ${progression}::jsonb
          )
          RETURNING id
        `)
      ).rows as unknown as Array<{ id: string }>
      const templateExerciseId = teRow!.id

      let setNumber = 1
      if (exPos === 0) {
        const warmup = warmupWeight(weight)
        for (const warmupReps of [10, 8]) {
          await tx.execute(sql`
            INSERT INTO template_sets (
              template_exercise_id, set_number, set_type, target_weight,
              target_weight_unit, target_reps, rest_seconds
            ) VALUES (
              ${templateExerciseId}, ${setNumber}, 'warmup', ${warmup}, ${UNIT}, ${warmupReps}, 90
            )
          `)
          setNumber += 1
        }
      }
      for (let s = 0; s < exSpec.targetSets; s += 1) {
        await tx.execute(sql`
          INSERT INTO template_sets (
            template_exercise_id, set_number, set_type, target_weight,
            target_weight_unit, target_reps, rest_seconds
          ) VALUES (
            ${templateExerciseId}, ${setNumber}, 'normal', ${weight}, ${UNIT}, ${reps}, ${restSeconds}
          )
        `)
        setNumber += 1
      }
    }
  }
  return templateIds
}

// ---------------------------------------------------------------------------
// Workouts (+ workout_exercises + workout_sets)
// ---------------------------------------------------------------------------

async function insertWorkouts(
  tx: SeedDb,
  exerciseIds: Record<ExerciseKey, string>,
  templateIds: Record<TemplateKey, string>,
  gymId: string,
  now: Date,
): Promise<void> {
  for (const workout of WORKOUTS) {
    const startedAt = workoutStartDate(now, workout.daysAgo, workout.startHour)
    const endedAt = new Date(startedAt.getTime() + workout.durationMinutes * 60_000)
    const templateId = workout.templateKey ? templateIds[workout.templateKey] : null

    const [workoutRow] = (
      await tx.execute(sql`
        INSERT INTO workouts (
          name, template_id, started_at, ended_at, duration_seconds,
          status, source, revision, gym_id
        ) VALUES (
          ${workout.name}, ${templateId}, ${startedAt.toISOString()}, ${endedAt.toISOString()},
          ${workout.durationMinutes * 60}, 'completed', 'app', 0, ${gymId}
        )
        RETURNING id
      `)
    ).rows as unknown as Array<{ id: string }>
    const workoutId = workoutRow!.id

    // Total set count, for spreading completed_at across the session.
    const totalSets = workout.exercises.reduce(
      (sum, ex, idx) => sum + ex.sets.length + (idx === 0 ? 2 : 0),
      0,
    )
    const spanMs = endedAt.getTime() - startedAt.getTime()
    let setCursor = 0

    for (let exPos = 0; exPos < workout.exercises.length; exPos += 1) {
      const exLog = workout.exercises[exPos]!
      const exerciseId = exerciseIds[exLog.key]
      const restSeconds = restSecondsFor(exLog.key)

      const [weRow] = (
        await tx.execute(sql`
          INSERT INTO workout_exercises (workout_id, exercise_id, position, section)
          VALUES (${workoutId}, ${exerciseId}, ${exPos}, 'main')
          RETURNING id
        `)
      ).rows as unknown as Array<{ id: string }>
      const workoutExerciseId = weRow!.id

      const rows: Array<{ setType: 'warmup' | 'normal'; weight: number; reps: number }> = []
      if (exPos === 0) {
        const firstWeight = exLog.sets[0]!.weight
        const warmup = warmupWeight(firstWeight)
        rows.push({ setType: 'warmup', weight: warmup, reps: 10 })
        rows.push({ setType: 'warmup', weight: warmup, reps: 8 })
      }
      for (const s of exLog.sets) rows.push({ setType: 'normal', weight: s.weight, reps: s.reps })

      for (let setNumber = 1; setNumber <= rows.length; setNumber += 1) {
        const row = rows[setNumber - 1]!
        setCursor += 1
        const completedAt = new Date(
          startedAt.getTime() + Math.round((setCursor / totalSets) * spanMs),
        )
        await tx.execute(sql`
          INSERT INTO workout_sets (
            workout_exercise_id, set_number, set_type, weight, weight_unit, reps,
            rest_seconds, completed, completed_at, client_set_id, logical_set_id
          ) VALUES (
            ${workoutExerciseId}, ${setNumber}, ${row.setType}, ${row.weight}, ${UNIT}, ${row.reps},
            ${restSeconds}, true, ${completedAt.toISOString()}, gen_random_uuid(), gen_random_uuid()
          )
        `)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Training plan
// ---------------------------------------------------------------------------

async function insertTrainingPlan(tx: SeedDb, templateIds: Record<TemplateKey, string>): Promise<void> {
  const policy = JSON.stringify(TRAINING_PLAN.policy)
  const [planRow] = (
    await tx.execute(sql`
      INSERT INTO training_plans (name, goal, status, schedule_mode, policy, version)
      VALUES (
        ${TRAINING_PLAN.name}, ${TRAINING_PLAN.goal}, 'active', ${TRAINING_PLAN.scheduleMode},
        ${policy}::jsonb, 1
      )
      RETURNING id
    `)
  ).rows as unknown as Array<{ id: string }>
  const planId = planRow!.id

  for (let position = 0; position < TRAINING_PLAN.days.length; position += 1) {
    const day = TRAINING_PLAN.days[position]!
    const templateId = templateIds[day.templateKey]
    await tx.execute(sql`
      INSERT INTO training_plan_days (plan_id, position, name, template_id, weekday)
      VALUES (${planId}, ${position}, ${day.name}, ${templateId}, ${day.weekday})
    `)
  }

  const snapshot = JSON.stringify({ ...TRAINING_PLAN, days: undefined, policy: TRAINING_PLAN.policy })
  await tx.execute(sql`
    INSERT INTO training_plan_versions (plan_id, version, snapshot, actor, reason)
    VALUES (${planId}, 1, ${snapshot}::jsonb, 'seed', 'created')
  `)
}

// ---------------------------------------------------------------------------
// Injury
// ---------------------------------------------------------------------------

async function insertInjury(tx: SeedDb, now: Date): Promise<void> {
  const startedAt = new Date(now.getTime() - RESOLVED_INJURY.startedDaysAgo * 86_400_000)
  const resolvedAt = new Date(now.getTime() - RESOLVED_INJURY.resolvedDaysAgo * 86_400_000)
  await tx.execute(sql`
    INSERT INTO injuries (region, label, note, severity, started_at, resolved_at, updated_at)
    VALUES (
      ${RESOLVED_INJURY.region}, ${RESOLVED_INJURY.label}, ${RESOLVED_INJURY.note},
      ${RESOLVED_INJURY.severity}, ${startedAt.toISOString()}, ${resolvedAt.toISOString()},
      ${resolvedAt.toISOString()}
    )
  `)
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

async function insertAthleteData(tx: SeedDb, now: Date): Promise<void> {
  const exerciseIds = await resolveExerciseIds(tx)
  const gymId = await insertGym(tx)
  const templateIds = await insertTemplates(tx, exerciseIds)
  await insertWorkouts(tx, exerciseIds, templateIds, gymId, now)
  await insertTrainingPlan(tx, templateIds)
  await insertInjury(tx, now)
}

/**
 * Seed a freshly provisioned workspace: the full exercise catalog, then the
 * fictional athlete's gym/templates/plan/history/injury, resolving every
 * exercise reference by name. Idempotent — if the workspace already has any
 * workout, this is a no-op (it assumes a prior seed already ran). One
 * transaction: either the whole workspace is seeded or none of it is.
 *
 * The caller is responsible for having already run `ensureGymSchema()` +
 * `ensureAppSettingsSchema()` against this same `db`'s target schema.
 */
export async function seedWorkspace(
  db: SeedDb,
  opts: { now?: Date } = {},
): Promise<{ seeded: boolean }> {
  const now = opts.now ?? new Date()
  return db.transaction(async (tx) => {
    const existing = (await tx.execute(sql`SELECT 1 FROM workouts LIMIT 1`)).rows as unknown[]
    if (existing.length > 0) return { seeded: false }
    await insertCatalog(tx as unknown as SeedDb)
    await insertAthleteData(tx as unknown as SeedDb, now)
    return { seeded: true }
  })
}

/** Tables that carry the athlete's data (history, templates, plan, gym,
 *  injuries) — everything EXCEPT the shared exercise catalog. Listed together
 *  so one TRUNCATE clears every dependent row regardless of FK order. */
const ATHLETE_TABLES: SQL = sql.raw(
  [
    'workout_sets',
    'workout_exercises',
    'workouts',
    'template_sets',
    'template_exercises',
    'workout_templates',
    'training_plan_sessions',
    'training_plan_versions',
    'training_plan_days',
    'training_plans',
    'workout_proposals',
    'exercise_load_corrections',
    'injuries',
    'gyms',
  ].join(', '),
)

/**
 * Wipe the athlete's data (NOT the catalog — `exercises` is left alone) and
 * re-seed from scratch. Same schema precondition as `seedWorkspace`.
 */
export async function resetWorkspace(db: SeedDb, opts: { now?: Date } = {}): Promise<void> {
  const now = opts.now ?? new Date()
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE ${ATHLETE_TABLES} RESTART IDENTITY CASCADE`)
    await insertAthleteData(tx as unknown as SeedDb, now)
  })
}
