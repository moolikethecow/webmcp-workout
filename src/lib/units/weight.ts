/**
 * Canonical weight-unit helpers shared by Health, Gym, and Nutrition surfaces.
 *
 * Storage stays explicit at each domain boundary (body measurements are usually
 * normalized to lb; gym sets remain stored-as-entered). These helpers are for
 * deterministic conversion at read/display boundaries only.
 */

export type WeightUnit = 'lb' | 'kg'

export const KG_TO_LB = 2.2046226218
export const LB_TO_KG = 1 / KG_TO_LB

export function isWeightUnit(value: unknown): value is WeightUnit {
  return value === 'lb' || value === 'kg'
}
export function normalizeWeightUnit(value: unknown, fallback: WeightUnit = 'lb'): WeightUnit {
  return isWeightUnit(value) ? value : fallback
}

/** Convert a finite weight without mutating its stored source value. */
export function convertWeight(
  value: number | null | undefined,
  from: WeightUnit,
  to: WeightUnit,
  decimals = 2,
): number | null {
  if (value == null || !Number.isFinite(value)) return null
  if (from === to) return value
  const converted = to === 'kg' ? value * LB_TO_KG : value * KG_TO_LB
  const factor = 10 ** Math.max(0, decimals)
  return Math.round(converted * factor) / factor
}

export function convertStoredWeight(
  value: number | null | undefined,
  storedUnit: unknown,
  displayUnit: WeightUnit,
  decimals = 2,
): number | null {
  return convertWeight(value, normalizeWeightUnit(storedUnit), displayUnit, decimals)
}

export function formatWeight(
  value: number | null | undefined,
  unit: WeightUnit,
  decimals = 1,
): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Number(value.toFixed(decimals)).toLocaleString('en-US')} ${unit}`
}
