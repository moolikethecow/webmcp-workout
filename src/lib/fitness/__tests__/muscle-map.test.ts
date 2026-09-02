/**
 * buildMuscleMap — folds raw (exercise, day, sets) rows through the TS muscle
 * mapping into per-region state, and joins the paired body measurement. Mocks
 * db.execute (two reads: workout rows, then measurement rows) so the JS fold +
 * measurement-averaging + state assignment is under test, not the SQL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExecute = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/client', () => ({ db: { execute: mockExecute } }))
// The gym-lane DDL is exercised elsewhere; a real call here would drain the
// mocked query queue with ~30 ALTER statements.
vi.mock('@/lib/db/ensure-fitness', () => ({
  ensureGymSchema: vi.fn().mockResolvedValue(undefined),
}))

const { buildMuscleMap, buildRegionSessions } = await import('../muscle-map')
const { firedSql, collapseWs, STATUS_COMPLETED_RE } = await import('@/lib/gym/__tests__/sql-text')

const NOW = new Date('2026-07-03T12:00:00Z')
const daysAgo = (n: number) => new Date(Date.UTC(2026, 6, 3 - n)).toISOString().slice(0, 10)

/** Answer buildMuscleMap's three reads BY CONTENT (they run in parallel, and
 *  the gym-schema ensure can reorder which fires first). The strength read
 *  carries `modality NOT IN`, the mobility read `modality IN`; everything else
 *  is the measurement read. */
function queue(dayRows: unknown[], measRows: unknown[], mobilityRows: unknown[] = []) {
  mockExecute.mockReset()
  mockExecute.mockImplementation((q: unknown) => {
    const text = JSON.stringify(q)
    if (text.includes('modality NOT IN')) return Promise.resolve({ rows: dayRows })
    if (text.includes('modality IN')) return Promise.resolve({ rows: mobilityRows })
    return Promise.resolve({ rows: measRows })
  })
}

beforeEach(() => vi.clearAllMocks())

describe('buildMuscleMap', () => {
  it('folds workout rows into region state and reports hasData', async () => {
    queue(
      [
        { name: 'Bench Press (Barbell)', primaryMuscle: null, day: daysAgo(1), sets: 4 },
        { name: 'Squat (Barbell)', primaryMuscle: null, day: daysAgo(4), sets: 5 },
      ],
      [],
    )
    const map = await buildMuscleMap(NOW)
    expect(map.hasData).toBe(true)
    // Bench 1d ago → chest recovering (primary), triceps gets secondary credit.
    expect(map.regions.chest.state).toBe('recovering')
    expect(map.regions.chest.daysSince).toBe(1)
    expect(map.regions.chest.exercises).toContain('Bench Press (Barbell)')
    // Squat 4d ago → quads ready.
    expect(map.regions.quads.state).toBe('ready')
    // A region nothing hit → untrained.
    expect(map.regions.calves.state).toBe('untrained')
  })

  it('weights secondary movers at half but still counts them as worked (triceps fix)', async () => {
    // Bench gives triceps a SECONDARY hit; it was never a PRIMARY mover, but it
    // WAS worked yesterday, so the recovery clock must reflect that.
    queue([{ name: 'Bench Press (Barbell)', primaryMuscle: null, day: daysAgo(1), sets: 4 }], [])
    const map = await buildMuscleMap(NOW)
    expect(map.regions.chest.weeklySets).toBe(4) // primary full credit
    expect(map.regions.triceps.weeklySets).toBe(2) // 4 * 0.5 secondary
    expect(map.regions.triceps.daysSince).toBe(1) // worked yesterday as a secondary
    expect(map.regions.triceps.daysSincePrimary).toBeNull() // but never trained directly
    expect(map.regions.triceps.lastPrimaryDate).toBeNull()
    expect(map.regions.triceps.state).toBe('recovering') // NOT untrained/ready
  })

  it('splits weekly vs prior-week volume for the trend arrow', async () => {
    queue(
      [
        { name: 'Barbell Curl', primaryMuscle: null, day: daysAgo(2), sets: 6 }, // this week
        { name: 'Barbell Curl', primaryMuscle: null, day: daysAgo(10), sets: 3 }, // prior week
      ],
      [],
    )
    const map = await buildMuscleMap(NOW)
    expect(map.regions.biceps.weeklySets).toBe(6)
    expect(map.regions.biceps.priorWeeklySets).toBe(3)
    expect(map.regions.biceps.volumeTrend).toBe(1)
  })

  it('joins + averages the paired body measurement (left/right) per region', async () => {
    queue(
      [{ name: 'Barbell Curl', primaryMuscle: null, day: daysAgo(1), sets: 4 }],
      [
        { metric: 'bicep_left', unit: 'cm', value: 40, date: '2026-01-01' },
        { metric: 'bicep_left', unit: 'cm', value: 42, date: '2026-06-01' },
        { metric: 'bicep_right', unit: 'cm', value: 41, date: '2026-06-01' },
      ],
    )
    const map = await buildMuscleMap(NOW)
    const m = map.regions.biceps.measurement!
    expect(m).not.toBeNull()
    expect(m.unit).toBe('cm')
    // latest: avg(bicep_left latest 42, bicep_right latest 41) = 41.5
    expect(m.latest).toBe(41.5)
    expect(m.label).toBe('Biceps')
  })

  it('converts stored cm readings to inches when the app is set to imperial (issue #1172)', async () => {
    queue(
      [{ name: 'Barbell Curl', primaryMuscle: null, day: daysAgo(1), sets: 4 }],
      [
        { metric: 'bicep_left', unit: 'cm', value: 40, date: '2026-01-01' },
        { metric: 'bicep_left', unit: 'cm', value: 42, date: '2026-06-01' },
        { metric: 'bicep_right', unit: 'cm', value: 41, date: '2026-06-01' },
      ],
    )
    const map = await buildMuscleMap(NOW, 'in')
    const m = map.regions.biceps.measurement!
    expect(m).not.toBeNull()
    expect(m.unit).toBe('in')
    // latest: avg(42cm, 41cm) = 41.5cm → 16.3in
    expect(m.latest).toBe(16.3)
  })

  it('reports hasData=false and all-untrained when there are no workouts', async () => {
    queue([], [])
    const map = await buildMuscleMap(NOW)
    expect(map.hasData).toBe(false)
    expect(Object.values(map.regions).every((r) => r.state === 'untrained')).toBe(true)
    expect(map.legend.length).toBeGreaterThan(0)
  })
})

