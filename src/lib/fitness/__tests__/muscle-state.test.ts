/**
 * Per-muscle training/recovery state math. Deterministic thresholds behind the
 * muscle map's colors — these lock the fresh/recovering/ready/undertrained/
 * untrained boundaries and the volume-trend arrow so a UI tweak can't silently
 * move them.
 */
import { describe, it, expect } from 'vitest'

import {
  classifyMuscle,
  computeMuscleStates,
  daysSinceDate,
  type MuscleAggregate,
} from '../muscle-state'
import { MUSCLE_REGIONS } from '../muscles'

const NOW = new Date('2026-07-03T12:00:00Z')

// `daysAgo(n)` → an ISO date n whole days before NOW's calendar day.
const daysAgo = (n: number) => new Date(Date.UTC(2026, 6, 3 - n)).toISOString().slice(0, 10)

const agg = (over: Partial<MuscleAggregate>): MuscleAggregate => ({
  region: 'chest',
  lastWorkedDate: null,
  lastPrimaryDate: null,
  weeklySets: 0,
  priorWeeklySets: 0,
  exercises: [],
  ...over,
})

describe('daysSinceDate', () => {
  it('counts whole days from a date to now (calendar-based)', () => {
    expect(daysSinceDate(daysAgo(0), NOW)).toBe(0)
    expect(daysSinceDate(daysAgo(3), NOW)).toBe(3)
    expect(daysSinceDate(null, NOW)).toBeNull()
  })
})

describe('classifyMuscle', () => {
  it('untrained when there is no primary-mover history', () => {
    expect(classifyMuscle(agg({}), NOW).state).toBe('untrained')
  })

  it('recovering within 2 days of a primary hit', () => {
    expect(classifyMuscle(agg({ lastPrimaryDate: daysAgo(0), weeklySets: 6 }), NOW).state).toBe('recovering')
    expect(classifyMuscle(agg({ lastPrimaryDate: daysAgo(2), weeklySets: 6 }), NOW).state).toBe('recovering')
  })

  it('recovery clock counts SECONDARY work, not just primary days (the triceps fix)', () => {
    // Benched yesterday → triceps hit as a secondary; last DIRECT triceps work was 6d ago.
    const s = classifyMuscle(agg({ lastWorkedDate: daysAgo(1), lastPrimaryDate: daysAgo(6), weeklySets: 4 }), NOW)
    expect(s.daysSince).toBe(1) // worked yesterday → recovery clock is 1 day, not 6
    expect(s.daysSincePrimary).toBe(6) // still surfaces "last trained directly"
    expect(s.state).toBe('recovering') // NOT "ready" — the bug the user reported
  })

  it('ready between 3 and 5 days since last hit', () => {
    expect(classifyMuscle(agg({ lastPrimaryDate: daysAgo(3), weeklySets: 4 }), NOW).state).toBe('ready')
    expect(classifyMuscle(agg({ lastPrimaryDate: daysAgo(5), weeklySets: 4 }), NOW).state).toBe('ready')
  })

  it('fresh when past recovery but still in the recent rotation', () => {
    // 8 days since, but decent recent weekly volume → fresh (rested), not undertrained.
    expect(classifyMuscle(agg({ lastPrimaryDate: daysAgo(8), weeklySets: 5 }), NOW).state).toBe('fresh')
  })

  it('undertrained when past recovery AND barely any recent volume', () => {
    expect(classifyMuscle(agg({ lastPrimaryDate: daysAgo(20), weeklySets: 0 }), NOW).state).toBe('undertrained')
    expect(classifyMuscle(agg({ lastPrimaryDate: daysAgo(9), weeklySets: 1 }), NOW).state).toBe('undertrained')
  })

  it('volume trend arrow compares this week vs prior', () => {
    expect(classifyMuscle(agg({ lastPrimaryDate: daysAgo(1), weeklySets: 8, priorWeeklySets: 4 }), NOW).volumeTrend).toBe(1)
    expect(classifyMuscle(agg({ lastPrimaryDate: daysAgo(1), weeklySets: 3, priorWeeklySets: 8 }), NOW).volumeTrend).toBe(-1)
    expect(classifyMuscle(agg({ lastPrimaryDate: daysAgo(1), weeklySets: 5, priorWeeklySets: 5 }), NOW).volumeTrend).toBe(0)
  })
})

describe('computeMuscleStates', () => {
  it('always returns every region, defaulting missing ones to untrained', () => {
    const states = computeMuscleStates([agg({ region: 'chest', lastPrimaryDate: daysAgo(1), weeklySets: 6 })], NOW)
    expect(Object.keys(states).sort()).toEqual([...MUSCLE_REGIONS].sort())
    expect(states.chest.state).toBe('recovering')
    expect(states.quads.state).toBe('untrained') // no data → untrained
    expect(states.quads.daysSince).toBeNull()
  })
})
