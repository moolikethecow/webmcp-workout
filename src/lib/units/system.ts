/**
 * App-wide measurement-system helpers.
 *
 * Storage stays canonical/explicit at domain boundaries (body rows retain their
 * source unit; workout distance is metres). These helpers only convert input and
 * presentation so switching units never rewrites historical data.
 */

import { type WeightUnit } from './weight'

export type UnitSystem = 'imperial' | 'metric'
export type LengthUnit = 'in' | 'cm'
export type DistanceUnit = 'mi' | 'km' | 'm' | 'yd'
export type SpeedUnit = 'mph' | 'km/h'
export type PaceUnit = 'min/mi' | 'min/km'
export type TemperatureUnit = '°F' | '°C'

export interface UnitPreferences {
  system: UnitSystem
  weight: WeightUnit
  bodyLength: LengthUnit
  distance: 'mi' | 'km'
  speed: SpeedUnit
  pace: PaceUnit
  temperature: TemperatureUnit
}

export const CM_PER_IN = 2.54
export const METERS_PER_KM = 1_000
export const METERS_PER_MILE = 1_609.344
export const METERS_PER_YARD = 0.9144

export function isUnitSystem(value: unknown): value is UnitSystem {
  return value === 'imperial' || value === 'metric'
}

export function normalizeUnitSystem(value: unknown, fallback: UnitSystem = 'imperial'): UnitSystem {
  return isUnitSystem(value) ? value : fallback
}

export function unitSystemFromWeightUnit(value: unknown): UnitSystem {
  return value === 'kg' ? 'metric' : 'imperial'
}

export function preferencesForUnitSystem(system: UnitSystem): UnitPreferences {
  return system === 'metric'
    ? { system, weight: 'kg', bodyLength: 'cm', distance: 'km', speed: 'km/h', pace: 'min/km', temperature: '°C' }
    : { system, weight: 'lb', bodyLength: 'in', distance: 'mi', speed: 'mph', pace: 'min/mi', temperature: '°F' }
}

export function normalizeLengthUnit(value: unknown): LengthUnit | null {
  if (typeof value !== 'string') return null
  const unit = value.trim().toLowerCase()
  if (unit === 'cm' || unit === 'centimeter' || unit === 'centimeters' || unit === 'centimetre' || unit === 'centimetres') return 'cm'
  if (unit === 'in' || unit === 'inch' || unit === 'inches') return 'in'
  return null
}

export function convertLength(
  value: number | null | undefined,
  from: unknown,
  to: LengthUnit,
  decimals = 2,
): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const source = normalizeLengthUnit(from)
  if (!source) return null
  const converted = source === to ? value : to === 'in' ? value / CM_PER_IN : value * CM_PER_IN
  return round(converted, decimals)
}

export function isDistanceUnit(value: unknown): value is DistanceUnit {
  return value === 'mi' || value === 'km' || value === 'm' || value === 'yd'
}

export function normalizeDistanceUnit(value: unknown): DistanceUnit | null {
  if (typeof value !== 'string') return null
  const unit = value.trim().toLowerCase().replaceAll('.', '')
  if (unit === 'mi' || unit === 'mile' || unit === 'miles') return 'mi'
  if (unit === 'km' || unit === 'kilometer' || unit === 'kilometers' || unit === 'kilometre' || unit === 'kilometres') return 'km'
  if (unit === 'm' || unit === 'meter' || unit === 'meters' || unit === 'metre' || unit === 'metres') return 'm'
  if (unit === 'yd' || unit === 'yard' || unit === 'yards') return 'yd'
  return null
}

export function convertDistance(
  value: number | null | undefined,
  from: unknown,
  to: DistanceUnit,
  decimals = 3,
): number | null {
  const source = normalizeDistanceUnit(from)
  if (!source) return null
  const meters = distanceToMeters(value, source, 6)
  return metersToDistance(meters, to, decimals)
}

export function convertTemperature(
  value: number | null | undefined,
  from: unknown,
  to: TemperatureUnit,
  decimals = 2,
): number | null {
  if (value == null || !Number.isFinite(value) || typeof from !== 'string') return null
  const source = from.trim().toLowerCase().replaceAll('deg', '').replaceAll('°', '')
  const sourceUnit: TemperatureUnit | null = source === 'f' || source === 'fahrenheit'
    ? '°F'
    : source === 'c' || source === 'celsius'
      ? '°C'
      : null
  if (!sourceUnit) return null
  const converted = sourceUnit === to ? value : to === '°C' ? (value - 32) * 5 / 9 : value * 9 / 5 + 32
  return round(converted, decimals)
}

export function metersPerDistanceUnit(unit: DistanceUnit): number {
  if (unit === 'mi') return METERS_PER_MILE
  if (unit === 'km') return METERS_PER_KM
  if (unit === 'yd') return METERS_PER_YARD
  return 1
}

export function distanceToMeters(
  value: number | null | undefined,
  unit: DistanceUnit,
  decimals = 3,
): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return round(value * metersPerDistanceUnit(unit), decimals)
}

export function metersToDistance(
  meters: number | null | undefined,
  unit: DistanceUnit,
  decimals = 3,
): number | null {
  if (meters == null || !Number.isFinite(meters)) return null
  return round(meters / metersPerDistanceUnit(unit), decimals)
}

/** Keep entered-unit labels stable: 5.00 → 5, 3.11 → 3.11. */
export function formatDistance(
  meters: number | null | undefined,
  unit: DistanceUnit,
  decimals?: number,
): string {
  const value = metersToDistance(meters, unit, decimals ?? (unit === 'm' || unit === 'yd' ? 0 : 2))
  if (value == null) return ''
  return `${Number(value.toFixed(decimals ?? (unit === 'm' || unit === 'yd' ? 0 : 2)))} ${unit}`
}

export function paceSecondsPerUnit(
  durationSeconds: number | null | undefined,
  distanceMeters: number | null | undefined,
  unit: 'mi' | 'km',
): number | null {
  if (
    durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
    distanceMeters == null || !Number.isFinite(distanceMeters) || distanceMeters <= 0
  ) return null
  return durationSeconds / (distanceMeters / metersPerDistanceUnit(unit))
}

export function formatPace(
  durationSeconds: number | null | undefined,
  distanceMeters: number | null | undefined,
  unit: 'mi' | 'km',
): string {
  const seconds = paceSecondsPerUnit(durationSeconds, distanceMeters, unit)
  if (seconds == null) return ''
  const rounded = Math.round(seconds)
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')} min/${unit}`
}

export function paceBasisForDistanceUnit(unit: DistanceUnit): 'mi' | 'km' {
  return unit === 'mi' || unit === 'yd' ? 'mi' : 'km'
}

function round(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, decimals)
  return Math.round(value * factor) / factor
}
