import 'server-only'

import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { ensureAppSettingsSchema } from '@/lib/db/ensure-app-settings'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import {
  isDistanceUnit,
  preferencesForUnitSystem,
  unitSystemFromWeightUnit,
  type DistanceUnit,
  type LengthUnit,
  type UnitSystem,
} from '@/lib/units/system'
import { normalizeWeightUnit, type WeightUnit } from '@/lib/units/weight'

export interface GymUnitPreferences {
  system: UnitSystem
  appWeightUnit: WeightUnit
  appDistanceUnit: 'mi' | 'km'
  weightOverride: WeightUnit | null
  distanceOverride: DistanceUnit | null
  weightUnit: WeightUnit
  distanceUnit: DistanceUnit
  bodyLengthUnit: LengthUnit
}

/** Gym follows App Settings unless an explicit gym-only override is present. */
export async function getGymUnitPreferences(): Promise<GymUnitPreferences> {
  await Promise.all([ensureAppSettingsSchema(), ensureGymSchema()])
  const [row] = (await db.execute(sql`
    SELECT unit_system, weight_unit, gym_weight_unit_override, gym_distance_unit_override
    FROM app_settings WHERE id = 1 LIMIT 1
  `)).rows as unknown as Array<{
    unit_system: string | null
    weight_unit: string | null
    gym_weight_unit_override: string | null
    gym_distance_unit_override: string | null
  }>
  const system: UnitSystem = row?.unit_system === 'metric' || row?.unit_system === 'imperial'
    ? row.unit_system
    : unitSystemFromWeightUnit(row?.weight_unit)
  const app = preferencesForUnitSystem(system)
  const weightOverride = row?.gym_weight_unit_override === 'lb' || row?.gym_weight_unit_override === 'kg'
    ? row.gym_weight_unit_override
    : null
  const distanceOverride = isDistanceUnit(row?.gym_distance_unit_override)
    ? row.gym_distance_unit_override
    : null
  const distanceUnit = distanceOverride ?? app.distance
  return {
    system,
    appWeightUnit: normalizeWeightUnit(app.weight),
    appDistanceUnit: app.distance,
    weightOverride,
    distanceOverride,
    weightUnit: weightOverride ?? app.weight,
    distanceUnit,
    // Mobility/body dimensions follow the app-wide system. A miles/kilometres
    // override must not silently change how circumference or ROM is entered.
    bodyLengthUnit: app.bodyLength,
  }
}

export async function getGymWeightUnit(): Promise<WeightUnit> {
  return (await getGymUnitPreferences()).weightUnit
}
