/**
 * History read layer (lib/gym/history-read.ts, P2b). Two kinds of coverage:
 *   1. PURE: buildEras collapses chronological sessions into contiguous same-
 *      template runs (the program-era bands). Tested directly, no DB.
 *   2. DB glue: readHistory / readSessionDetail against a mocked db.execute — assert
 *      the §3b completed-status filter is on EVERY query, the volume/exclusion math,
 *      pagination hasMore, calendar shaping, and the 404 (null) on a non-completed
 *      session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sqlText, collapseWs, STATUS_COMPLETED_RE } from './sql-text'

const mockExecute = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/client', () => ({ db: { execute: mockExecute } }))

const {
  buildEras,
  readHistory,
  readSessionDetail,
  detectPerformedSupersets,
  rankCompletionOrder,
  completedSpanSeconds,
  MIN_ALTERNATING_SETS,
  MAX_TRANSITION_GAP_SECONDS,
} = await import('../history-read')

beforeEach(() => mockExecute.mockReset())

/** Collect every SQL statement db.execute was called with, as collapsed text. */
function firedSql(): string[] {
  return mockExecute.mock.calls.map(([arg]) => collapseWs(sqlText(arg)))
}

// ── PURE: buildEras ──────────────────────────────────────────────────────────
describe('buildEras (pure)', () => {
  it('collapses a contiguous same-template run into one era', () => {
    const eras = buildEras([
      { started_at: '2026-01-01T10:00:00Z', template_id: 't1', template_name: 'Day 1' },
      { started_at: '2026-01-08T10:00:00Z', template_id: 't1', template_name: 'Day 1' },
      { started_at: '2026-01-15T10:00:00Z', template_id: 't1', template_name: 'Day 1' },
    ])
    expect(eras).toHaveLength(1)
    expect(eras[0]).toEqual({
      templateId: 't1',
      templateName: 'Day 1',
      firstDate: '2026-01-01T10:00:00Z',
      lastDate: '2026-01-15T10:00:00Z',
      sessions: 3,
    })
  })

  it('starts a NEW era when the template changes', () => {
    const eras = buildEras([
      { started_at: '2026-01-01T00:00:00Z', template_id: 't1', template_name: 'Push' },
      { started_at: '2026-02-01T00:00:00Z', template_id: 't2', template_name: 'Pull' },
    ])
    expect(eras.map((e) => e.templateId)).toEqual(['t1', 't2'])
    expect(eras.map((e) => e.sessions)).toEqual([1, 1])
  })

  it('switching back to an earlier template opens ANOTHER band (runs are contiguous)', () => {
    const eras = buildEras([
      { started_at: '2026-01-01T00:00:00Z', template_id: 't1', template_name: 'A' },
      { started_at: '2026-01-08T00:00:00Z', template_id: 't2', template_name: 'B' },
      { started_at: '2026-01-15T00:00:00Z', template_id: 't1', template_name: 'A' },
    ])
    expect(eras.map((e) => e.templateId)).toEqual(['t1', 't2', 't1'])
    expect(eras).toHaveLength(3)
  })

  it('bands consecutive no-template (imported) sessions into one null era', () => {
    const eras = buildEras([
      { started_at: '2025-01-01T00:00:00Z', template_id: null, template_name: null },
      { started_at: '2025-01-05T00:00:00Z', template_id: null, template_name: null },
    ])
    expect(eras).toHaveLength(1)
    expect(eras[0]!.templateId).toBeNull()
    expect(eras[0]!.sessions).toBe(2)
  })

  it('empty input → empty', () => {
    expect(buildEras([])).toEqual([])
  })
})

// ── rankCompletionOrder / completedSpanSeconds (pure) ────────────────────────
describe('rankCompletionOrder (pure)', () => {
  it('ranks by completed_at ascending, independent of input order', () => {
    const order = rankCompletionOrder([
      { workoutExerciseId: 'we1', setId: 'c', completedAt: '2026-08-30T10:10:00Z' },
      { workoutExerciseId: 'we1', setId: 'a', completedAt: '2026-08-30T10:00:00Z' },
      { workoutExerciseId: 'we2', setId: 'b', completedAt: '2026-08-30T10:05:00Z' },
    ])
    expect(order.get('a')).toBe(1)
    expect(order.get('b')).toBe(2)
    expect(order.get('c')).toBe(3)
  })

  it('a tied timestamp (e.g. an L/R pair saved together) keeps input order, not a shuffle', () => {
    const order = rankCompletionOrder([
      { workoutExerciseId: 'we1', setId: 'left', completedAt: '2026-08-30T10:00:00Z' },
      { workoutExerciseId: 'we1', setId: 'right', completedAt: '2026-08-30T10:00:00Z' },
    ])
    expect(order.get('left')).toBe(1)
    expect(order.get('right')).toBe(2)
  })
})