describe('buildRegionSessions', () => {
  it('groups a region’s recent sets by workout → exercise, only exercises hitting it', async () => {
    mockExecute.mockReset()
    // A push day: bench (chest primary, triceps secondary) + a triceps pushdown.
    mockExecute.mockResolvedValueOnce({
      rows: [
        { workoutId: 'w1', day: daysAgo(1), workoutName: 'Push', exerciseName: 'Bench Press (Barbell)', primaryMuscle: null, position: 0, setNumber: 1, setType: 'warmup', weight: 95, reps: 10, unit: 'lb' },
        { workoutId: 'w1', day: daysAgo(1), workoutName: 'Push', exerciseName: 'Bench Press (Barbell)', primaryMuscle: null, position: 0, setNumber: 2, setType: 'normal', weight: 185, reps: 5, unit: 'lb' },
        // An empty placeholder row (no weight, no reps) — must be dropped.
        { workoutId: 'w1', day: daysAgo(1), workoutName: 'Push', exerciseName: 'Bench Press (Barbell)', primaryMuscle: null, position: 0, setNumber: 3, setType: 'normal', weight: 0, reps: 0, unit: 'lb' },
        { workoutId: 'w1', day: daysAgo(1), workoutName: 'Push', exerciseName: 'Squat (Barbell)', primaryMuscle: null, position: 1, setNumber: 1, setType: 'normal', weight: 225, reps: 5, unit: 'lb' },
        { workoutId: 'w1', day: daysAgo(1), workoutName: 'Push', exerciseName: 'Triceps Pushdown', primaryMuscle: null, position: 2, setNumber: 1, setType: 'normal', weight: 50, reps: 12, unit: 'lb' },
      ],
    })
    const sessions = await buildRegionSessions('triceps', NOW)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.workoutName).toBe('Push')
    // Squat is excluded (doesn't hit triceps); bench + pushdown included.
    expect(sessions[0]!.exercises.map((e) => e.name)).toEqual(['Bench Press (Barbell)', 'Triceps Pushdown'])
    const bench = sessions[0]!.exercises[0]!
    expect(bench.primary).toBe(false) // triceps is a SECONDARY on bench
    expect(bench.sets).toHaveLength(2) // the empty 0×0 placeholder row was dropped
    expect(bench.sets[0]).toMatchObject({ weight: 95, reps: 10, warmup: true })
    expect(sessions[0]!.exercises[1]!.primary).toBe(true) // pushdown IS a triceps primary
  })
})

// §3b (GYM_PLAN §3b): recovery/state math and the region drill-down read
// COMPLETED sessions only — a live ('active') set must not falsely mark a muscle
// "recovering" or appear in the tap-a-muscle log. Guard the SQL shape.
describe('muscle-map §3b status filter', () => {
  it('exerciseDayRows (recovery state) filters to status = completed', async () => {
    queue([], [])
    await buildMuscleMap(NOW)
    // The two reads race — pick the set-count read by content, not position.
    const dayRowsQuery = collapseWs(
      firedSql(mockExecute.mock.calls).find((s) => /FROM workout_sets/i.test(s))!,
    )
    expect(dayRowsQuery).toMatch(/FROM workout_sets/i)
    expect(dayRowsQuery).toMatch(STATUS_COMPLETED_RE)
    expect(dayRowsQuery).toContain('ws.completed = true')
  })

  it('buildRegionSessions (drill-down) filters to status = completed', async () => {
    mockExecute.mockReset()
    mockExecute.mockResolvedValueOnce({ rows: [] })
    await buildRegionSessions('chest', NOW)
    const sessionQuery = collapseWs(firedSql(mockExecute.mock.calls)[0]!)
    expect(sessionQuery).toMatch(/FROM workout_sets/i)
    expect(sessionQuery).toMatch(STATUS_COMPLETED_RE)
    expect(sessionQuery).toContain('ws.completed = true')
  })
})

