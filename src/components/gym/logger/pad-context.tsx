'use client'

/**
 * NumericPad context (GYM_PLAN §4). The pad is a single bottom-sheet mounted once
 * by the provider (NumericPadHost); any set field opens it by calling
 * `openPad(request)`. Focusing a readOnly weight/reps/duration input dispatches
 * an open request describing the field, its current + ghost value, and the
 * ordered list of "next" fields for auto-advance.
 *
 * This context carries ONLY the open-request + the imperative open/close — the
 * pad reads/writes set values through the store (updateSetField / completeSet),
 * so a keystroke is optimistic + queue-debounced like any other edit.
 */

import { createContext, useContext } from 'react'

import type { SetField, Unit } from '@/lib/gym-client/active-types'
import type { DistanceUnit } from '@/lib/units/system'

/** One focusable target in the auto-advance chain: (exercise, set, field). */
export interface PadTarget {
  workoutExerciseId: string
  clientSetId: string
  setNumber: number
  field: SetField
  /** Ghost placeholder (previous/target) shown when the field is untouched. */
  ghost: number | null
}

export interface PadRequest {
  /** The field the user focused — where the pad opens. */
  target: PadTarget
  /** The exercise's unit (drives plate steppers +2.5/+5/+10 lb vs +1.25/+2.5/+5 kg). */
  unit: Unit
  /** Display/input unit for distance fields; storage remains metres. */
  distanceUnit?: DistanceUnit
  /** Whether to show the RPE quick-row (weight/reps tracks). */
  showRpe: boolean
  /**
   * The ordered auto-advance chain STARTING at the focused field (index 0 is the
   * current field). "Next" commits + advances to chain[i+1]; the last entry's
   * Next completes the set (= ✓).
   */
  chain: PadTarget[]
}

export interface PadController {
  open: (req: PadRequest) => void
  close: () => void
  /** The clientSetId+field currently open, or null (drives input active styling). */
  active: { clientSetId: string; field: SetField } | null
}

const PadContext = createContext<PadController | null>(null)

/** Consume the numeric-pad controller. Returns a no-op controller outside a host
 *  (so a SetTable rendered without the pad host still renders — smoke-test safe). */
export function usePad(): PadController {
  return useContext(PadContext) ?? NOOP_PAD
}

export const PadProvider = PadContext.Provider

const NOOP_PAD: PadController = {
  open: () => {},
  close: () => {},
  active: null,
}
