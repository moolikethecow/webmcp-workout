/**
 * Per-grip bests (2026-08-31).
 *
 * The user asked for ONE continuous history plus a best per handle — which is why
 * this sits alongside `computeRecords` instead of replacing it. Splitting the
 * exercise would break the trend line the moment he switched attachments, and
 * that is the whole reason grip is an attribute rather than a catalog row.
 */
import { describe, expect, it } from 'vitest'

import { EMPTY_GRIP, type GripSpec } from '../grip'
import {
  GRIP_RECORD_MIN_SESSIONS,
  GRIP_RECORD_MIN_SETS,
  computeRecords,
  computeRecordsByGrip,
  type SetInput,
} from '../records'

const MAG: GripSpec = { gripWidth: null, gripOrientation: 'neutral', attachment: 'mag' }
const WIDE: GripSpec = { gripWidth: 'wide', gripOrientation: 'pronated', attachment: 'lat_bar' }

/** n working sets on `day`-numbered separate days. */
function sets(
  count: number,
  opts: { weight: number; grip?: GripSpec; startDay?: number; perDay?: number },
): SetInput[] {
  const perDay = opts.perDay ?? 3
  return Array.from({ length: count }, (_, i) => ({
    setType: 'normal' as const,
    weight: opts.weight,
    unit: 'lb',
    reps: 10,
    distanceM: null,
    durationS: null,
    date: `2026-08-${String((opts.startDay ?? 1) + Math.floor(i / perDay)).padStart(2, '0')}`,
    ...(opts.grip ? { grip: opts.grip } : {}),
  }))
}

describe('computeRecordsByGrip', () => {
  it('reports a best for each way the movement was held', () => {
    const all = [
      ...sets(9, { weight: 140, grip: WIDE }),
      ...sets(9, { weight: 160, grip: MAG, startDay: 10 }),
    ]
    const groups = computeRecordsByGrip(all, 'weight_reps')
    expect(groups).toHaveLength(2)
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g.records.bestWeight?.value]))
    expect(byLabel['Wide overhand · Lat bar']).toBe(140)
    expect(byLabel['Neutral · MAG']).toBe(160)
  })

  // The overall record must not change — that is the promise that makes this
  // safe to add at all.
  it('leaves the exercise-wide record exactly as it was', () => {
    const all = [
      ...sets(9, { weight: 140, grip: WIDE }),
      ...sets(9, { weight: 160, grip: MAG, startDay: 10 }),
    ]
    expect(computeRecords(all, 'weight_reps').bestWeight?.value).toBe(160)
  })

  describe('the bar for showing a group', () => {
    // Both conditions are necessary and neither is sufficient.
    it('hides a group with enough sets but only one session', () => {
      const all = sets(GRIP_RECORD_MIN_SETS + 2, { weight: 140, grip: MAG, perDay: 99 })
      expect(computeRecordsByGrip(all, 'weight_reps')).toHaveLength(0)
    })

    it('hides a group with enough sessions but too few sets', () => {
      const all = sets(GRIP_RECORD_MIN_SESSIONS, { weight: 140, grip: MAG, perDay: 1 })
      expect(computeRecordsByGrip(all, 'weight_reps')).toHaveLength(0)
    })

    it('shows a group that clears both', () => {
      const all = sets(GRIP_RECORD_MIN_SETS, { weight: 140, grip: MAG, perDay: 3 })
      const groups = computeRecordsByGrip(all, 'weight_reps')
      expect(groups).toHaveLength(1)
      expect(groups[0]).toMatchObject({ sets: GRIP_RECORD_MIN_SETS, sessions: 2 })
    })
  })

  // Warmups are not records anywhere else either; counting them toward the
  // threshold would let a group qualify on work that never counted.
  it('ignores warmups for both the records and the threshold', () => {
    const all = [
      ...sets(GRIP_RECORD_MIN_SETS, { weight: 140, grip: MAG }),
      ...sets(20, { weight: 300, grip: MAG }).map((s) => ({ ...s, setType: 'warmup' as const })),
    ]
    const groups = computeRecordsByGrip(all, 'weight_reps')
    expect(groups[0]!.sets).toBe(GRIP_RECORD_MIN_SETS)
    expect(groups[0]!.records.bestWeight?.value).toBe(140)
  })

  // Two years of history predate grip. That work is real and stays in the
  // overall trend, but it cannot be compared handle-to-handle.
  it('buckets sets with no grip under unspecified, labelled null', () => {
    const groups = computeRecordsByGrip(sets(9, { weight: 100 }), 'weight_reps')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBe('unspecified')
    expect(groups[0]!.label).toBeNull()
  })

  it('treats an explicitly empty grip the same as an absent one', () => {
    const all = [
      ...sets(5, { weight: 100 }),
      ...sets(5, { weight: 100, grip: EMPTY_GRIP, startDay: 10 }),
    ]
    expect(computeRecordsByGrip(all, 'weight_reps')).toHaveLength(1)
  })

  // The handle he actually trains on should lead the list.
  it('orders most-trained first', () => {
    const all = [
      ...sets(6, { weight: 140, grip: WIDE }),
      ...sets(12, { weight: 160, grip: MAG, startDay: 10 }),
    ]
    expect(computeRecordsByGrip(all, 'weight_reps').map((g) => g.label)).toEqual([
      'Neutral · MAG',
      'Wide overhand · Lat bar',
    ])
  })

  it('returns nothing when the exercise was only ever done one undeclared way', () => {
    expect(computeRecordsByGrip(sets(2, { weight: 100 }), 'weight_reps')).toEqual([])
  })
})
