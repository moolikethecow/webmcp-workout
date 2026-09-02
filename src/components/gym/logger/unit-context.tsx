'use client'

/**
 * Display-unit context for the logger (GYM_PLAN §8 "Units", P2b). The workout-level
 * unit toggle (lb⇄kg pill in the header) is DISPLAY-only: ghosts, committed values,
 * and pad steppers all render converted, but the STORE keeps entered values + their
 * units untouched (stored-as-entered invariant — asserted in a store test).
 *
 * `override` is the workout-level pick (null = follow each exercise's preferredUnit).
 * `effectiveUnit(exercisePreferred)` resolves it; `toDisplay(value, storedUnit)`
 * converts a stored weight (in its own unit) into the effective display unit. The
 * pad reads `steps(unit)` for the +2.5/+5/+10 lb ⇄ +1.25/+2.5/+5 kg steppers.
 */

import { createContext, useContext, useMemo } from 'react'

import type { Unit } from '@/lib/gym-client/active-types'
import type { DistanceUnit } from '@/lib/units/system'
import { convertWeight, UNIT_STEPS } from '@/lib/gym-client/rest-timer'

export interface UnitDisplay {
  /** Workout-level override, or null to follow each exercise's preferredUnit. */
  override: Unit | null
  /** Effective cardio distance input/display unit. */
  distanceUnit: DistanceUnit
  /** The unit a given exercise renders in (override wins; else its own pref). */
  effectiveUnit: (exercisePreferred: string | null | undefined) => Unit
  /** Convert a stored weight (in `storedUnit`) into `displayUnit` for rendering. */
  toDisplay: (value: number | null, storedUnit: string | null | undefined, displayUnit: Unit) => number | null
  /** Plate-stepper increments for a display unit. */
  steps: (unit: Unit) => number[]
}

const UnitContext = createContext<UnitDisplay | null>(null)

const NOOP: UnitDisplay = {
  override: null,
  distanceUnit: 'm',
  effectiveUnit: (p) => (p === 'kg' ? 'kg' : 'lb'),
  toDisplay: (v) => v,
  steps: (u) => UNIT_STEPS[u],
}

/** Consume the display-unit helper. Returns a per-exercise-pref no-op outside a
 *  provider (so a SetTable rendered bare still renders in entered units). */
export function useUnitDisplay(): UnitDisplay {
  return useContext(UnitContext) ?? NOOP
}

/** Provider seeded from the workout-level override (store.displayUnit). */
export function UnitDisplayProvider({
  override,
  distanceUnit = 'm',
  children,
}: {
  override: Unit | null
  distanceUnit?: DistanceUnit
  children: React.ReactNode
}) {
  const value = useMemo<UnitDisplay>(
    () => ({
      override,
      distanceUnit,
      effectiveUnit: (exercisePreferred) => {
        if (override) return override
        return exercisePreferred === 'kg' ? 'kg' : 'lb'
      },
      toDisplay: (v, storedUnit, displayUnit) =>
        convertWeight(v, storedUnit === 'kg' ? 'kg' : 'lb', displayUnit),
      steps: (u) => UNIT_STEPS[u],
    }),
    [override, distanceUnit],
  )
  return <UnitContext.Provider value={value}>{children}</UnitContext.Provider>
}
