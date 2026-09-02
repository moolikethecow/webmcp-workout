import { describe, expect, it } from 'vitest'

import {
  loadVolume,
  loadVolumeMultiplier,
  logicalSetKey,
  normalizeLoadBasis,
  normalizeSetSide,
} from '../load-semantics'

describe('load semantics', () => {
  it('defaults unknown load conventions to historical total-load behavior', () => {
    expect(normalizeLoadBasis('per_side')).toBe('per_side')
    expect(normalizeLoadBasis('total')).toBe('total')
    expect(normalizeLoadBasis(null)).toBe('total')
  })

  it('treats NULL as Both and only doubles a per-side Both row', () => {
    expect(normalizeSetSide('left')).toBe('left')
    expect(normalizeSetSide('right')).toBe('right')
    expect(normalizeSetSide('both')).toBeNull()
    expect(loadVolumeMultiplier('total', null)).toBe(1)
    expect(loadVolumeMultiplier('per_side', null)).toBe(2)
    expect(loadVolumeMultiplier('per_side', 'left')).toBe(1)
    expect(loadVolumeMultiplier('per_side', 'right')).toBe(1)
  })

  it('computes equivalent volume for Both and one explicit side contribution', () => {
    expect(loadVolume(42.5, 10, 'per_side', null)).toBe(850)
    expect(loadVolume(42.5, 10, 'per_side', 'left')).toBe(425)
    expect(loadVolume(42.5, 10, 'total', null)).toBe(425)
    expect(loadVolume(0, 10, 'per_side', null)).toBe(0)
  })

  it('uses logical ids when present and unique row fallbacks otherwise', () => {
    expect(logicalSetKey('round-1', 0)).toBe('logical:round-1')
    expect(logicalSetKey(null, 0)).toBe('row:0')
    expect(logicalSetKey(null, 1)).toBe('row:1')
  })
})
