/**
 * Deterministic coach-context assembly (lib/gym/coach-context.ts). Every sub-read
 * is mocked; the tests pin fail-open behavior for ordinary context and fail-closed
 * behavior for injury state, plus compact rendering and derived stats. No LLM
 * anywhere on this path.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'

import { sqlText, collapseWs } from './sql-text'
import type { MuscleRegion } from '@/lib/fitness/muscles'

// ── mocks ────────────────────────────────────────────────────────────────────
const mockExecute = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/client', () => ({ db: { execute: mockExecute } }))

const mockBuildMuscleMap = vi.hoisted(() => vi.fn())
vi.mock('@/lib/fitness/muscle-map', () => ({ buildMuscleMap: mockBuildMuscleMap }))

const mockReadiness = vi.hoisted(() => vi.fn())
vi.mock('@/lib/health/readiness', () => ({ computeReadiness: mockReadiness }))

const mockTz = vi.hoisted(() => vi.fn(async () => 'America/New_York'))
const mockTodayInZone = vi.hoisted(() => vi.fn(() => '2026-07-10'))
vi.mock('@/lib/today', () => ({ getAppTimezone: mockTz, todayInZone: mockTodayInZone }))

const { assembleCoachContext, invalidateCoachContext, metaTargetLb } = await import('../coach-context')

// ── helpers ──────────────────────────────────────────────────────────────────
function muscleMapRegions(overrides: Partial<Record<MuscleRegion, { state: string; daysSince: number | null; weeklySets: number }>> = {}) {
  const regions: Record<string, { region: string; state: string; daysSince: number | null; weeklySets: number }> = {}
  const base = { state: 'fresh', daysSince: 10, weeklySets: 0 }
  for (const r of ['chest', 'lats', 'quads', 'delts', 'biceps', 'triceps'] as const) {
    regions[r] = { region: r, ...base, ...(overrides[r] ?? {}) }
  }
  return regions
}

/** A db.execute dispatcher covering every sub-read. `broken` names throw. */
function installDb(opts: {
  catalog?: unknown[]
  goals?: unknown[]
  recentSets?: unknown[]
  injuries?: unknown[]
  dislikes?: unknown[]
  gym?: unknown[]
  broken?: Set<string>
} = {}) {
  mockExecute.mockReset()
  mockExecute.mockImplementation((arg: unknown) => {
    const q = collapseWs(sqlText(arg))
    const fail = (k: string) => opts.broken?.has(k)
    if (/days_since_last, COALESCE\(agg.recent_sets/.test(q)) {
      if (fail('catalog')) return Promise.reject(new Error('catalog boom'))
      return Promise.resolve({ rows: opts.catalog ?? [] })
    }
    if (/FROM goals g/.test(q)) {
      if (fail('goals')) return Promise.reject(new Error('goals boom'))
      return Promise.resolve({ rows: opts.goals ?? [] })
    }
    if (/AS best,.*GROUP BY e\.name/.test(q)) {
      // exerciseE1rms — return empty (no linked-goal numbers needed for these tests)
      return Promise.resolve({ rows: [] })
    }
    if (/w.status = 'completed' AND ws.set_type <> 'warmup' AND ws.completed = true AND w.id IN/.test(q)) {
      if (fail('recent')) return Promise.reject(new Error('recent boom'))
      return Promise.resolve({ rows: opts.recentSets ?? [] })
    }
    if (/FROM injuries/.test(q)) {
      if (fail('injuries')) return Promise.reject(new Error('injuries boom'))
      return Promise.resolve({ rows: opts.injuries ?? [] })
    }
    if (/WHERE disliked_at IS NOT NULL/.test(q)) {
      if (fail('dislikes')) return Promise.reject(new Error('dislikes boom'))
      return Promise.resolve({ rows: opts.dislikes ?? [] })
    }
    if (/FROM gyms WHERE is_default/.test(q)) {
      if (fail('gym')) return Promise.reject(new Error('gym boom'))
      return Promise.resolve({ rows: opts.gym ?? [] })
    }
    return Promise.resolve({ rows: [] })
  })
}

beforeEach(() => {
  invalidateCoachContext()
  mockBuildMuscleMap.mockReset()
  mockBuildMuscleMap.mockResolvedValue({ regions: muscleMapRegions() })
  mockReadiness.mockReset()
  mockReadiness.mockResolvedValue({ zone: 'Primed' })
})

describe('assembleCoachContext partial-read behavior', () => {
  it('ordinary reads fail open while an unreadable injury state blocks recommendations', async () => {
    installDb({ broken: new Set(['catalog', 'goals', 'injuries']) })
    const ctx = await assembleCoachContext(true)
    expect(ctx.catalog).toEqual([])
    expect(ctx.goals).toEqual([])
    expect(ctx.injuries).toEqual([
      { region: 'other', severity: 'out', label: 'injury state unavailable' },
    ])
    expect(ctx.pools.size).toBe(0)
    // A working sub-read still resolves.
    expect(ctx.readinessZone).toBe('Primed')
    expect(ctx.today).toBe('2026-07-10')
  })

  it('readiness failure fails open to a null zone', async () => {
    installDb()
    mockReadiness.mockRejectedValue(new Error('no health data'))
    const ctx = await assembleCoachContext(true)
    expect(ctx.readinessZone).toBeNull()
  })

  it('muscle-map failure fails open to an empty muscle state', async () => {
    installDb()
    mockBuildMuscleMap.mockRejectedValue(new Error('map boom'))
    const ctx = await assembleCoachContext(true)
    expect(ctx.muscleState).toEqual([])
  })
})

describe('assembleCoachContext derived data', () => {
  const catalog = [
    { id: 'a', name: 'Barbell Bench Press', primary_muscle: 'chest', secondary_muscles: ['triceps'], equipment: 'barbell', force: 'push', mechanic: 'compound', disliked_at: null, archived_at: null, days_since_last: 40, recent_sets: 0 },
    { id: 'b', name: 'Cable Fly', primary_muscle: 'chest', secondary_muscles: [], equipment: 'cable', force: 'push', mechanic: 'isolation', disliked_at: null, archived_at: null, days_since_last: 3, recent_sets: 9 },
    { id: 'c', name: 'Pec Deck', primary_muscle: 'chest', secondary_muscles: [], equipment: 'machine', force: 'push', mechanic: 'isolation', disliked_at: '2026-07-01', archived_at: null, days_since_last: 5, recent_sets: 0 },
  ]

  it('uses only completed set rows for novelty counts and recent performance summaries', async () => {
    installDb({ catalog })

    await assembleCoachContext(true)

    const queries = mockExecute.mock.calls.map(([arg]) => collapseWs(sqlText(arg)))
    const catalogQuery = queries.find((q) => /days_since_last, COALESCE\(agg\.recent_sets/.test(q))
    const recentQuery = queries.find((q) => /w\.status = 'completed' AND ws\.set_type <> 'warmup' AND ws\.completed = true/.test(q))
    expect(catalogQuery).toContain('ws.completed = true')
    expect(recentQuery).toContain('ws.completed = true')
  })

  it('builds pools + staleness stats over the eligible (non-disliked) catalog', async () => {
    installDb({ catalog })
    const ctx = await assembleCoachContext(true)
    expect(ctx.staleness.poolSize).toBe(2) // Pec Deck disliked → excluded
    // The stalest (40d, 0 recent) beats the fresh one (3d, 9 recent).
    expect(ctx.staleness.stalest[0]).toBe('Barbell Bench Press')
    expect(ctx.pools.size).toBeGreaterThan(0)
  })

  it('derives the recent split from the muscle-map weekly sets', async () => {
    installDb({ catalog })
    mockBuildMuscleMap.mockResolvedValue({
      regions: muscleMapRegions({ chest: { state: 'ready', daysSince: 3, weeklySets: 12 }, lats: { state: 'ready', daysSince: 4, weeklySets: 6 } }),
    })
    const ctx = await assembleCoachContext(true)
    expect(ctx.recentSplit.get('chest')).toBe(12)
    expect(ctx.recentSplit.get('lats')).toBe(6)
    // Zero-set regions are excluded from the split.
    expect(ctx.recentSplit.has('biceps')).toBe(false)
  })

  it('accepts every supported injury site and drops junk regions', async () => {
    installDb({
      injuries: [
        { region: 'chest', severity: 'limiting', label: 'strain' },
        { region: 'elbows', severity: 'out', label: 'irritated' },
        { region: 'not_a_region', severity: 'out', label: 'x' },
      ],
    })
    const ctx = await assembleCoachContext(true)
    expect(ctx.injuries).toHaveLength(2)
    expect(ctx.injuries[0]!.region).toBe('chest')
    expect(ctx.injuries[1]!.region).toBe('elbows')
  })

  it('reads the default gym equipment', async () => {
    installDb({ gym: [{ id: 'g1', name: 'Home', equipment: ['barbell', 'dumbbell'] }] })
    const ctx = await assembleCoachContext(true)
    expect(ctx.gymId).toBe('g1')
    expect(ctx.gymEquipment).toEqual(['barbell', 'dumbbell'])
  })

  it('preserves structured gym equipment and applies per-gym exclusions', async () => {
    installDb({
      catalog,
      gym: [{
        id: 'g1',
        name: 'Home',
        equipment: {
          categories: ['barbell', 'cable'],
          machines: ['Pec Deck'],
          machines_excluded: ['Cable Fly'],
        },
      }],
    })
    const ctx = await assembleCoachContext(true)
    expect(ctx.gymEquipment).toEqual({
      categories: ['barbell', 'cable'],
      machines: ['Pec Deck'],
      machines_excluded: ['Cable Fly'],
    })
    expect(ctx.staleness.stalest).toContain('Barbell Bench Press')
    expect(ctx.staleness.stalest).not.toContain('Cable Fly')
    expect([...ctx.pools.values()].flatMap((pool) => pool.exercises.map((e) => e.name)))
      .not.toContain('Cable Fly')
  })

  it('keeps a bored exercise out of pools until its snooze expires', async () => {
    installDb({
      catalog: [
        { ...catalog[0], snoozed_until: '2999-01-01T00:00:00.000Z' },
        { ...catalog[1], snoozed_until: null },
      ],
    })
    const ctx = await assembleCoachContext(true)
    expect(ctx.staleness.stalest).not.toContain('Barbell Bench Press')
    expect(ctx.staleness.stalest).toContain('Cable Fly')
  })

  it('normalizes mixed-unit recent sets before choosing and labeling the top weight', async () => {
    installDb({
      recentSets: [
        {
          workout_id: 'w1',
          date: '2026-07-09',
          workout_name: 'Push',
          exercise_name: 'Bench Press',
          weight: 210,
          unit: 'lb',
          reps: 5,
        },
        {
          workout_id: 'w1',
          date: '2026-07-09',
          workout_name: 'Push',
          exercise_name: 'Bench Press',
          weight: 100,
          unit: 'kg',
          reps: 5,
        },
      ],
    })

    const ctx = await assembleCoachContext(true)

    expect(ctx.recentWorkouts[0]?.exercises[0]?.lastSets).toBe('2×5@220.46lb')
  })

  it('counts split physical rows once in recent workout summaries', async () => {
    installDb({
      recentSets: [
        {
          workout_id: 'w1', date: '2026-07-09', workout_name: 'Pull',
          exercise_name: 'Bayesian Curl', weight: 42.5, unit: 'lb', reps: 10,
          logical_set_id: 'round-1',
        },
        {
          workout_id: 'w1', date: '2026-07-09', workout_name: 'Pull',
          exercise_name: 'Bayesian Curl', weight: 42.5, unit: 'lb', reps: 10,
          logical_set_id: 'round-1',
        },
        {
          workout_id: 'w1', date: '2026-07-09', workout_name: 'Pull',
          exercise_name: 'Bayesian Curl', weight: 45, unit: 'lb', reps: 10,
          logical_set_id: 'round-2',
        },
      ],
    })

    const ctx = await assembleCoachContext(true)

    expect(ctx.recentWorkouts[0]?.exercises[0]?.lastSets).toBe('2×10@45lb')
    const recentQuery = mockExecute.mock.calls
      .map(([arg]) => collapseWs(sqlText(arg)))
      .find((query) => /w\.id IN/.test(query))
    expect(recentQuery).toContain('ws.logical_set_id')
  })

  it('keeps legacy recent rows without logical ids separate', async () => {
    installDb({
      recentSets: [
        {
          workout_id: 'w1', date: '2026-07-09', workout_name: 'Pull',
          exercise_name: 'Curl', weight: 40, unit: 'lb', reps: 12,
          logical_set_id: null,
        },
        {
          workout_id: 'w1', date: '2026-07-09', workout_name: 'Pull',
          exercise_name: 'Curl', weight: 40, unit: 'lb', reps: 12,
          logical_set_id: null,
        },
      ],
    })

    const ctx = await assembleCoachContext(true)

    expect(ctx.recentWorkouts[0]?.exercises[0]?.lastSets).toBe('2×12@40lb')
  })
})

describe('goal target normalization', () => {
  it('keeps the planner canonical while accepting targets entered in kilograms', () => {
    expect(metaTargetLb({ target_value: 100, unit: 'kg' })).toBe(220.5)
    expect(metaTargetLb({ target_value: 225, unit: 'lb' })).toBe(225)
  })
})
