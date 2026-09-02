import { describe, expect, it } from 'vitest'

import {
  convertLength,
  convertDistance,
  convertTemperature,
  distanceToMeters,
  formatDistance,
  formatPace,
  metersToDistance,
  preferencesForUnitSystem,
  unitSystemFromWeightUnit,
} from '../system'

describe('measurement-system helpers', () => {
  it('maps one system to weight, body, distance, speed, and pace units', () => {
    expect(preferencesForUnitSystem('imperial')).toEqual({
      system: 'imperial', weight: 'lb', bodyLength: 'in', distance: 'mi', speed: 'mph', pace: 'min/mi', temperature: '°F',
    })
    expect(preferencesForUnitSystem('metric')).toEqual({
      system: 'metric', weight: 'kg', bodyLength: 'cm', distance: 'km', speed: 'km/h', pace: 'min/km', temperature: '°C',
    })
    expect(unitSystemFromWeightUnit('kg')).toBe('metric')
    expect(unitSystemFromWeightUnit('stone')).toBe('imperial')
  })

  it('converts Progress centimetres to inches without touching stored values', () => {
    expect(convertLength(44.1325, 'cm', 'in', 3)).toBe(17.375)
    expect(convertLength(17.375, 'inches', 'cm', 4)).toBe(44.1325)
    expect(convertLength(12, 'unknown', 'in')).toBeNull()
  })

  it('round-trips gym distance and formats pace in the selected system', () => {
    expect(distanceToMeters(1, 'mi')).toBe(1609.344)
    expect(metersToDistance(1609.344, 'mi')).toBe(1)
    expect(formatDistance(5000, 'km')).toBe('5 km')
    expect(formatDistance(1609.344, 'mi')).toBe('1 mi')
    expect(formatPace(1500, 5000, 'km')).toBe('5:00 min/km')
    expect(convertDistance(3.1, 'mi', 'km', 2)).toBe(4.99)
    expect(convertTemperature(68, 'degF', '°C', 1)).toBe(20)
  })
})
