import { describe, expect, it } from 'vitest'

import {
  formatHydrationVolume,
  mlToFluidOunces,
  volumeToMl,
} from '@/lib/units/volume'

describe('hydration volume conversions', () => {
  it('stores common US containers as rounded canonical milliliters', () => {
    expect(volumeToMl(1, 'cup')).toBe(237)
    expect(volumeToMl(1, 'half_gallon')).toBe(1_893)
    expect(volumeToMl(64, 'fl_oz')).toBe(1_893)
  })

  it('formats canonical values at the presentation boundary', () => {
    expect(formatHydrationVolume(1_893, true)).toBe('64 fl oz')
    expect(formatHydrationVolume(1_893, false)).toBe('1.9 L')
    expect(formatHydrationVolume(237, false)).toBe('237 mL')
    expect(mlToFluidOunces(1_893)).toBeCloseTo(64, 1)
  })
})