describe('completedSpanSeconds (pure)', () => {
  it('returns the first-to-last span in whole seconds', () => {
    expect(completedSpanSeconds(['2026-08-30T10:00:00Z', '2026-08-30T10:06:00Z'])).toBe(360)
  })

  it('is order-independent (min/max, not first/last in array order)', () => {
    expect(completedSpanSeconds(['2026-08-30T10:06:00Z', '2026-08-30T10:00:00Z'])).toBe(360)
  })

  it('returns null with fewer than two timestamps — nothing was measured', () => {
    expect(completedSpanSeconds([])).toBeNull()
    expect(completedSpanSeconds(['2026-08-30T10:00:00Z'])).toBeNull()
  })
})

// ── detectPerformedSupersets (pure) — GYM #1792 ──────────────────────────────
// The threshold (MIN_ALTERNATING_SETS=4, MAX_TRANSITION_GAP_SECONDS=300s) must
// tell a genuine repeated circuit apart from a single wander-back-to-a-machine.
describe('detectPerformedSupersets (pure)', () => {
  /** completedAt N minutes after a fixed base, as an ISO string. */
  const at = (minutes: number) => new Date(Date.UTC(2026, 7, 30, 10, 0, 0) + minutes * 60_000).toISOString()

  it('detects a genuinely interleaved session (A,B,A,B — the pattern repeats)', () => {
    const found = detectPerformedSupersets([
      {
        workoutExerciseId: 'we-row', name: 'Cable Row',
        completedSets: [
          { workoutExerciseId: 'we-row', setId: 'row-1', completedAt: at(0) },
          { workoutExerciseId: 'we-row', setId: 'row-2', completedAt: at(4) },
        ],
      },
      {
        workoutExerciseId: 'we-press', name: 'Shoulder Press',
        completedSets: [
          { workoutExerciseId: 'we-press', setId: 'press-1', completedAt: at(2) },
          { workoutExerciseId: 'we-press', setId: 'press-2', completedAt: at(6) },
        ],
      },
    ])
    expect(found).toEqual([
      {
        exerciseAId: 'we-row', exerciseAName: 'Cable Row',
        exerciseBId: 'we-press', exerciseBName: 'Shoulder Press',
        alternatingSets: 4,
      },
    ])
  })

  it('does NOT flag a session that merely revisits one exercise once (A,B,A — 3 sets, no repeat)', () => {
    const found = detectPerformedSupersets([
      {
        workoutExerciseId: 'we-squat', name: 'Squat',
        completedSets: [
          { workoutExerciseId: 'we-squat', setId: 'squat-1', completedAt: at(0) },
          { workoutExerciseId: 'we-squat', setId: 'squat-2', completedAt: at(8) },
        ],
      },
      {
        workoutExerciseId: 'we-stretch', name: 'Calf Stretch',
        // Walked over to stretch mid-squat-session once, then came back — a
        // single alternation, exactly the "wandering back" case the threshold
        // must reject (MIN_ALTERNATING_SETS requires the pattern to repeat).
        completedSets: [
          { workoutExerciseId: 'we-stretch', setId: 'stretch-1', completedAt: at(4) },
        ],
      },
    ])
    expect(found).toEqual([])
  })

  it('does NOT flag two sequential blocks (A,A,B,B) even though both exercises ran back-to-back', () => {
    const found = detectPerformedSupersets([
      {
        workoutExerciseId: 'we-a', name: 'Lat Pulldown',
        completedSets: [
          { workoutExerciseId: 'we-a', setId: 'a-1', completedAt: at(0) },
          { workoutExerciseId: 'we-a', setId: 'a-2', completedAt: at(2) },
        ],
      },
      {
        workoutExerciseId: 'we-b', name: 'Face Pull',
        completedSets: [
          { workoutExerciseId: 'we-b', setId: 'b-1', completedAt: at(4) },
          { workoutExerciseId: 'we-b', setId: 'b-2', completedAt: at(6) },
        ],
      },
    ])
    expect(found).toEqual([])
  })

  it('does NOT flag an alternating pair when the transition gap exceeds MAX_TRANSITION_GAP_SECONDS', () => {
    const bigGapMinutes = MAX_TRANSITION_GAP_SECONDS / 60 + 5
    const found = detectPerformedSupersets([
      {
        workoutExerciseId: 'we-a', name: 'A',
        completedSets: [
          { workoutExerciseId: 'we-a', setId: 'a-1', completedAt: at(0) },
          // Same exercise resurfaces much later — a separate block, not a
          // continuous circuit, even though the A/B/A/B shape is there.
          { workoutExerciseId: 'we-a', setId: 'a-2', completedAt: at(2 + bigGapMinutes) },
        ],
      },
      {
        workoutExerciseId: 'we-b', name: 'B',
        completedSets: [
          { workoutExerciseId: 'we-b', setId: 'b-1', completedAt: at(1) },
          { workoutExerciseId: 'we-b', setId: 'b-2', completedAt: at(3 + bigGapMinutes) },
        ],
      },
    ])
    expect(found).toEqual([])
  })

  it('requires MIN_ALTERNATING_SETS to equal 4 (documents the chosen threshold)', () => {
    expect(MIN_ALTERNATING_SETS).toBe(4)
  })
})

