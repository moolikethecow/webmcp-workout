import 'server-only'

import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { ensureAppSettingsSchema } from '@/lib/db/ensure-app-settings'
import {
  preferencesForUnitSystem,
  unitSystemFromWeightUnit,
  type UnitPreferences,
  type UnitSystem,
} from '@/lib/units/system'
import { normalizeWeightUnit, type WeightUnit } from '@/lib/units/weight'

const CACHE_TTL_MS = 60_000
let cached: { preferences: UnitPreferences; expiresAt: number } | null = null

/** Read the one app-wide measurement system. Fail-open to imperial. */
export async function getAppUnitPreferences(): Promise<UnitPreferences> {
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.preferences
  try {
    await ensureAppSettingsSchema()
    const [row] = (
      await db.execute(sql`
        SELECT unit_system AS system, weight_unit AS weight FROM app_settings LIMIT 1
      `)
    ).rows as unknown as Array<{ system: string | null; weight: string | null }>
    const system: UnitSystem = row?.system === 'metric' || row?.system === 'imperial'
      ? row.system
      : unitSystemFromWeightUnit(row?.weight)
    const preferences = preferencesForUnitSystem(system)
    cached = { preferences, expiresAt: now + CACHE_TTL_MS }
    return preferences
  } catch {
    return preferencesForUnitSystem('imperial')
  }
}

export async function getAppUnitSystem(): Promise<UnitSystem> {
  return (await getAppUnitPreferences()).system
}

/** Read the one app-wide display/default unit. Fail-open to pounds. */
export async function getAppWeightUnit(): Promise<WeightUnit> {
  return normalizeWeightUnit((await getAppUnitPreferences()).weight)
}

export function invalidateWeightUnitCache(): void {
  cached = null
}

/**
 * Mirror the canonical setting into the gym's own default. Historical rows are
 * deliberately untouched.
 */
export async function syncWeightUnitDefaults(unit: WeightUnit): Promise<void> {
  await db.execute(sql`
    UPDATE app_settings
    SET gym_default_unit = ${unit}, updated_at = now()
    WHERE id = 1
  `)
  invalidateWeightUnitCache()
}
