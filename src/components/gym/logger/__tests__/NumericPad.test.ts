import { describe, expect, it } from 'vitest'

import { initialPadBuffer } from '../NumericPad'

describe('initialPadBuffer', () => {
  it('converts an existing stored weight into the keypad display unit', () => {
    expect(initialPadBuffer('weight', 220, 'lb', 'kg')).toBe('99.79')
    expect(initialPadBuffer('weight', 90, 'kg', 'lb')).toBe('198.42')
  })

  it('leaves same-unit weights and non-weight fields unchanged', () => {
    expect(initialPadBuffer('weight', 90, 'kg', 'kg')).toBe('90')
    expect(initialPadBuffer('durationS', 90, 'lb', 'kg')).toBe('1:30')
  })
})
