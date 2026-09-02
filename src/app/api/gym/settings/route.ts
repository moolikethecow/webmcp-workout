/**
 * GET / PATCH /api/gym/settings — thin surface over the gym preference columns
 * on the single-row `app_settings` table (GYM_PLAN §3, §4 settings sheet).
 *
 * app_settings is a TYPED-COLUMN singleton (id = 1), NOT a k/v store — this
 * route reads/upserts just the gym_* columns, following the same {id:1}
 * onConflictDoUpdate idiom as /api/settings. `gym_catalog_version` is internal
 * (the enrichment marker) and is deliberately NOT exposed on either verb.
 *
 * `ensureGymSchema()` runs first on both verbs so a cold container that hits
 * this before any other gym surface still finds the columns present.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'

import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { ensureAppSettingsSchema } from '@/lib/db/ensure-app-settings'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { getGymUnitPreferences } from '@/lib/gym/unit-preferences'

interface GymSettings {
  app_unit_system: 'imperial' | 'metric'
  app_weight_unit: 'lb' | 'kg'
  app_distance_unit: 'mi' | 'km'
  gym_weight_unit_override: 'lb' | 'kg' | null
  gym_distance_unit_override: 'mi' | 'km' | 'm' | 'yd' | null
  gym_default_unit: string | null
  gym_distance_unit: 'mi' | 'km' | 'm' | 'yd'
  gym_default_rest_seconds: number | null
  gym_timer_sound: string | null
  gym_linked_habit_id: string | null
  gym_count_dumbbells_twice: boolean | null
}

const DEFAULTS: GymSettings = {
  app_unit_system: 'imperial',
  app_weight_unit: 'lb',
  app_distance_unit: 'mi',
  gym_weight_unit_override: null,
  gym_distance_unit_override: null,
  gym_default_unit: 'lb',
  gym_distance_unit: 'mi',
  gym_default_rest_seconds: 120,
  gym_timer_sound: null,
  gym_linked_habit_id: null,
  gym_count_dumbbells_twice: false,
}

/** Only the user-editable gym prefs — gym_catalog_version is internal and omitted. */
const PatchSchema = z
  .object({
    gym_weight_unit_override: z.enum(['lb', 'kg']).nullable(),
    gym_distance_unit_override: z.enum(['mi', 'km', 'm', 'yd']).nullable(),
    gym_default_rest_seconds: z.number().int().min(0).max(3600),
    gym_timer_sound: z.string().max(64).nullable(),
    gym_linked_habit_id: z.string().uuid().nullable(),
    gym_count_dumbbells_twice: z.boolean(),
  })
  .partial()

async function pickGymSettings(row: Record<string, unknown> | undefined): Promise<GymSettings> {
  const units = await getGymUnitPreferences()
  return {
    app_unit_system: units.system,
    app_weight_unit: units.appWeightUnit,
    app_distance_unit: units.appDistanceUnit,
    gym_weight_unit_override: units.weightOverride,
    gym_distance_unit_override: units.distanceOverride,
    gym_default_unit: units.weightUnit,
    gym_distance_unit: units.distanceUnit,
    gym_default_rest_seconds:
      (row?.gym_default_rest_seconds as number | null | undefined) ?? DEFAULTS.gym_default_rest_seconds,
    gym_timer_sound: (row?.gym_timer_sound as string | null | undefined) ?? DEFAULTS.gym_timer_sound,
    gym_linked_habit_id: (row?.gym_linked_habit_id as string | null | undefined) ?? DEFAULTS.gym_linked_habit_id,
    gym_count_dumbbells_twice:
      (row?.gym_count_dumbbells_twice as boolean | null | undefined) ?? DEFAULTS.gym_count_dumbbells_twice,
  }
}

export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await ensureAppSettingsSchema()
  await ensureGymSchema()
  const rows = (await db.execute(sql`SELECT * FROM app_settings WHERE id = 1 LIMIT 1`))
    .rows as unknown as Array<Record<string, unknown>>
  return NextResponse.json(await pickGymSettings(rows[0]))
}

export async function PATCH(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await ensureAppSettingsSchema()
  await ensureGymSchema()
  const body = await req.json().catch(() => null)
  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  // app_settings is a typed-column singleton (id = 1): upsert just the gym_*
  // columns the patch names, leaving every other column alone.
  const columns = Object.keys(parsed.data) as Array<keyof typeof parsed.data>
  const assignments = columns.map((c) => sql`${sql.identifier(c)} = ${parsed.data[c] ?? null}`)
  const updated = (
    await db.execute(sql`
      INSERT INTO app_settings (id) VALUES (1)
      ON CONFLICT (id) DO UPDATE SET ${sql.join(
        [...assignments, sql`updated_at = now()`],
        sql`, `,
      )}
      RETURNING *
    `)
  ).rows as unknown as Array<Record<string, unknown>>

  return NextResponse.json(await pickGymSettings(updated[0]))
}
