/**
 * Runtime safety net for the app-wide settings row.
 *
 * `app_settings` is a TYPED-COLUMN singleton (id = 1), not a k/v store. This
 * creates it if missing and adds the app-wide measurement preference:
 *
 *  • app_settings.unit_system  — canonical imperial | metric preference
 *  • app_settings.weight_unit  — derived 'lb' | 'kg' compatibility seam
 *
 * The gym's own `gym_*` preference columns are added by `ensureGymSchema()`,
 * which calls this first. ADD COLUMN IF NOT EXISTS only — never destructive,
 * and idempotent via the module-level promise gate.
 */

import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { currentWorkspaceKey } from '@/lib/workspace/context'

// Keyed by workspace id, NOT a single module-level promise: every visitor gets
// their own Postgres schema, so a process-wide memo would run this DDL in the
// first workspace only and leave every later one without tables.
const ensurePromises = new Map<string, Promise<void>>()

export async function ensureAppSettingsSchema(): Promise<void> {
  const key = await currentWorkspaceKey()
  let ensurePromise = ensurePromises.get(key)
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS app_settings (
          id INTEGER PRIMARY KEY DEFAULT 1,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT app_settings_singleton CHECK (id = 1)
        )
      `)
      await db.execute(sql`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`)

      // Add nullable first so a pre-existing gym preference can seed the new
      // canonical value. Dynamic SQL avoids referencing gym_default_unit on a
      // volume where the gym lane has not self-healed yet.
      await db.execute(sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS weight_unit TEXT`)
      await db.execute(sql`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'app_settings'
              AND column_name = 'gym_default_unit'
          ) THEN
            EXECUTE 'UPDATE app_settings
                     SET weight_unit = COALESCE(weight_unit,
                       CASE WHEN gym_default_unit IN (''lb'',''kg'') THEN gym_default_unit ELSE ''lb'' END)';
          ELSE
            UPDATE app_settings SET weight_unit = COALESCE(weight_unit, 'lb');
          END IF;
        END $$
      `)
      await db.execute(sql`UPDATE app_settings SET weight_unit = 'lb' WHERE weight_unit NOT IN ('lb','kg') OR weight_unit IS NULL`)
      await db.execute(sql`ALTER TABLE app_settings ALTER COLUMN weight_unit SET DEFAULT 'lb'`)
      await db.execute(sql`ALTER TABLE app_settings ALTER COLUMN weight_unit SET NOT NULL`)
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'app_settings_weight_unit_check'
              AND conrelid = 'app_settings'::regclass
          ) THEN
            ALTER TABLE app_settings
              ADD CONSTRAINT app_settings_weight_unit_check
              CHECK (weight_unit IN ('lb','kg'));
          END IF;
        END $$
      `)

      await db.execute(sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS unit_system TEXT`)
      await db.execute(sql`
        UPDATE app_settings
        SET unit_system = CASE WHEN weight_unit = 'kg' THEN 'metric' ELSE 'imperial' END
        WHERE unit_system NOT IN ('imperial','metric') OR unit_system IS NULL
      `)
      await db.execute(sql`ALTER TABLE app_settings ALTER COLUMN unit_system SET DEFAULT 'imperial'`)
      await db.execute(sql`ALTER TABLE app_settings ALTER COLUMN unit_system SET NOT NULL`)
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'app_settings_unit_system_check'
              AND conrelid = 'app_settings'::regclass
          ) THEN
            ALTER TABLE app_settings
              ADD CONSTRAINT app_settings_unit_system_check
              CHECK (unit_system IN ('imperial','metric'));
          END IF;
        END $$
      `)
    })().catch((err) => {
      ensurePromises.delete(key)
      throw err
    })
    ensurePromises.set(key, ensurePromise)
  }
  return ensurePromise
}