// ── readHistory (mocked db) ──────────────────────────────────────────────────
describe('readHistory', () => {
  function installFourReads(opts: {
    calendar?: unknown[]
    weeks?: unknown[]
    sessions?: unknown[]
    eras?: unknown[]
  } = {}) {
    // readHistory fires calendar, weeks, sessions, eras in Promise.all — order of
    // resolution isn't guaranteed, so dispatch by SQL text.
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/array_agg\(w\.id/.test(q)) return Promise.resolve({ rows: opts.calendar ?? [] })
      if (/generate_series/.test(q)) return Promise.resolve({ rows: opts.weeks ?? [] })
      if (/ORDER BY w\.started_at DESC/.test(q)) return Promise.resolve({ rows: opts.sessions ?? [] })
      if (/ORDER BY w\.started_at ASC/.test(q)) return Promise.resolve({ rows: opts.eras ?? [] })
      return Promise.resolve({ rows: [] })
    })
  }

  it('§3b: every query filters to completed workouts', async () => {
    installFourReads()
    await readHistory({ month: '2026-07' })
    const queries = firedSql()
    expect(queries.length).toBe(4)
    for (const q of queries) {
      expect(q).toMatch(STATUS_COMPLETED_RE)
    }
    const weeksQuery = queries.find((q) => /generate_series/.test(q))
    const sessionsQuery = queries.find((q) => /ORDER BY w\.started_at DESC/.test(q))
    expect(weeksQuery).toContain('ws.completed = true')
    expect(sessionsQuery).toContain('ws.completed = true')
  })

  it('shapes the calendar days with their workout ids + count', async () => {
    installFourReads({
      calendar: [{ day: '2026-07-08', ids: ['w1', 'w2'] }, { day: '2026-07-10', ids: ['w3'] }],
    })
    const out = await readHistory({ month: '2026-07' })
    expect(out.calendar).toEqual([
      { date: '2026-07-08', workoutIds: ['w1', 'w2'], count: 2 },
      { date: '2026-07-10', workoutIds: ['w3'], count: 1 },
    ])
  })

  it('shapes weekly bars, rounding volume', async () => {
    installFourReads({
      weeks: [
        { week_start: '2026-06-29', workouts: 3, volume: '12340.6' },
        { week_start: '2026-07-06', workouts: 0, volume: 0 },
      ],
    })
    const out = await readHistory({})
    expect(out.weeks).toEqual([
      { weekStart: '2026-06-29', workouts: 3, volumeLb: 12341, volume: 12341 },
      { weekStart: '2026-07-06', workouts: 0, volumeLb: 0, volume: 0 },
    ])
    expect(out.weightUnit).toBe('lb')
  })

  it('paginates: limit rows returned, hasMore reflects the +1 probe', async () => {
    // Ask for limit 2; return 3 rows → hasMore true, only 2 surface.
    const rows = [1, 2, 3].map((i) => ({
      id: `w${i}`,
      name: `S${i}`,
      started_at: `2026-07-0${i}T00:00:00Z`,
      duration_seconds: 3600,
      template_id: null,
      template_name: null,
      exercise_count: 4,
      set_count: 12,
      volume: '5000',
    }))
    installFourReads({ sessions: rows })
    const out = await readHistory({ limit: 2 })
    expect(out.sessions).toHaveLength(2)
    expect(out.hasMore).toBe(true)
    expect(out.sessions[0]).toMatchObject({
      id: 'w1',
      volumeLb: 5000,
      volume: 5000,
      setCount: 12,
      exerciseCount: 4,
    })
  })

  it('uses a stable id tie-breaker when two sessions share a start time', async () => {
    installFourReads()
    await readHistory({ offset: 20, limit: 20 })
    const sessionsQuery = firedSql().find((q) => /ORDER BY w\.started_at DESC/.test(q))
    expect(sessionsQuery).toMatch(/ORDER BY w\.started_at DESC, w\.id DESC/)
  })

  it('hasMore false when the page is not full', async () => {
    installFourReads({
      sessions: [
        { id: 'w1', name: null, started_at: '2026-07-01T00:00:00Z', duration_seconds: null, template_id: null, template_name: null, exercise_count: 1, set_count: 3, volume: '100' },
      ],
    })
    const out = await readHistory({ limit: 20 })
    expect(out.hasMore).toBe(false)
    expect(out.sessions).toHaveLength(1)
  })

  it('does NOT compute prCount in the list (optional-cheap skip)', async () => {
    installFourReads({
      sessions: [
        { id: 'w1', name: 'S', started_at: '2026-07-01T00:00:00Z', duration_seconds: 3600, template_id: 't', template_name: 'Push', exercise_count: 5, set_count: 15, volume: '9000' },
      ],
    })
    const out = await readHistory({})
    expect(out.sessions[0]!.prCount).toBeUndefined()
  })

  it('a bad month string falls back rather than throwing', async () => {
    installFourReads()
    await expect(readHistory({ month: 'garbage' })).resolves.toBeDefined()
  })

  it('converts list and weekly volume to kilograms without changing canonical lb volume', async () => {
    installFourReads({
      weeks: [{ week_start: '2026-07-06', workouts: 2, volume: 22046.226218 }],
      sessions: [
        {
          id: 'w1',
          name: 'Push',
          started_at: '2026-07-08T00:00:00Z',
          duration_seconds: 3600,
          template_id: null,
          template_name: null,
          exercise_count: 4,
          set_count: 12,
          volume: 2204.6226218,
        },
      ],
    })

    const out = await readHistory({}, 'kg')

    expect(out.weightUnit).toBe('kg')
    expect(out.weeks[0]).toMatchObject({ volumeLb: 22046, volume: 10000 })
    expect(out.sessions[0]).toMatchObject({ volumeLb: 2205, volume: 1000 })
  })
})

