import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { ensureAppSettingsSchema } from '@/lib/db/ensure-app-settings'
import { currentWorkspaceKey, deferToProvisioner } from '@/lib/workspace/context'

/**
 * Runtime safety net for the fitness tables (strength log — 2026-06-25).
 *
 * Postgres only runs `init.sql` on a cold data volume, never on subsequent
 * container starts, so the long-running prod DB needs these created lazily —
 * same pattern as `ensure-person-resolution.ts` / `ensureRemindersTable`.
 * Idempotent `CREATE TABLE IF NOT EXISTS`, run once per process the first time
 * the fitness store is touched. Purely additive: creates new tables only.
 *
 * Mirrors the drizzle defs in schema.ts (exercises, workout_templates,
 * template_exercises, workouts, workout_exercises, workout_sets,
 * body_measurements). Created in FK-dependency order. `import_key` UNIQUE
 * indexes give the CSV importers idempotency — Postgres treats NULLs as
 * distinct, so app-created rows (null key) never collide while a re-import
 * upserts by its deterministic key.
 */
// Keyed by workspace id, NOT a single module-level promise: every visitor
// gets their own Postgres schema, so a process-wide memo would run this DDL
// in the first workspace only and leave every later one without tables.
const ensurePromises = new Map<string, Promise<void>>()

export async function ensureFitnessTables(): Promise<void> {
  if (await deferToProvisioner()) return
  const key = await currentWorkspaceKey()
  let ensurePromise = ensurePromises.get(key)
  if (!ensurePromise) {
    ensurePromise = (async () => {
      // Catalog + templates first (no FKs).
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS exercises (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL UNIQUE,
          category TEXT,
          primary_muscle TEXT,
          tracks TEXT NOT NULL DEFAULT 'weight_reps',
          load_basis TEXT NOT NULL DEFAULT 'total' CHECK (load_basis IN ('total','per_side')),
          is_custom BOOLEAN NOT NULL DEFAULT false,
          tracked_at TIMESTAMPTZ,
          archived_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS exercise_load_corrections (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          exercise_id UUID NOT NULL REFERENCES exercises(id),
          source TEXT NOT NULL DEFAULT 'strong-import',
          start_date DATE,
          end_date DATE,
          divisor NUMERIC NOT NULL
            CONSTRAINT exercise_load_corrections_divisor_check CHECK (divisor > 0),
          previous_load_basis TEXT NOT NULL DEFAULT 'total'
            CONSTRAINT exercise_load_corrections_previous_basis_check
            CHECK (previous_load_basis IN ('total','per_side')),
          reason TEXT,
          active BOOLEAN NOT NULL DEFAULT true,
          affected_sets INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          reverted_at TIMESTAMPTZ
        )
      `)
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_exercise_load_corrections_exercise_active
        ON exercise_load_corrections(exercise_id, active)
      `)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS workout_templates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          notes TEXT,
          position INTEGER NOT NULL DEFAULT 0,
          programming_policy JSONB,
          archived_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS template_exercises (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          template_id UUID NOT NULL REFERENCES workout_templates(id) ON DELETE CASCADE,
          exercise_id UUID NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
          position INTEGER NOT NULL DEFAULT 0,
          target_sets INTEGER,
          target_reps INTEGER,
          rest_seconds INTEGER,
          notes TEXT
        )
      `)
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_template_exercise_slot ON template_exercises(template_id, position)`,
      )
      // Sessions.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS workouts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT,
          template_id UUID REFERENCES workout_templates(id) ON DELETE SET NULL,
          started_at TIMESTAMPTZ NOT NULL,
          ended_at TIMESTAMPTZ,
          duration_seconds INTEGER,
          notes TEXT,
          source TEXT NOT NULL DEFAULT 'app',
          revision INTEGER NOT NULL DEFAULT 0,
          import_key TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_workout_import_key ON workouts(import_key)`,
      )
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS idx_workouts_started_at ON workouts(started_at)`,
      )
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS workout_exercises (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workout_id UUID NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
          exercise_id UUID NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
          position INTEGER NOT NULL DEFAULT 0,
          notes TEXT
        )
      `)
      // NON-unique: the same exercise may appear more than once in a workout
      // (e.g. curls at the start and again at the end). Instances are distinct
      // workout_exercises rows ordered by position.
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS idx_workout_exercise ON workout_exercises(workout_id, exercise_id)`,
      )
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS workout_sets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workout_exercise_id UUID NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
          set_number INTEGER NOT NULL,
          set_type TEXT NOT NULL DEFAULT 'normal',
          weight NUMERIC,
          weight_unit TEXT NOT NULL DEFAULT 'lb',
          reps INTEGER,
          distance_m NUMERIC,
          duration_s INTEGER,
          rpe NUMERIC,
          logical_set_id UUID NOT NULL DEFAULT gen_random_uuid(),
          source_weight NUMERIC,
          load_correction_id UUID REFERENCES exercise_load_corrections(id),
          completed BOOLEAN NOT NULL DEFAULT true,
          import_key TEXT,
          client_set_id UUID NOT NULL DEFAULT gen_random_uuid(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_workout_set_import_key ON workout_sets(import_key)`,
      )
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS idx_workout_sets_we ON workout_sets(workout_exercise_id)`,
      )
      // Indexes for logical_set_id/load_correction_id belong in
      // ensureGymSchema(), after its warm-volume ALTERs add those columns.
      // Creating them here breaks every pre-feature database because
      // CREATE TABLE IF NOT EXISTS is a no-op for the existing workout_sets.
      // Body metrics (no FK; long-format).
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS body_measurements (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          measured_at DATE NOT NULL,
          metric TEXT NOT NULL,
          value NUMERIC NOT NULL,
          unit TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'app',
          notes TEXT,
          import_key TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_body_measurement_import_key ON body_measurements(import_key)`,
      )
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS idx_body_measurements_metric ON body_measurements(metric, measured_at)`,
      )
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS body_progress_photos (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          session_id UUID NOT NULL,
          measured_at DATE NOT NULL,
          pose TEXT NOT NULL CHECK (pose IN ('front', 'side', 'back')),
          mime_type TEXT NOT NULL,
          content BYTEA NOT NULL,
          source TEXT NOT NULL DEFAULT 'manual',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (session_id, pose)
        )
      `)
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS idx_body_progress_photos_date ON body_progress_photos(measured_at DESC, created_at DESC)`,
      )
    })().catch((err) => {
      ensurePromises.delete(key)
      throw err
    })
    ensurePromises.set(key, ensurePromise)
  }
  await ensurePromise
}

