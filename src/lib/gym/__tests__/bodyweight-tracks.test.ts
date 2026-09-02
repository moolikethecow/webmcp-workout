/**
 * Bodyweight movements must be able to hold a record.
 *
 * Every bodyweight row shipped as `weight_reps`, and `computeRecords` takes the
 * weight branch for that track — which filters `weight > 0`. So a pull-up logged
 * for a year produced no record, ever, and three of the six track types
 * ('reps', 'weighted_bodyweight', 'assisted_bodyweight') were assigned to zero
 * rows in the entire catalog.
 */
import { describe, expect, it } from 'vitest'

import catalog from '@/lib/fitness/exercise-catalog.json'
import { computeRecords } from '@/lib/gym/records'

type Row = { name: string; equipment?: string | null; modality?: string; tracks?: string }
const rows = catalog as unknown as Row[]
const bodyweight = rows.filter((r) => (r.equipment ?? '').toLowerCase() === 'body weight')

function set(over: Partial<{ reps: number; weight: number | null; date: string; setType: string }> = {}) {
  return {
    setType: 'normal',
    reps: 10,
    weight: null as number | null,
    durationS: null,
    distanceM: null,
    date: '2026-08-01',
    weightUnit: 'lb',
    ...over,
  }
}

describe('bodyweight tracking', () => {
  it('no longer ships every bodyweight strength movement as weight_reps', () => {
    const strength = bodyweight.filter((r) => r.modality === 'strength')
    const stillWeightReps = strength.filter((r) => r.tracks === 'weight_reps')
    expect(strength.length).toBeGreaterThan(200)
    expect(stillWeightReps).toEqual([])
  })

  it('tracks a pull-up as reps so it can hold a rep-max record', () => {
    const pullUp = rows.find((r) => r.name === 'pull-up' || r.name === 'pull up')
    expect(pullUp?.tracks).toBe('reps')

    // The record that was previously impossible.
    const recs = computeRecords([set({ reps: 12 }), set({ reps: 8 })] as never, 'reps')
    expect(recs.repMaxes.length).toBeGreaterThan(0)
  })

  it('a weight_reps bodyweight set still yields NOTHING — the bug this fixes', () => {
    const recs = computeRecords([set({ reps: 12 }), set({ reps: 8 })] as never, 'weight_reps')
    expect(recs.repMaxes).toEqual([])
    expect(recs.bestWeight).toBeNull()
  })

  it('keeps true isometric holds on time, and rep movements off it', () => {
    const byName = (n: string) => rows.find((r) => r.name === n)?.tracks
    expect(byName('front lever')).toBe('time')
    expect(byName('full planche')).toBe('time')
    // ...but these merely CONTAIN hold words and are rep movements.
    expect(byName('front lever reps')).toBe('reps')
    expect(byName('full planche push-up')).toBe('reps')
    expect(byName('handstand push-up')).toBe('reps')
  })

  it('tracks "weighted X" as weighted_bodyweight, counting only the added load', () => {
    const weighted = rows.filter((r) => (r.equipment ?? '').toLowerCase() === 'weighted')
    expect(weighted.length).toBeGreaterThan(20)
    for (const r of weighted) {
      expect(['weighted_bodyweight', 'time']).toContain(r.tracks)
    }
  })

  it('does NOT claim equipment "assisted" is machine-assisted', () => {
    // In this dataset 'assisted' is partner-assisted stretches and core work;
    // the machine-assisted pull-up carries 'leverage machine'. Deriving
    // assisted_bodyweight from the token would mis-track 15 rows.
    const assisted = rows.filter((r) => (r.equipment ?? '').toLowerCase() === 'assisted')
    expect(assisted.some((r) => r.tracks === 'assisted_bodyweight')).toBe(false)
  })
})