// §10b.4 (GYM_PLAN §10): mobility work earns NO recovery credit and stays out
// of the strength drill-down — a logged stretch session must not mark a region
// "recovering". Guard the SQL shape like the §3b sweep above.
const MODALITY_EXCLUDED_RE = /modality NOT IN \('stretch', 'dynamic', 'soft_tissue'\)/

describe('muscle-map §10b.4 modality exclusion', () => {
  it('exerciseDayRows (recovery state) excludes mobility modalities', async () => {
    queue([], [])
    await buildMuscleMap(NOW)
    const dayRowsQuery = collapseWs(
      firedSql(mockExecute.mock.calls).find((s) => /FROM workout_sets/i.test(s))!,
    )
    expect(dayRowsQuery).toMatch(MODALITY_EXCLUDED_RE)
  })

  it('buildRegionSessions (drill-down) excludes mobility modalities', async () => {
    mockExecute.mockReset()
    mockExecute.mockResolvedValueOnce({ rows: [] })
    await buildRegionSessions('chest', NOW)
    const sessionQuery = collapseWs(firedSql(mockExecute.mock.calls)[0]!)
    expect(sessionQuery).toMatch(MODALITY_EXCLUDED_RE)
  })
})

// §10b.5: the mobility lens — weekly hold minutes per region, derived from
// logged mobility-modality sets only (the exact complement of the recovery read).
describe('muscle-map mobility minutes', () => {
  it('folds hold seconds into per-region weekly minutes with strength-style weights', async () => {
    queue(
      [],
      [],
      [
        // 480s of posterior-chain holds yesterday. Name deliberately matches no
        // keyword rule, so the catalog primary/secondaries drive the mapping —
        // the realistic shape for stretch names ("...pose", "...with rope").
        { name: 'reclining big toe pose with rope', primaryMuscle: 'hamstrings', secondaryMuscles: ['calves'], day: daysAgo(1), seconds: 480 },
        // 300s ten days ago → prior week bucket.
        { name: 'reclining big toe pose with rope', primaryMuscle: 'hamstrings', secondaryMuscles: [], day: daysAgo(10), seconds: 300 },
      ],
    )
    const map = await buildMuscleMap(NOW)
    // 480s = 8 min primary credit this week; prior week 5 min.
    expect(map.regions.hamstrings.mobilityMinutes).toBe(8)
    expect(map.regions.hamstrings.priorMobilityMinutes).toBe(5)
    expect(map.regions.hamstrings.daysSinceMobility).toBe(1)
    // Secondary credit at half weight.
    expect(map.regions.calves.mobilityMinutes).toBe(4)
    // Untouched region: zero, never.
    expect(map.regions.chest.mobilityMinutes).toBe(0)
    expect(map.regions.chest.daysSinceMobility).toBeNull()
    // Summary: 8 (ham) + 4 (calves) = 12 across 2 regions; target from the lib.
    expect(map.mobility.weekMinutes).toBe(12)
    expect(map.mobility.regionsWorked).toBe(2)
    expect(map.mobility.targetMinutes).toBe(10)
    // Mobility-only history still counts as data.
    expect(map.hasData).toBe(true)
  })

  it('§10b.9: joint stretches credit their joint region, not a nearby muscle', async () => {
    queue(
      [],
      [],
      [
        // A neck stretch would fold into Traps under the muscle mapper; the
        // joint-aware fold credits the Neck region instead.
        { name: 'neck side stretch', primaryMuscle: 'levator scapulae', secondaryMuscles: ['trapezius'], day: daysAgo(1), seconds: 300 },
        // An ankle drill credits Ankles (not Calves).
        { name: 'ankle dorsiflexion drill', primaryMuscle: null, secondaryMuscles: [], day: daysAgo(2), seconds: 120 },
      ],
    )
    const map = await buildMuscleMap(NOW)
    expect(map.regions.neck.mobilityMinutes).toBe(5) // 300s, full weight, joint region
    expect(map.regions.neck.daysSinceMobility).toBe(1)
    expect(map.regions.traps.mobilityMinutes).toBe(0) // NOT folded into Traps anymore
    expect(map.regions.ankles.mobilityMinutes).toBe(2)
    expect(map.regions.calves.mobilityMinutes).toBe(0)
  })

  it('reads ONLY mobility modalities, completed workouts only (SQL shape)', async () => {
    queue([], [], [])
    await buildMuscleMap(NOW)
    const mobilityQuery = collapseWs(
      firedSql(mockExecute.mock.calls).find((s) => /modality IN/.test(s) && !/NOT IN/.test(s))!,
    )
    expect(mobilityQuery).toMatch(/modality IN \('stretch', 'dynamic', 'soft_tissue'\)/)
    expect(mobilityQuery).toMatch(STATUS_COMPLETED_RE)
    expect(mobilityQuery).toContain('ws.completed = true')
    expect(mobilityQuery).toMatch(/duration_s/)
  })
})
