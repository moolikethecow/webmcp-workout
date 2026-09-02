/**
 * Logger format-helper unit tests (GYM_PLAN §4, §3a). Pure, dependency-free.
 * Covers the previous-ghost column, target hint, collapsed summary, and the
 * numeric formatters per tracks shape.
 */
import { describe, it, expect } from 'vitest'

import {
  collapsedSummary,
  hasPrescription,
  metersLabel,
  prescriptionSummary,
  previousText,
  secToMmss,
  targetHint,
  trimNum,
} from '../format'
import type { PreviousSet, TargetSet } from '@/lib/gym-client/active-types'

function prev(over: Partial<PreviousSet>): PreviousSet {
  return { setNumber: 1, weight: null, unit: 'lb', reps: null, durationS: null, distanceM: null, ...over }
}

describe('numeric formatters', () => {
  it('trimNum drops trailing .0 but keeps fractions', () => {
    expect(trimNum(185)).toBe('185')
    expect(trimNum(62.5)).toBe('62.5')
    expect(trimNum(null)).toBe('')
  })
  it('secToMmss formats mm:ss', () => {
    expect(secToMmss(90)).toBe('1:30')
    expect(secToMmss(45)).toBe('0:45')
    expect(secToMmss(null)).toBe('')
  })
  it('metersLabel follows the selected distance unit', () => {
    expect(metersLabel(800, 'm')).toBe('800 m')
    expect(metersLabel(1200, 'km')).toBe('1.2 km')
    expect(metersLabel(1609.344, 'mi')).toBe('1 mi')
  })
})

describe('previousText', () => {
  it('weight_reps shows "weight × reps" from the previous set', () => {
    expect(previousText('weight_reps', prev({ weight: 185, reps: 8 }), undefined)).toBe('185 × 8')
  })
  it('falls back to the progression target when no previous exists', () => {
    const target: TargetSet = { weight: 190, reps: 8 }
    expect(previousText('weight_reps', undefined, target)).toBe('190 × 8')
  })
  it('reps shows just the rep count', () => {
    expect(previousText('reps', prev({ reps: 12 }), undefined)).toBe('12')
  })
  it('time shows mm:ss, prefixed by weight when present', () => {
    expect(previousText('time', prev({ durationS: 90 }), undefined)).toBe('1:30')
    expect(previousText('time', prev({ durationS: 90, weight: 45 }), undefined)).toBe('45 · 1:30')
  })
  it('distance_time joins distance + duration', () => {
    expect(previousText('distance_time', prev({ distanceM: 800, durationS: 300 }), undefined)).toBe('800 m · 5:00')
  })
  it('returns empty when neither previous nor target exists', () => {
    expect(previousText('weight_reps', undefined, undefined)).toBe('')
  })
})

describe('targetHint', () => {
  it('shows the "→ …" nudge only when the target differs from the previous', () => {
    const p = prev({ weight: 185, reps: 8 })
    expect(targetHint('weight_reps', p, { weight: 190, reps: 8 })).toBe('→ 190×8')
  })
  it('is empty when the target equals the previous (no nudge)', () => {
    const p = prev({ weight: 190, reps: 8 })
    expect(targetHint('weight_reps', p, { weight: 190, reps: 8 })).toBe('')
  })
  it('is empty for non-weight tracks', () => {
    expect(targetHint('reps', prev({ reps: 8 }), { reps: 10 })).toBe('')
  })
})

describe('collapsedSummary', () => {
  it('reports the working-set count + heaviest top set for weight tracks', () => {
    const sets = [
      { setType: 'warmup', weight: 95, reps: 10, durationS: null, distanceM: null, completed: true },
      { setType: 'normal', weight: 170, reps: 8, durationS: null, distanceM: null, completed: true },
      { setType: 'normal', weight: 165, reps: 8, durationS: null, distanceM: null, completed: true },
    ]
    // warmup excluded from the count; top = heaviest working set.
    expect(collapsedSummary('weight_reps', sets)).toBe('2 sets · 170×8 top')
  })
  it('reps tracks report the top rep count', () => {
    const sets = [
      { setType: 'normal', weight: null, reps: 12, durationS: null, distanceM: null, completed: true },
      { setType: 'normal', weight: null, reps: 15, durationS: null, distanceM: null, completed: true },
    ]
    expect(collapsedSummary('reps', sets)).toBe('2 sets · 15 reps top')
  })
  it('time tracks report the best duration', () => {
    const sets = [{ setType: 'normal', weight: null, reps: null, durationS: 90, distanceM: null, completed: true }]
    expect(collapsedSummary('time', sets)).toBe('1 set · 1:30')
  })
})

// #1876 — the replace-confirm "keep this as your target?" prompt.
describe('hasPrescription', () => {
  it('true when a working target carries a real value', () => {
    const targets: TargetSet[] = [{ setNumber: 1, setType: 'normal', weight: 105, reps: 10 }]
    expect(hasPrescription(targets)).toBe(true)
  })
  it('false when there are no targets', () => {
    expect(hasPrescription([])).toBe(false)
  })
  it('false when the only target is a warmup', () => {
    const targets: TargetSet[] = [{ setNumber: 1, setType: 'warmup', weight: 45, reps: 10 }]
    expect(hasPrescription(targets)).toBe(false)
  })
})

describe('prescriptionSummary', () => {
  it('reports set count + heaviest top target for weight tracks', () => {
    const targets: TargetSet[] = [
      { setNumber: 1, setType: 'warmup', weight: 45, reps: 10 },
      { setNumber: 2, setType: 'normal', weight: 105, reps: 10 },
      { setNumber: 3, setType: 'normal', weight: 100, reps: 10 },
    ]
    // matches the user's reported prescription: 3×10 @ 105 lb (warmup excluded).
    expect(prescriptionSummary('weight_reps', targets)).toBe('2 sets · 105×10 top')
  })
  it('reps tracks report the top rep count', () => {
    const targets: TargetSet[] = [{ setNumber: 1, setType: 'normal', reps: 15 }]
    expect(prescriptionSummary('reps', targets)).toBe('1 set · 15 reps top')
  })
  it('empty when there are no working targets', () => {
    expect(prescriptionSummary('weight_reps', [])).toBe('')
    expect(prescriptionSummary('weight_reps', [{ setNumber: 1, setType: 'warmup', weight: 45 }])).toBe('')
  })
})
