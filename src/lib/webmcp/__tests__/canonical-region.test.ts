import { describe, expect, it } from 'vitest'
import { canonicalRegion } from '../tools/training-constraints'

describe('canonicalRegion', () => {
  it('maps everyday words to canonical sites', () => {
    expect(canonicalRegion('shoulder')).toBe('shoulder_joint')
    expect(canonicalRegion('Right Shoulder'.split(' ')[1])).toBe('shoulder_joint')
    expect(canonicalRegion('knee')).toBe('knees')
    expect(canonicalRegion('lower back')).toBe('lower_back')
    expect(canonicalRegion('hamstring')).toBe('hamstrings')
  })
  it('passes canonical sites through unchanged', () => {
    expect(canonicalRegion('shoulder_joint')).toBe('shoulder_joint')
    expect(canonicalRegion('lats')).toBe('lats')
  })
  it('is undefined for empty input', () => {
    expect(canonicalRegion(undefined)).toBeUndefined()
    expect(canonicalRegion('')).toBeUndefined()
  })
})
