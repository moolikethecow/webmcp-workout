import { describe, expect, it } from 'vitest'

import {
  convertStoredWeight,
  convertWeight,
  formatWeight,
  normalizeWeightUnit,
} from '../weight'

describe('weight-unit helpers', () => {
  it('converts pounds and kilograms without changing same-unit values', () => {
    expect(convertWeight(220.462, 'lb', 'kg')).toBe(100)
    expect(convertWeight(100, 'kg', 'lb')).toBe(220.46)
    expect(convertWeight(62.5, 'kg', 'kg')).toBe(62.5)
  })

  it('normalizes unknown stored units conservatively to pounds', () => {
    expect(normalizeWeightUnit('kg')).toBe('kg')
    expect(normalizeWeightUnit('stone')).toBe('lb')
    expect(convertStoredWeight(100, 'kg', 'lb')).toBe(220.46)
  })

  it('handles absent/non-finite values and formats concise labels', () => {
    expect(convertWeight(null, 'lb', 'kg')).toBeNull()
    expect(convertWeight(Number.NaN, 'lb', 'kg')).toBeNull()
    expect(formatWeight(81.6466, 'kg')).toBe('81.6 kg')
    expect(formatWeight(null, 'lb')).toBe('—')
  })
})
