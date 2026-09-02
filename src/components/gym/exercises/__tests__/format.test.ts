import { describe, expect, it } from 'vitest'

import { elapsedClock, mmss } from '../format'

describe('mmss', () => {
  it('formats seconds as mm:ss, uncapped', () => {
    expect(mmss(90)).toBe('1:30')
    expect(mmss(3900)).toBe('65:00')
  })
  it('null / NaN → dash', () => {
    expect(mmss(null)).toBe('—')
    expect(mmss(undefined)).toBe('—')
  })
})

describe('elapsedClock', () => {
  it('mm:ss under an hour', () => {
    expect(elapsedClock(90)).toBe('1:30')
    expect(elapsedClock(3599)).toBe('59:59')
  })
  it('rolls to "1h Xm" at and past an hour', () => {
    expect(elapsedClock(3600)).toBe('1h 0m')
    expect(elapsedClock(3900)).toBe('1h 5m') // 65 min
    expect(elapsedClock(5400)).toBe('1h 30m') // 90 min
    expect(elapsedClock(7260)).toBe('2h 1m')
  })
  it('null / NaN → dash', () => {
    expect(elapsedClock(null)).toBe('—')
    expect(elapsedClock(undefined)).toBe('—')
  })
})