/**
 * Additive migration for the `exercises.tracked_at` column (the explicit
 * "track this exercise" flag, 2026-07-03). The prod `exercises` table predates
 * the column, and `ensureFitnessTables` uses CREATE TABLE IF NOT EXISTS (a no-op
 * on an existing table), so a live ALTER is needed. Idempotent + run once per
 * process the first time a catalog surface is touched — same pattern as the base
 * ensure. Purely additive (nullable column, no backfill).
 */
// Keyed by workspace id, NOT a single module-level promise: every visitor
// gets their own Postgres schema, so a process-wide memo would run this DDL
// in the first workspace only and leave every later one without tables.
const trackingColumnPromises = new Map<string, Promise<void>>()

export async function ensureExerciseTrackingColumn(): Promise<void> {
  if (await deferToProvisioner()) return
  const key = await currentWorkspaceKey()
  await ensureFitnessTables()
  let trackingColumnPromise = trackingColumnPromises.get(key)
  if (!trackingColumnPromise) {
    trackingColumnPromise = (async () => {
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS tracked_at TIMESTAMPTZ`)
    })().catch((err) => {
      trackingColumnPromises.delete(key)
      throw err
    })
    trackingColumnPromises.set(key, trackingColumnPromise)
  }
  await trackingColumnPromise
}

/**
 * Additive migration for the Gym build (GYM_PLAN §3). Adds the rich-metadata +
 * preference columns to the existing fitness tables, the app_settings gym prefs,
 * three new tables (gyms / injuries / workout_proposals), the active-workout
 * partial index, and the client_set_id upsert index. Same self-heal contract as
 * the base ensure: `ADD COLUMN IF NOT EXISTS` / `CREATE … IF NOT EXISTS` only
 * (never destructive), gated by a module-level promise so it runs once per
 * process on the first gym-surface touch. Awaits `ensureFitnessTables()` first
 * so the tables exist before it alters them. Prod runs runtime DDL, never
 * init.sql (which has no fitness section) — this is the only migration lane.
 */
// Keyed by workspace id, NOT a single module-level promise: every visitor
// gets their own Postgres schema, so a process-wide memo would run this DDL
// in the first workspace only and leave every later one without tables.
const gymSchemaPromises = new Map<string, Promise<void>>()

export async function ensureGymSchema(): Promise<void> {
  if (await deferToProvisioner()) return
  const key = await currentWorkspaceKey()
  await ensureFitnessTables()
  let gymSchemaPromise = gymSchemaPromises.get(key)
  if (!gymSchemaPromise) {
    gymSchemaPromise = (async () => {
      // Every gym route reaches this ensure before reading app_settings. Seed the
      // canonical app-wide unit first so all later gym defaults can mirror it.
      await ensureAppSettingsSchema()
      // exercises: rich FEDB metadata + per-exercise preferences.
      // Per-exercise bypass of the injury gate. The gate is deliberately
      // conservative — a limiting/out injury excludes everything that loads,
      // supports, or articulates the site — which is right by default and wrong
      // for the one movement a physio actually cleared. Without this there was no
      // way to say "this one is fine" short of resolving the injury outright and
      // losing the protection everywhere else.
      await db.execute(
        sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS injury_override BOOLEAN NOT NULL DEFAULT false`,
      )
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS instructions JSONB`)
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS secondary_muscles JSONB`)
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS equipment TEXT`)
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS force TEXT`)
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS mechanic TEXT`)
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS level TEXT`)
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS images JSONB`)
      await db.execute(
        sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS ai_filled BOOLEAN NOT NULL DEFAULT false`,
      )
      await db.execute(
        sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS default_rest_seconds INTEGER`,
      )
      await db.execute(
        sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS rest_seconds_warmup INTEGER`,
      )
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS preferred_unit TEXT`)
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS disliked_at TIMESTAMPTZ`)
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS dislike_reason TEXT`)
      // The explicit-preference counterpart to disliked_at (#1876 "Preference"
      // reason chip) — set when the user replaces an exercise because they prefer the
      // pick, so future drafting/replacement ranking can bias toward it.
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS preferred_at TIMESTAMPTZ`)
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS catalog_slug TEXT`)
      // Temporary staleness cooldown (the "Bored of it" reason chip, GYM_PLAN §4/§6).
      // A soft, self-expiring exclusion: novelty pools skip rows whose snoozed_until
      // is still in the future. Distinct from the hard `disliked_at`.
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ`)
      // Structured anatomical/support demands for the cross-injury recommendation
      // gate. Nullable by design: unknown profiles fail closed under hard injuries.
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS injury_profile JSONB`)
      // Mobility (GYM_PLAN §10b.1/2): programming axis + unilateral flag.
      await db.execute(
        sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS modality TEXT NOT NULL DEFAULT 'strength'`,
      )
      await db.execute(
        sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS per_side BOOLEAN NOT NULL DEFAULT false`,
      )
      // Entered-load convention is explicit per exercise. Existing history keeps
      // the legacy total-load interpretation until a correction changes it.
      await db.execute(sql`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS load_basis TEXT`)
      await db.execute(sql`
        UPDATE exercises SET load_basis = 'total'
        WHERE load_basis IS NULL OR load_basis NOT IN ('total','per_side')
      `)
      await db.execute(sql`ALTER TABLE exercises ALTER COLUMN load_basis SET DEFAULT 'total'`)
      await db.execute(sql`ALTER TABLE exercises ALTER COLUMN load_basis SET NOT NULL`)
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'exercises_load_basis_check'
              AND conrelid = 'exercises'::regclass
          ) THEN
            ALTER TABLE exercises
              ADD CONSTRAINT exercises_load_basis_check
              CHECK (load_basis IN ('total','per_side'));
          END IF;
        END $$
      `)
      await db.execute(
        sql`ALTER TABLE exercise_load_corrections ADD COLUMN IF NOT EXISTS previous_load_basis TEXT NOT NULL DEFAULT 'total'`,
      )
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'exercise_load_corrections_previous_basis_check'
              AND conrelid = 'exercise_load_corrections'::regclass
          ) THEN
            ALTER TABLE exercise_load_corrections
              ADD CONSTRAINT exercise_load_corrections_previous_basis_check
              CHECK (previous_load_basis IN ('total','per_side'));
          END IF;
        END $$
      `)

      // workout_templates: folder + provenance.
      await db.execute(sql`ALTER TABLE workout_templates ADD COLUMN IF NOT EXISTS folder TEXT`)
      await db.execute(
        sql`ALTER TABLE workout_templates ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user'`,
      )
      await db.execute(
        sql`ALTER TABLE workout_templates ADD COLUMN IF NOT EXISTS programming_policy JSONB`,
      )
      // Template-level DEFAULT progression policy (#1790). Progression was only
      // ever authorable per exercise, so "this whole template follows its saved
      // prescriptions" meant editing every weighted row by hand — which is
      // exactly what the user had to do after the Day 1 incident. A plan-level
      // default already existed (TrainingPlanPolicy.progression) but only
      // applies inside a training plan; a bare template start had no layer at
      // all. Resolution order is exercise → template → plan default.
      await db.execute(
        sql`ALTER TABLE workout_templates ADD COLUMN IF NOT EXISTS progression JSONB`,
      )
      // When the template's weights were last authored (#1790 follow-up). An
      // authored weight beats the re-entry ramp because it is the user's deliberate
      // restart load — but only if he authored it AFTER the break. A template
      // written months ago carries pre-layoff weights and is just as stale as
      // the history; without this column there is no way to tell the two apart.
      // Backfills to created_at so existing templates are dated honestly.
      await db.execute(
        sql`ALTER TABLE workouts ADD COLUMN IF NOT EXISTS start_notices JSONB`,
      )
      // Which proposal this session came from (#1857) — so cancelling can
      // re-stage exactly that one and nothing else.
      await db.execute(
        sql`ALTER TABLE workouts ADD COLUMN IF NOT EXISTS proposal_id UUID`,
      )
      // When a set was actually checked off (#1835) — the basis for real
      // pacing. Nullable and never backfilled: history logged before this
      // existed has no honest value, and inventing one would be worse than
      // admitting the gap.
      await db.execute(
        sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`,
      )
      await db.execute(
        sql`ALTER TABLE workout_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
      )
      await db.execute(
        sql`UPDATE workout_templates SET updated_at = created_at WHERE updated_at IS NULL`,
      )

      // template_exercises: superset + ghost targets.
      await db.execute(
        sql`ALTER TABLE template_exercises ADD COLUMN IF NOT EXISTS superset_group INTEGER`,
      )
      await db.execute(
        sql`ALTER TABLE template_exercises ADD COLUMN IF NOT EXISTS target_weight NUMERIC`,
      )
      // Explicit legacy boundary for template targets. Before this column existed,
      // the editor stored the number in the exercise preference and explicitly
      // fell back to pounds when that preference was null. Preserve that exact
      // historical behavior even if the app-wide unit is kg at migration time;
      // only an explicit legacy kg preference can stamp a target as kg. All NEW
      // writes are canonical pounds.
      await db.execute(
        sql`ALTER TABLE template_exercises ADD COLUMN IF NOT EXISTS target_weight_unit TEXT`,
      )
      await db.execute(sql`
        UPDATE template_exercises te
        SET target_weight_unit = CASE
          WHEN e.preferred_unit = 'kg' THEN 'kg'
          ELSE 'lb'
        END
        FROM exercises e
        WHERE te.exercise_id = e.id
          AND te.target_weight_unit IS NULL
      `)
      await db.execute(sql`
        UPDATE template_exercises
        SET target_weight_unit = 'lb'
        WHERE target_weight_unit IS NULL
      `)
      await db.execute(
        sql`ALTER TABLE template_exercises ALTER COLUMN target_weight_unit SET DEFAULT 'lb'`,
      )
      await db.execute(
        sql`ALTER TABLE template_exercises ALTER COLUMN target_weight_unit SET NOT NULL`,
      )
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'template_exercises_target_weight_unit_check'
              AND conrelid = 'template_exercises'::regclass
          ) THEN
            ALTER TABLE template_exercises
              ADD CONSTRAINT template_exercises_target_weight_unit_check
              CHECK (target_weight_unit IN ('lb', 'kg'));
          END IF;
        END $$
      `)
      await db.execute(
        sql`ALTER TABLE template_exercises ADD COLUMN IF NOT EXISTS target_duration_s INTEGER`,
      )
      await db.execute(
        sql`ALTER TABLE template_exercises ADD COLUMN IF NOT EXISTS rest_seconds_warmup INTEGER`,
      )
      // Per-exercise progression policy (GYM_PLAN §2.5) — evaluated by
      // lib/gym/progression.ts; null ⇒ the 'last_time' default.
      await db.execute(
        sql`ALTER TABLE template_exercises ADD COLUMN IF NOT EXISTS progression JSONB`,
      )
      // Block role (GYM_PLAN §10b.3): warmup | main | cooldown.
      await db.execute(
        sql`ALTER TABLE template_exercises ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'main'`,
      )

      // First-class ordered template sets. The scalar target_* columns above
      // remain a legacy/editor summary; new saves also write exact heterogeneous
      // warmup/working/drop/failure rows here (weight/reps/time/distance/RPE/rest).
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS template_sets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          template_exercise_id UUID NOT NULL REFERENCES template_exercises(id) ON DELETE CASCADE,
          set_number INTEGER NOT NULL,
          set_type TEXT NOT NULL DEFAULT 'normal',
          target_weight NUMERIC,
          target_weight_unit TEXT NOT NULL DEFAULT 'lb',
          target_reps INTEGER,
          target_distance_m NUMERIC,
          target_duration_s INTEGER,
          target_rpe NUMERIC,
          rest_seconds INTEGER,
          side TEXT
        )
      `)
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_template_set_slot ON template_sets(template_exercise_id, set_number)`,
      )

      // workouts: status + gym context.
      await db.execute(
        sql`ALTER TABLE workouts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed'`,
      )
      await db.execute(sql`ALTER TABLE workouts ADD COLUMN IF NOT EXISTS gym_id UUID`)
      await db.execute(
        sql`ALTER TABLE workouts ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0`,
      )
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS idx_workouts_active ON workouts(status) WHERE status = 'active'`,
      )
      // The old read-before-insert guard could race and leave more than one
      // active row. Reconcile that legacy state before installing the invariant:
      // keep the newest session, preserve older rows as discarded history.
      await db.execute(sql`
        WITH ranked AS (
          SELECT id,
            row_number() OVER (ORDER BY started_at DESC, created_at DESC, id DESC) AS active_rank
          FROM workouts
          WHERE status = 'active'
        )
        UPDATE workouts w
        SET status = 'discarded', ended_at = COALESCE(w.ended_at, now())
        FROM ranked r
        WHERE w.id = r.id AND r.active_rank > 1
      `)
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_workouts_one_active ON workouts(status) WHERE status = 'active'`,
      )

      // Repeat-exercise unlock: the historical unique index blocked adding the
      // same exercise twice in one workout. Replace it with a plain index (the
      // base DDL now creates idx_workout_exercise for fresh databases).
      await db.execute(sql`DROP INDEX IF EXISTS uq_workout_exercise`)
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS idx_workout_exercise ON workout_exercises(workout_id, exercise_id)`,
      )

      // workout_exercises: superset + rest override + block role (§10b.3).
      await db.execute(
        sql`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS superset_group INTEGER`,
      )
      await db.execute(
        sql`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS rest_seconds INTEGER`,
      )
      await db.execute(
        sql`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS rest_seconds_warmup INTEGER`,
      )
      await db.execute(
        sql`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'main'`,
      )
      await db.execute(
        sql`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS prescription_rule TEXT`,
      )

      // workout_sets: stable optimistic-queue upsert key + per-side hold marker
      // (§10b.2; 'left'|'right'|NULL=bilateral). Older imports predate the key;
      // backfill them once, then keep the invariant for every future insert so a
      // hydrated legacy row can never be reinserted as a duplicate.
      await db.execute(sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS client_set_id UUID`)
      await db.execute(
        sql`ALTER TABLE workout_sets ALTER COLUMN client_set_id SET DEFAULT gen_random_uuid()`,
      )
      await db.execute(sql`
        UPDATE workout_sets
        SET client_set_id = gen_random_uuid()
        WHERE client_set_id IS NULL
      `)
      await db.execute(
        sql`ALTER TABLE workout_sets ALTER COLUMN client_set_id SET NOT NULL`,
      )
      await db.execute(sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS side TEXT`)
      await db.execute(sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS logical_set_id UUID`)
      await db.execute(
        sql`ALTER TABLE workout_sets ALTER COLUMN logical_set_id SET DEFAULT gen_random_uuid()`,
      )
      // Every legacy row starts as one logical set, using the already-stable
      // optimistic-write id. Explicit adjacent L/R rows are then paired only
      // while both still carry that one-row legacy identity.
      await db.execute(sql`
        UPDATE workout_sets
        SET logical_set_id = client_set_id
        WHERE logical_set_id IS NULL
      `)
      await db.execute(sql`
        WITH sided AS (
          SELECT id, workout_exercise_id, client_set_id, logical_set_id,
            set_number, set_type, side,
            row_number() OVER (
              PARTITION BY workout_exercise_id
              ORDER BY set_number, created_at, id
            ) AS side_rank
          FROM workout_sets
          WHERE side IN ('left','right')
        ), safe_pairs AS (
          SELECT a.logical_set_id AS pair_id, b.id AS second_id
          FROM sided a
          JOIN sided b
            ON b.workout_exercise_id = a.workout_exercise_id
           AND b.side_rank = a.side_rank + 1
          WHERE (a.side_rank % 2) = 1
            AND b.set_number = a.set_number + 1
            AND b.side <> a.side
            AND b.set_type = a.set_type
            AND a.logical_set_id = a.client_set_id
            AND b.logical_set_id = b.client_set_id
        )
        UPDATE workout_sets ws
        SET logical_set_id = pair.pair_id
        FROM safe_pairs pair
        WHERE ws.id = pair.second_id
      `)
      await db.execute(sql`ALTER TABLE workout_sets ALTER COLUMN logical_set_id SET NOT NULL`)
      await db.execute(sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS source_weight NUMERIC`)
      await db.execute(sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS load_correction_id UUID`)
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'workout_sets_load_correction_id_fkey'
              AND conrelid = 'workout_sets'::regclass
          ) THEN
            ALTER TABLE workout_sets
              ADD CONSTRAINT workout_sets_load_correction_id_fkey
              FOREIGN KEY (load_correction_id) REFERENCES exercise_load_corrections(id);
          END IF;
        END $$
      `)
      await db.execute(sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS prescribed_weight NUMERIC`)
      await db.execute(
        sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS prescribed_weight_unit TEXT NOT NULL DEFAULT 'lb'`,
      )
      await db.execute(sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS prescribed_reps INTEGER`)
      await db.execute(sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS prescribed_distance_m NUMERIC`)
      await db.execute(sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS prescribed_duration_s INTEGER`)
      await db.execute(sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS prescribed_rpe NUMERIC`)
      await db.execute(sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS rest_seconds INTEGER`)
      await db.execute(sql`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS prescription_source TEXT`)

      // Grip and attachment (2026-08-31). Three nullable columns on each of the
      // three levels — prescription, session, set. NULL on a SET means "inherit
      // from the exercise", never "explicitly none", so nothing is backfilled
      // and no default is set: two years of logged sets genuinely do not record
      // which handle was used, and inventing an answer would poison the
      // per-handle bests this exists to produce.
      for (const table of ['template_exercises', 'workout_exercises', 'workout_sets']) {
        await db.execute(
          sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN IF NOT EXISTS grip_width TEXT`,
        )
        await db.execute(
          sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN IF NOT EXISTS grip_orientation TEXT`,
        )
        await db.execute(
          sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN IF NOT EXISTS attachment TEXT`,
        )
      }
      // Per-grip bests and grip-aware prescription both group completed sets by
      // (exercise, grip) — without this they scan every set the exercise has.
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_workout_sets_grip
        ON workout_sets(workout_exercise_id, attachment, grip_width, grip_orientation)
      `)
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_workout_set_client_id ON workout_sets(client_set_id)`,
      )
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_workout_sets_logical
        ON workout_sets(workout_exercise_id, logical_set_id)
      `)
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_workout_sets_load_correction
        ON workout_sets(load_correction_id)
      `)

      // Versioned, template-backed training plans. Plan policy is deterministic
      // JSON; session rows snapshot day/template identity so later edits do not
      // rewrite what an earlier workout belonged to.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS training_plans (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          goal TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
          schedule_mode TEXT NOT NULL DEFAULT 'flexible' CHECK (schedule_mode IN ('flexible','fixed')),
          policy JSONB NOT NULL DEFAULT '{}'::jsonb,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS idx_training_plans_status ON training_plans(status, updated_at)`,
      )
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS training_plan_days (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          plan_id UUID NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          name TEXT NOT NULL,
          template_id UUID NOT NULL REFERENCES workout_templates(id) ON DELETE RESTRICT,
          weekday INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (plan_id, position)
        )
      `)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS training_plan_versions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          plan_id UUID NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          snapshot JSONB NOT NULL,
          actor TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (plan_id, version)
        )
      `)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS training_plan_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          plan_id UUID NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
          plan_day_id UUID REFERENCES training_plan_days(id) ON DELETE SET NULL,
          day_name TEXT NOT NULL,
          template_id UUID REFERENCES workout_templates(id) ON DELETE SET NULL,
          plan_version INTEGER NOT NULL,
          workout_id UUID NOT NULL UNIQUE REFERENCES workouts(id) ON DELETE CASCADE,
          sequence_index INTEGER NOT NULL,
          block_index INTEGER,
          block_occurrence INTEGER,
          block_load_multiplier NUMERIC,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (plan_id, sequence_index)
        )
      `)
      await db.execute(
        sql`ALTER TABLE training_plan_sessions ADD COLUMN IF NOT EXISTS block_load_multiplier NUMERIC`,
      )
      await db.execute(
        sql`ALTER TABLE training_plan_sessions ADD COLUMN IF NOT EXISTS block_occurrence INTEGER`,
      )

      // Provenance for automatic habit completion. A manual completion is never
      // claimed; history deletion can therefore roll back only gym-owned logs.
      //
      // `habit_id` / `habit_log_id` are deliberately UNCONSTRAINED here: the
      // habit tracker is not part of this app (see `@/lib/habits` — an inert
      // seam), so `habits` / `habit_log` do not exist and the upstream FKs
      // would abort this whole ensure with `relation "habits" does not exist`,
      // leaving every workspace without a schema. The columns stay so the
      // finish/delete round-trip keeps its shape if a tracker is ever wired in.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS gym_habit_log_links (
          workout_id UUID PRIMARY KEY REFERENCES workouts(id) ON DELETE CASCADE,
          habit_id UUID NOT NULL,
          habit_log_id UUID NOT NULL,
          habit_date DATE NOT NULL,
          gym_managed BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS idx_gym_habit_log_links_log ON gym_habit_log_links(habit_log_id)`,
      )

      // app_settings gym prefs (single-row typed columns; see ensure-app-settings.ts).
      await db.execute(sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gym_default_unit TEXT DEFAULT 'lb'`)
      // weight_unit is authoritative once present. Keep this legacy column in
      // sync for the existing gym server reads without rewriting any set rows.
      await db.execute(sql`
        UPDATE app_settings
        SET gym_default_unit = weight_unit
        WHERE weight_unit IN ('lb','kg')
      `)
      await db.execute(sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gym_weight_unit_override TEXT`)
      await db.execute(sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gym_distance_unit_override TEXT`)
      await db.execute(sql`
        UPDATE app_settings SET gym_weight_unit_override = NULL
        WHERE gym_weight_unit_override IS NOT NULL AND gym_weight_unit_override NOT IN ('lb','kg')
      `)
      await db.execute(sql`
        UPDATE app_settings SET gym_distance_unit_override = NULL
        WHERE gym_distance_unit_override IS NOT NULL AND gym_distance_unit_override NOT IN ('mi','km','m','yd')
      `)
      await db.execute(
        sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gym_default_rest_seconds INTEGER DEFAULT 120`,
      )
      await db.execute(sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gym_timer_sound TEXT`)
      await db.execute(sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gym_linked_habit_id UUID`)
      await db.execute(sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gym_catalog_version TEXT`)
      await db.execute(
        sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gym_count_dumbbells_twice BOOLEAN DEFAULT false`,
      )

      // New tables.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS gyms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          equipment JSONB,
          notes TEXT,
          is_default BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS injuries (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          region TEXT NOT NULL,
          label TEXT,
          note TEXT,
          severity TEXT,
          started_at TIMESTAMPTZ,
          resolved_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        )
      `)
      // #1680: when was this row last a live assessment? A severity of 'out'
      // written on Jul 14 was still being narrated as the CURRENT state a month
      // later, because nothing recorded that nobody had touched it since. Three
      // steps, deliberately in this order: ADD without a default (a default on
      // ADD would stamp every existing row "assessed today" — the exact lie
      // this column exists to prevent), then default future writes, then
      // backfill existing rows to their onset (the last date the label is
      // KNOWN to have been true).
      await db.execute(sql`ALTER TABLE injuries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`)
      await db.execute(sql`ALTER TABLE injuries ALTER COLUMN updated_at SET DEFAULT now()`)
      await db.execute(sql`
        UPDATE injuries SET updated_at = COALESCE(started_at, created_at)
        WHERE updated_at IS NULL
      `)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS workout_proposals (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          for_date DATE NOT NULL,
          payload JSONB NOT NULL,
          rationale TEXT,
          context_hash TEXT,
          status TEXT NOT NULL DEFAULT 'proposed',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS idx_workout_proposals_for_date ON workout_proposals(for_date)`,
      )
      // ROM self-assessment battery (GYM_PLAN §10b.7) — OPT-IN enrichment, never
      // a dependency: nothing prompts for these; the panel shows a passive stamp.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS mobility_assessments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          test_key TEXT NOT NULL,
          side TEXT,
          value_num NUMERIC NOT NULL,
          unit TEXT NOT NULL,
          note TEXT,
          measured_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS idx_mobility_assessments_test ON mobility_assessments(test_key, measured_at)`,
      )

      // Web Push subscriptions for rest-timer pings (GYM_PLAN §2.7b, P2b). One
      // row per browser/PWA push endpoint. `endpoint` is UNIQUE — the subscribe
      // route upserts on it (re-subscribing the same install refreshes keys, not
      // dupes). Keys are opaque base64url from the browser's PushManager; they're
      // NEVER logged. Pruned on a 404/410 from the push service (the endpoint is
      // gone). Nullable columns kept minimal; single-user so no owner scoping.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          user_agent TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_used_at TIMESTAMPTZ
        )
      `)
    })().catch((err) => {
      gymSchemaPromises.delete(key)
      throw err
    })
    gymSchemaPromises.set(key, gymSchemaPromise)
  }
  await gymSchemaPromise
}