// ── readSessionDetail (mocked db) ────────────────────────────────────────────
describe('readSessionDetail', () => {
  it('returns null when the workout row is missing / not completed (404)', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] }) // header read → empty
    const out = await readSessionDetail('nope')
    expect(out).toBeNull()
  })

  it('§3b: the header + set-log queries scope to completed', async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ id: 'w1', name: 'Push', started_at: '2026-07-08T09:00:00Z', duration_seconds: 3600, notes: null, template_id: null, template_name: null }],
      })
      .mockResolvedValueOnce({ rows: [] })
    await readSessionDetail('w1')
    const headerSql = collapseWs(sqlText(mockExecute.mock.calls[0]![0]))
    expect(headerSql).toMatch(STATUS_COMPLETED_RE)
  })

  it('groups sets by exercise, excludes warmups from volume + set count, converts kg', async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ id: 'w1', name: 'Leg Day', started_at: '2026-07-08T09:00:00Z', duration_seconds: 3600, notes: 'felt strong', template_id: 't1', template_name: 'Legs' }],
      })
      .mockResolvedValueOnce({
        rows: [
          // Squat: a warmup (excluded) + two working sets (100kg×5, 100kg×5).
          row({ we: 'we1', ex: 'e1', name: 'squat', tracks: 'weight_reps', setNumber: 1, setType: 'warmup', weight: '60', unit: 'kg', reps: 5, side: 'left' }),
          row({ we: 'we1', ex: 'e1', name: 'squat', tracks: 'weight_reps', setNumber: 2, setType: 'normal', weight: '100', unit: 'kg', reps: 5 }),
          row({ we: 'we1', ex: 'e1', name: 'squat', tracks: 'weight_reps', setNumber: 3, setType: 'normal', weight: '100', unit: 'kg', reps: 5 }),
          // An untouched prescription remains visible in the full log, but is
          // not performance and must not inflate completed-set aggregates.
          row({ we: 'we1', ex: 'e1', name: 'squat', tracks: 'weight_reps', setNumber: 4, setType: 'normal', weight: '200', unit: 'kg', reps: 10, completed: false }),
          // A second exercise with one working set in lb.
          row({ we: 'we2', ex: 'e2', name: 'Leg Press', tracks: 'weight_reps', setNumber: 1, setType: 'normal', weight: '300', unit: 'lb', reps: 10 }),
        ],
      })
    const out = await readSessionDetail('w1')
    expect(out).not.toBeNull()
    expect(out!.exercises).toHaveLength(2)
    // Working set count: 2 (squat) + 1 (leg press) = 3; the warmup is excluded.
    expect(out!.setCount).toBe(3)
    // Volume: 100kg×5×2 = 1000kg → 2204.62 lb; + 300×10 = 3000 lb → round(5204.62)=5205.
    expect(out!.volumeLb).toBe(5205)
    // Full detail preserves the warmup and untouched planned row for Repeat/UI.
    expect(out!.exercises[0]!.sets).toHaveLength(4)
    expect(out!.exercises[0]!.sets[0]!.side).toBe('left')
    expect(out!.exercises[0]!.name).toBe('Squat')
    expect(out!.exercises[0]!.sets[1]).toMatchObject({ weight: 220.46, unit: 'lb' })
    expect(out!.exercises[0]!.sets[3]).toMatchObject({ completed: false })
    expect(out!.notes).toBe('felt strong')
  })

  it('returns every set and volume in the selected display unit', async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ id: 'w1', name: 'Mixed', started_at: '2026-07-08T09:00:00Z', duration_seconds: 3600, notes: null, template_id: null, template_name: null }],
      })
      .mockResolvedValueOnce({
        rows: [
          row({ we: 'we1', ex: 'e1', name: 'Squat', tracks: 'weight_reps', setNumber: 1, weight: '220.46226218', unit: 'lb', reps: 5 }),
          row({ we: 'we1', ex: 'e1', name: 'Squat', tracks: 'weight_reps', setNumber: 2, weight: '100', unit: 'kg', reps: 5 }),
        ],
      })

    const out = await readSessionDetail('w1', 'kg')

    expect(out).toMatchObject({ weightUnit: 'kg', volumeLb: 2205, volume: 1000 })
    expect(out!.exercises[0]!.sets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ weight: 100, unit: 'kg' }),
      ]),
    )
  })

  it('counts split L/R rows as one set and keeps per-side Both volume equivalent', async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ id: 'w1', name: 'Arms', started_at: '2026-07-08T09:00:00Z', duration_seconds: 1800, notes: null, template_id: null, template_name: null }],
      })
      .mockResolvedValueOnce({
        rows: [
          row({ we: 'we1', ex: 'e1', name: 'Bayesian Bicep Curl', tracks: 'weight_reps', loadBasis: 'per_side', setNumber: 1, weight: '42.5', unit: 'lb', reps: 10, logicalSetId: 'both-1' }),
          row({ we: 'we1', ex: 'e1', name: 'Bayesian Bicep Curl', tracks: 'weight_reps', loadBasis: 'per_side', setNumber: 2, weight: '50', unit: 'lb', reps: 10, side: 'left', logicalSetId: 'split-2' }),
          row({ we: 'we1', ex: 'e1', name: 'Bayesian Bicep Curl', tracks: 'weight_reps', loadBasis: 'per_side', setNumber: 3, weight: '50', unit: 'lb', reps: 10, side: 'right', logicalSetId: 'split-2' }),
        ],
      })

    const out = await readSessionDetail('w1')

    expect(out).toMatchObject({ setCount: 2, volumeLb: 1850 })
    expect(out!.exercises[0]).toMatchObject({ loadBasis: 'per_side' })
    expect(out!.exercises[0]!.sets.map((set) => set.logicalSetId)).toEqual([
      'both-1',
      'split-2',
      'split-2',
    ])
  })

  it('returns each stored rest duration and preserves an unset rest as null', async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ id: 'w1', name: 'Push', started_at: '2026-07-08T09:00:00Z', duration_seconds: 3600, notes: null, template_id: null, template_name: null }],
      })
      .mockResolvedValueOnce({
        rows: [
          row({ we: 'we1', ex: 'e1', name: 'Bench', tracks: 'weight_reps', setNumber: 1, restSeconds: 90 }),
          row({ we: 'we1', ex: 'e1', name: 'Bench', tracks: 'weight_reps', setNumber: 2, restSeconds: null }),
        ],
      })

    const out = await readSessionDetail('w1')

    expect(collapseWs(sqlText(mockExecute.mock.calls[1]![0]))).toContain('ws.rest_seconds')
    expect(out!.exercises[0]!.sets.map((set) => set.restSeconds)).toEqual([90, null])
  })

  it('renders an exercise with zero logged sets cleanly (empty sets array)', async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ id: 'w1', name: null, started_at: '2026-01-01T00:00:00Z', duration_seconds: null, notes: null, template_id: null, template_name: null }],
      })
      .mockResolvedValueOnce({
        rows: [
          // LEFT JOIN produced a single row with null set fields (imported/empty ex).
          row({ we: 'we1', ex: 'e1', name: 'Plank', tracks: 'time', setNumber: null }),
        ],
      })
    const out = await readSessionDetail('w1')
    expect(out!.exercises).toHaveLength(1)
    expect(out!.exercises[0]!.sets).toEqual([])
    expect(out!.setCount).toBe(0)
    expect(out!.volumeLb).toBe(0)
  })

  // ── #1792: completionOrder / durationSeconds / performedSupersets end-to-end ──
  it('assigns completionOrder session-wide, a per-exercise durationSeconds, and detects a real superset', async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ id: 'w1', name: 'Circuit', started_at: '2026-08-30T10:00:00Z', duration_seconds: 900, notes: null, template_id: null, template_name: null }],
      })
      .mockResolvedValueOnce({
        rows: [
          // Cable Row and Shoulder Press alternate every ~2 minutes — a real
          // performed superset regardless of programmed order.
          row({ we: 'we1', ex: 'e1', name: 'Cable Row', tracks: 'weight_reps', setNumber: 1, completedAt: '2026-08-30T10:00:00Z' }),
          row({ we: 'we1', ex: 'e1', name: 'Cable Row', tracks: 'weight_reps', setNumber: 2, completedAt: '2026-08-30T10:04:00Z' }),
          row({ we: 'we2', ex: 'e2', name: 'Shoulder Press', tracks: 'weight_reps', setNumber: 1, completedAt: '2026-08-30T10:02:00Z' }),
          row({ we: 'we2', ex: 'e2', name: 'Shoulder Press', tracks: 'weight_reps', setNumber: 2, completedAt: '2026-08-30T10:06:00Z' }),
        ],
      })
    const out = await readSessionDetail('w1')

    // completionOrder reflects the ACTUAL sequence (row, press, row, press),
    // not the we.position/set_number order the rows were read in.
    expect(out!.exercises[0]!.sets.map((s) => s.completionOrder)).toEqual([1, 3])
    expect(out!.exercises[1]!.sets.map((s) => s.completionOrder)).toEqual([2, 4])

    // Each exercise's own first-to-last completed_at span.
    expect(out!.exercises[0]!.durationSeconds).toBe(240) // 10:00 → 10:04
    expect(out!.exercises[1]!.durationSeconds).toBe(240) // 10:02 → 10:06

    expect(out!.performedSupersets).toEqual([
      {
        exerciseAId: 'we1', exerciseAName: 'Cable Row',
        exerciseBId: 'we2', exerciseBName: 'Shoulder Press',
        alternatingSets: 4,
      },
    ])
  })

  it('does not detect a superset for a session that only revisits one exercise once', async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ id: 'w1', name: 'Push', started_at: '2026-08-30T10:00:00Z', duration_seconds: 1800, notes: null, template_id: null, template_name: null }],
      })
      .mockResolvedValueOnce({
        rows: [
          row({ we: 'we1', ex: 'e1', name: 'Bench', tracks: 'weight_reps', setNumber: 1, completedAt: '2026-08-30T10:00:00Z' }),
          row({ we: 'we1', ex: 'e1', name: 'Bench', tracks: 'weight_reps', setNumber: 2, completedAt: '2026-08-30T10:20:00Z' }),
          // One trip to a second exercise in between — a revisit, not a
          // repeating alternation. Must NOT be reported as a superset.
          row({ we: 'we2', ex: 'e2', name: 'Triceps Pushdown', tracks: 'weight_reps', setNumber: 1, completedAt: '2026-08-30T10:10:00Z' }),
        ],
      })
    const out = await readSessionDetail('w1')

    expect(out!.performedSupersets).toEqual([])
    // completionOrder and duration are still populated even without a
    // detected superset — the three signals are independent.
    expect(out!.exercises[0]!.sets.map((s) => s.completionOrder)).toEqual([1, 3])
    expect(out!.exercises[0]!.durationSeconds).toBe(1200) // 10:00 → 10:20
    expect(out!.exercises[1]!.durationSeconds).toBeNull() // one timestamp only
  })

  it('excludes a warmup from durationSeconds/performedSupersets but still ranks its completionOrder', async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ id: 'w1', name: 'Legs', started_at: '2026-08-30T10:00:00Z', duration_seconds: 1200, notes: null, template_id: null, template_name: null }],
      })
      .mockResolvedValueOnce({
        rows: [
          row({ we: 'we1', ex: 'e1', name: 'Squat', tracks: 'weight_reps', setNumber: 1, setType: 'warmup', completedAt: '2026-08-30T10:00:00Z' }),
          row({ we: 'we1', ex: 'e1', name: 'Squat', tracks: 'weight_reps', setNumber: 2, setType: 'normal', completedAt: '2026-08-30T10:05:00Z' }),
        ],
      })
    const out = await readSessionDetail('w1')

    // The warmup still gets a real completion rank (it happened first)...
    expect(out!.exercises[0]!.sets.map((s) => s.completionOrder)).toEqual([1, 2])
    // ...but a single WORKING timestamp means duration can't be measured.
    expect(out!.exercises[0]!.durationSeconds).toBeNull()
  })

  it('leaves completionOrder null for a set that was never completed', async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ id: 'w1', name: 'Push', started_at: '2026-08-30T10:00:00Z', duration_seconds: 600, notes: null, template_id: null, template_name: null }],
      })
      .mockResolvedValueOnce({
        rows: [
          row({ we: 'we1', ex: 'e1', name: 'Bench', tracks: 'weight_reps', setNumber: 1, completedAt: '2026-08-30T10:00:00Z' }),
          row({ we: 'we1', ex: 'e1', name: 'Bench', tracks: 'weight_reps', setNumber: 2, completed: false, completedAt: null }),
        ],
      })
    const out = await readSessionDetail('w1')
    expect(out!.exercises[0]!.sets.map((s) => s.completionOrder)).toEqual([1, null])
  })
})

/** A set-log join row with sane defaults. */
function row(o: {
  we: string
  ex: string
  name: string
  tracks: string
  setNumber: number | null
  setType?: string
  weight?: string | null
  unit?: string
  reps?: number | null
  restSeconds?: number | null
  side?: 'left' | 'right' | null
  completed?: boolean
  loadBasis?: 'total' | 'per_side'
  logicalSetId?: string | null
  completedAt?: string | null
}) {
  return {
    workout_exercise_id: o.we,
    exercise_id: o.ex,
    position: 0,
    superset_group: null,
    we_notes: null,
    name: o.name,
    tracks: o.tracks,
    load_basis: o.loadBasis ?? 'total',
    primary_muscle: null,
    set_number: o.setNumber,
    set_type: o.setType ?? null,
    weight: o.weight ?? null,
    unit: o.unit ?? null,
    reps: o.reps ?? null,
    distance_m: null,
    duration_s: null,
    rpe: null,
    rest_seconds: o.restSeconds ?? null,
    side: o.side ?? null,
    logical_set_id: o.logicalSetId ?? null,
    completed: o.setNumber == null ? null : (o.completed ?? true),
    completed_at: o.completedAt ?? null,
    seconds_since_previous_set: null,
  }
}
