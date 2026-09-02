import { describe, expect, it } from 'vitest'

import { parseCustomRest } from '../SetRestPicker'

describe('parseCustomRest', () => {
  it('accepts seconds and min:sec', () => {
    expect(parseCustomRest('135')).toBe(135)
    expect(parseCustomRest('2:15')).toBe(135)
    expect(parseCustomRest('0')).toBe(0)
  })

  it('rejects malformed or over-hour values', () => {
    expect(parseCustomRest('2:75')).toBeUndefined()
    expect(parseCustomRest('1.5')).toBeUndefined()
    expect(parseCustomRest('3601')).toBeUndefined()
  })
})
