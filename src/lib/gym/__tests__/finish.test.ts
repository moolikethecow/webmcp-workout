/**
 * Finish flow (GYM_PLAN §4) — the load-bearing PR / habit / retain / empty-guard
 * logic. db.execute is mocked with a SQL-text dispatcher (the finish path fires
 * many sequential reads; matching on the query shape is far less brittle than a
 * fixed positional queue). logHabitForDate + enqueueRetain are mocked so we assert
 * the wiring: the finish calls the internal habit fn (never HTTP) idempotently and
 * enqueues exactly one health retain.
 *
 * The warmup-exclusion regression is the marquee test: a warmup HEAVIER than the
 * all-time working PR must NOT trigger a PR (records.ts drops warmups; finish
 * reuses that math).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sqlText, collapseWs } from './sql-text'

const mockExecute = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())
const mockLogHabit = vi.hoisted(() => vi.fn())
const mockEnqueueRetain = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db/client', () => ({ db: { execute: mockExecute, transaction: mockTransaction } }))
vi.mock('@/lib/habits', () => ({ logHabitForDate: mockLogHabit }))
vi.mock('@/lib/ai/retain-queue', () => ({ enqueueRetain: mockEnqueueRetain }))
vi.mock('@/lib/today', () => ({
  getAppTimezone: vi.fn().mockResolvedValue('UTC'),
  todayInZone: vi.fn().mockReturnValue('2026-07-09'),
}))

const {
  applyTemplateUpdateForWorkout,
  finishSummaryForDisplay,
  finishWorkout,
  templateRestAfterUpdate,
} = await import('../finish')

const WORKOUT_ID = 'w-1'
const START = new Date(Date.now() - 60_000).toISOString() // ~1 min ago
const DAY = '2026-07-09'

describe('finishSummaryForDisplay', () => {
  it('converts volume and weighted PRs without mutating the canonical summary', () => {
    const canonical = {
      durationSeconds: 900,
      totalVolumeLb: 2_205,
      setsCompleted: 3,
      exercisesCompleted: 1,
      prs: [
        { exerciseName: 'Squat', kind: 'weight' as const, value: 220.5, unit: 'lb', prev: 198.4 },
        { exerciseName: 'Squat', kind: 'reps' as const, value: 8, unit: 'reps', prev: 6 },
      ],
      habitLogged: true,
      templateDiff: { verdict: 'unchanged' as const, canUpdate: false },
      sourceTemplate: null,
    }

    const displayed = finishSummaryForDisplay(canonical, 'kg')

    expect(displayed).toMatchObject({ totalVolume: 1000, weightUnit: 'kg' })
    expect(displayed.prs[0]).toMatchObject({ value: 100, prev: 90, unit: 'kg' })
    expect(displayed.prs[1]).toEqual(canonical.prs[1])
    expect(canonical.totalVolumeLb).toBe(2_205)
    expect(canonical.prs[0]!.unit).toBe('lb')
  })
})

/** One row of the finish session read. */
interface Row {
  workout_id: string
  template_id: string | null
  workout_name: string | null
  started_at: string
  exercise_id: string
  exercise_name: string
  tracks: string
  load_basis: string
  we_position: number
  we_superset: number | null
  exercise_rest_seconds: number | null
  exercise_rest_seconds_warmup: number | null
  section: string
  exercise_notes: string | null
  set_number: number | null
  set_type: string
  weight: string | null
  unit: string
  reps: number | null
  distance_m: string | null
  duration_s: number | null
  rpe: string | null
  prescribed_weight: string | null
  prescribed_weight_unit: string
  prescribed_reps: number | null
  prescribed_distance_m: string | null
  prescribed_duration_s: number | null
  prescribed_rpe: string | null
  rest_seconds: number | null
  side: string | null
  logical_set_id: string | null
  completed: boolean
  workout_day: string
}

const row = (o: Partial<Row>): Row => ({
  workout_id: WORKOUT_ID,
  template_id: null,
  workout_name: 'Push Day',
  started_at: START,
  exercise_id: 'ex-bench',
  exercise_name: 'Incline DB Press',
  tracks: 'weight_reps',
  load_basis: 'total',
  we_position: 0,
  we_superset: null,
  exercise_rest_seconds: null,
  exercise_rest_seconds_warmup: null,
  section: 'main',
  exercise_notes: null,
  set_number: 1,
  set_type: 'normal',
  weight: '100',
  unit: 'lb',
  reps: 8,
  distance_m: null,
  duration_s: null,
  rpe: null,
  prescribed_weight: null,
  prescribed_weight_unit: 'lb',
  prescribed_reps: null,
  prescribed_distance_m: null,
  prescribed_duration_s: null,
  prescribed_rpe: null,
  rest_seconds: null,
  side: null,
  logical_set_id: null,
  completed: true,
  workout_day: DAY,
  ...o,
})

/**
 * A SQL-text dispatcher for db.execute. Provide the session rows and the prior
 * history sets (per exercise); everything else returns an empty/benign result.
 */
function installDb(opts: {
  sessionRows: Row[]
  prior?: Record<string, Array<Record<string, unknown>>> // by exerciseId
  linkedHabitId?: string | null
  habitAlreadyLoggedToday?: boolean
  existingHabitManaged?: boolean
  flips?: boolean // whether the status flip returns a row (default true)
  templateRows?: Array<Record<string, unknown>>
}) {
  const flips = opts.flips ?? true
  mockExecute.mockReset()
  mockExecute.mockImplementation((arg: unknown) => {
    const q = collapseWs(sqlText(arg))

    // The big session read (JOIN workout_exercises + LEFT JOIN workout_sets).
    if (/FROM workouts w JOIN workout_exercises we/.test(q) && /w\.status = 'active'/.test(q)) {
      return Promise.resolve({ rows: opts.sessionRows })
    }
    // The status flip.
    if (/UPDATE workouts SET status = 'completed'/.test(q)) {
      return Promise.resolve({ rows: flips ? [{ id: WORKOUT_ID }] : [] })
    }
    // isActive probe.
    if (/SELECT status FROM workouts WHERE id/.test(q)) {
      return Promise.resolve({ rows: [{ status: 'active' }] })
    }
    // Prior history sets for PR comparison.
    if (/FROM workout_sets ws/.test(q) && /w\.id <>/.test(q)) {
      // Extract the exercise id is hard from text; return the union of prior sets.
      // Tests use a single exercise, so returning the one bucket is fine.
      const all = Object.values(opts.prior ?? {}).flat()
      return Promise.resolve({ rows: all })
    }
    // Linked habit lookup.
    if (/gym_linked_habit_id AS habit_id/.test(q)) {
      return Promise.resolve({ rows: [{ habit_id: opts.linkedHabitId ?? null }] })
    }
    // Habit-already-logged-today probe.
    if (/FROM habit_log WHERE habit_id/.test(q)) {
      return Promise.resolve({ rows: opts.habitAlreadyLoggedToday ? [{ id: 'habit-log-existing' }] : [] })
    }
    if (/SELECT 1 AS one FROM gym_habit_log_links/.test(q)) {
      return Promise.resolve({ rows: opts.existingHabitManaged ? [{ one: 1 }] : [] })
    }
    // Template shape (none by default).
    if (/FROM template_exercises/.test(q)) {
      return Promise.resolve({ rows: opts.templateRows ?? [] })
    }
    return Promise.resolve({ rows: [] })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockTransaction.mockReset()
  mockLogHabit.mockResolvedValue({ id: 'habit-log-new' })
})

describe('finishWorkout — empty guard', () => {
  it('422 when the active workout has no exercises/sets', async () => {
    installDb({ sessionRows: [] })
    const res = await finishWorkout(WORKOUT_ID)
    expect(res).toEqual({ ok: false, status: 422, error: 'empty workout' })
  })

  it('422 when no set is completed (only placeholder/uncompleted rows)', async () => {
    installDb({
      sessionRows: [row({ completed: false }), row({ set_type: 'normal', weight: null, reps: null, completed: true })],
    })
    const res = await finishWorkout(WORKOUT_ID)
    expect(res).toMatchObject({ ok: false, status: 422 })
  })

  it('404 when the workout is not active (lost the transition race)', async () => {
    // No session rows AND the isActive probe says not active.
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT status FROM workouts WHERE id/.test(q)) {
        return Promise.resolve({ rows: [{ status: 'completed' }] })
      }
      return Promise.resolve({ rows: [] })
    })
    const res = await finishWorkout(WORKOUT_ID)
    expect(res).toEqual({ ok: false, status: 404 })
  })
})

describe('finishWorkout — summary + volume', () => {
  it('computes volume, set + exercise counts (warmups excluded from volume)', async () => {
    installDb({
      sessionRows: [
        row({ set_type: 'warmup', weight: '45', reps: 10 }), // excluded from volume
        row({ weight: '100', reps: 8 }),
        row({ weight: '100', reps: 8 }),
      ],
    })
    const res = await finishWorkout(WORKOUT_ID)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // volume = 100*8 + 100*8 = 1600 (warmup 45*10 not counted).
    expect(res.summary.totalVolumeLb).toBe(1600)
    expect(res.summary.setsCompleted).toBe(3) // all completed rows count as sets
    expect(res.summary.exercisesCompleted).toBe(1)
    expect(res.summary.durationSeconds).toBeGreaterThan(0)
  })

  it('does not flag a target change when logged kg equals the stored lb target', async () => {
    installDb({
      sessionRows: [row({ template_id: 'tpl-1', weight: '100', unit: 'kg', reps: 8 })],
      templateRows: [{
        exercise_id: 'ex-bench', position: 0, superset_group: null,
        target_sets: 1, target_reps: 8, target_weight: '220.46',
        target_weight_unit: 'lb', progression: null,
      }],
    })
    const res = await finishWorkout(WORKOUT_ID)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.summary.templateDiff.verdict).toBe('unchanged')
  })

  it('does not mistake unchecked prescribed rows for deleted template sets', async () => {
    installDb({
      sessionRows: [1, 2, 3, 4].map((setNumber) => row({
        template_id: 'tpl-1',
        set_number: setNumber,
        weight: setNumber === 1 ? '100' : null,
        reps: setNumber === 1 ? 8 : null,
        prescribed_weight: '100',
        prescribed_weight_unit: 'lb',
        prescribed_reps: 8,
        completed: setNumber === 1,
      })),
      templateRows: [1, 2, 3, 4].map((setNumber) => ({
        exercise_id: 'ex-bench', position: 0, superset_group: null,
        target_sets: 4, target_reps: 8, target_weight: '100',
        target_weight_unit: 'lb', target_duration_s: null,
        rest_seconds: null, rest_seconds_warmup: null,
        exercise_default_rest_seconds: null,
        exercise_default_rest_seconds_warmup: null,
        section: 'main', progression: null, notes: null,
        set_number: setNumber, set_type: 'normal',
        set_target_weight: '100', set_target_weight_unit: 'lb',
        set_target_reps: 8, set_target_distance_m: null,
        set_target_duration_s: null, set_target_rpe: null,
        set_rest_seconds: null, set_side: null,
      })),
    })

    const res = await finishWorkout(WORKOUT_ID)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.summary.setsCompleted).toBe(1)
    expect(res.summary.templateDiff.verdict).toBe('unchanged')
  })

  it('flags an exact-only set change when scalar count/reps/weight still match', async () => {
    installDb({
      sessionRows: [1, 2, 3].map((setNumber) => row({
        template_id: 'tpl-1',
        set_number: setNumber,
        weight: '100',
        reps: 8,
        rpe: setNumber === 2 ? '9' : '8',
        rest_seconds: 90,
      })),
      templateRows: [1, 2, 3].map((setNumber) => ({
        exercise_id: 'ex-bench', position: 0, superset_group: null,
        target_sets: 3, target_reps: 8, target_weight: '100',
        target_weight_unit: 'lb', target_duration_s: null,
        rest_seconds: null, rest_seconds_warmup: null,
        exercise_default_rest_seconds: null,
        exercise_default_rest_seconds_warmup: null,
        section: 'main', progression: null, notes: null,
        set_number: setNumber, set_type: 'normal',
        set_target_weight: '100', set_target_weight_unit: 'lb',
        set_target_reps: 8, set_target_distance_m: null,
        set_target_duration_s: null, set_target_rpe: '8',
        set_rest_seconds: 90, set_side: null,
      })),
    })

    const res = await finishWorkout(WORKOUT_ID)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.summary.templateDiff.verdict).toBe('values_changed')
  })
})

describe('templateRestAfterUpdate', () => {
  it('keeps an inherited exercise default inherited when the snapshot is unchanged', () => {
    expect(templateRestAfterUpdate({
      mode: 'values',
      previousExplicit: null,
      previousDefault: 120,
      logged: 120,
    })).toBeNull()
  })

  it('retains a real live rest edit and lets an explicit value be cleared', () => {
    expect(templateRestAfterUpdate({
      mode: 'both',
      previousExplicit: null,
      previousDefault: 120,
      logged: 90,
    })).toBe(90)
    expect(templateRestAfterUpdate({
      mode: 'values',
      previousExplicit: 120,
      previousDefault: null,
      logged: null,
    })).toBeNull()
  })

  it('keeps old metadata in structure-only mode and seeds a new exercise', () => {
    expect(templateRestAfterUpdate({
      mode: 'structure',
      previousExplicit: 120,
      previousDefault: null,
      logged: 60,
    })).toBe(120)
    expect(templateRestAfterUpdate({ mode: 'structure', logged: 60 })).toBe(60)
  })
})

describe('applyTemplateUpdateForWorkout — exact template fidelity', () => {
  it.each(['values', 'both'] as const)(
    'mode %s preserves all four History-visible sets and canonicalizes weight',
    async (mode) => {
      mockExecute.mockImplementation((arg: unknown) => {
        const q = collapseWs(sqlText(arg))
        if (/SELECT template_id FROM workouts/.test(q)) {
          return Promise.resolve({ rows: [{ template_id: 'tpl-1' }] })
        }
        if (/FROM workouts w JOIN workout_exercises we/.test(q)) {
          return Promise.resolve({
            rows: Array.from({ length: 4 }, (_, index) => ({
              exercise_id: 'ex-bench', we_position: 0, we_superset: null,
              exercise_rest_seconds: 120, exercise_rest_seconds_warmup: 45,
              section: 'main', exercise_notes: 'Keep exact rows',
              set_number: index + 1, set_type: 'normal',
              weight: '100', unit: 'kg', reps: 8,
              distance_m: null, duration_s: null, rpe: '8',
              rest_seconds: 60 + index * 15, side: null,
            })),
          })
        }
        if (/FROM template_exercises/.test(q)) {
          return Promise.resolve({ rows: [{
            exercise_id: 'ex-bench', position: 0, superset_group: null,
            target_sets: 3, target_reps: 8, target_weight: '200',
            target_weight_unit: 'lb', target_duration_s: null,
            rest_seconds: 120, rest_seconds_warmup: 45, section: 'main',
            progression: null, notes: null, set_number: 1, set_type: 'normal',
            set_target_weight: '200', set_target_weight_unit: 'lb',
            set_target_reps: 8, set_target_distance_m: null,
            set_target_duration_s: null, set_target_rpe: null,
            set_rest_seconds: 120, set_side: null,
          }] })
        }
        return Promise.resolve({ rows: [] })
      })
      const txExecute = vi.fn().mockImplementation((query: unknown) => {
        const q = collapseWs(sqlText(query))
        if (/INSERT INTO template_exercises/.test(q)) {
          return Promise.resolve({ rows: [{ id: 'te-new' }] })
        }
        return Promise.resolve({ rows: [] })
      })
      mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) =>
        cb({ execute: txExecute }),
      )

      expect(await applyTemplateUpdateForWorkout(WORKOUT_ID, mode)).toBe(true)
      const sourceRead = mockExecute.mock.calls
        .map(([query]) => collapseWs(sqlText(query)))
        .find((query) => /FROM workouts w JOIN workout_exercises we/.test(query))
      expect(sourceRead).toMatch(/COALESCE\(ws\.weight, ws\.prescribed_weight\)/)
      expect(sourceRead).not.toMatch(/ws\.completed\s*=\s*true/)
      const insert = sqlText(txExecute.mock.calls[1]![0])
      expect(insert).toContain('target_weight_unit')
      expect(insert).toContain('target_weight')
      const exactSetInserts = txExecute.mock.calls
        .map(([query]) => collapseWs(sqlText(query)))
        .filter((query) => /INSERT INTO template_sets/.test(query))
      expect(exactSetInserts).toHaveLength(4)
    },
  )
})

describe('finishWorkout — PR detection', () => {
  it('flags an e1RM PR that beats all-time prior history', async () => {
    installDb({
      sessionRows: [row({ weight: '170', reps: 8 })], // e1RM = 170*(1+8/30) ≈ 215.3
      prior: { 'ex-bench': [{ set_type: 'normal', weight: '150', unit: 'lb', reps: 8, distance_m: null, duration_s: null, day: '2026-06-01' }] },
    })
    const res = await finishWorkout(WORKOUT_ID)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const e1rm = res.summary.prs.find((p) => p.kind === 'e1rm')
    expect(e1rm).toBeDefined()
    expect(e1rm!.exerciseName).toBe('Incline DB Press')
    expect(e1rm!.value).toBeGreaterThan(200)
    expect(e1rm!.prev).toBeGreaterThan(0)
  })

  it('WARMUP-EXCLUSION regression: a warmup heavier than the working PR does NOT trigger', async () => {
    installDb({
      // A monster warmup at 500 lb, and a modest working set at 100.
      sessionRows: [
        row({ set_type: 'warmup', weight: '500', reps: 1 }),
        row({ set_type: 'normal', weight: '100', reps: 5 }),
      ],
      // Prior all-time working best is 120 → the 100 working set is NOT a PR, and
      // the 500 warmup must be ignored entirely.
      prior: { 'ex-bench': [{ set_type: 'normal', weight: '120', unit: 'lb', reps: 5, distance_m: null, duration_s: null, day: '2026-06-01' }] },
    })
    const res = await finishWorkout(WORKOUT_ID)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // No weight/e1rm PR — the warmup was excluded, the working set didn't beat prior.
    expect(res.summary.prs.find((p) => p.kind === 'weight')).toBeUndefined()
    expect(res.summary.prs.find((p) => p.kind === 'e1rm')).toBeUndefined()
  })

  it('first-ever session → PR with prev:null, flagged isDebut', async () => {
    installDb({
      sessionRows: [row({ weight: '135', reps: 5 })],
      prior: {}, // no history
    })
    const res = await finishWorkout(WORKOUT_ID)
    if (!res.ok) throw new Error('expected ok')
    const weightPr = res.summary.prs.find((p) => p.kind === 'weight')
    expect(weightPr).toBeDefined()
    expect(weightPr!.prev).toBeNull()
    expect(weightPr!.isDebut).toBe(true)
  })

  it('a real PR against prior history is NOT flagged isDebut', async () => {
    installDb({
      sessionRows: [row({ weight: '170', reps: 8 })],
      prior: { 'ex-bench': [{ set_type: 'normal', weight: '150', unit: 'lb', reps: 8, distance_m: null, duration_s: null, day: '2026-06-01' }] },
    })
    const res = await finishWorkout(WORKOUT_ID)
    if (!res.ok) throw new Error('expected ok')
    const weightPr = res.summary.prs.find((p) => p.kind === 'weight')
    expect(weightPr).toBeDefined()
    expect(weightPr!.isDebut).toBe(false)
  })
})

describe('finishWorkout — habit auto-log (idempotent, internal fn)', () => {
  it('logs the linked habit via logHabitForDate when ≥1 working set + not yet logged', async () => {
    installDb({
      sessionRows: [row({ weight: '100', reps: 8 })],
      linkedHabitId: 'habit-gym',
      habitAlreadyLoggedToday: false,
    })
    const res = await finishWorkout(WORKOUT_ID)
    if (!res.ok) throw new Error('expected ok')
    expect(res.summary.habitLogged).toBe(true)
    expect(mockLogHabit).toHaveBeenCalledTimes(1)
    expect(mockLogHabit).toHaveBeenCalledWith(
      expect.objectContaining({ habit_id: 'habit-gym', completion_state: 'full', logged_via: 'app' }),
    )
    expect(mockExecute.mock.calls.some(([query]) =>
      /INSERT INTO gym_habit_log_links/.test(collapseWs(sqlText(query))),
    )).toBe(true)
  })

  it('does not claim or re-log a manual completion already present today', async () => {
    installDb({
      sessionRows: [row({ weight: '100', reps: 8 })],
      linkedHabitId: 'habit-gym',
      habitAlreadyLoggedToday: true,
    })
    const res = await finishWorkout(WORKOUT_ID)
    if (!res.ok) throw new Error('expected ok')
    expect(res.summary.habitLogged).toBe(true) // a log exists for today
    expect(mockLogHabit).not.toHaveBeenCalled() // but we didn't write a second one
    expect(mockExecute.mock.calls.some(([query]) =>
      /INSERT INTO gym_habit_log_links/.test(collapseWs(sqlText(query))),
    )).toBe(false)
  })

  it('adds another workout owner when today\'s completion was gym-created', async () => {
    installDb({
      sessionRows: [row({ weight: '100', reps: 8 })],
      linkedHabitId: 'habit-gym',
      habitAlreadyLoggedToday: true,
      existingHabitManaged: true,
    })
    const res = await finishWorkout(WORKOUT_ID)
    if (!res.ok) throw new Error('expected ok')
    expect(res.summary.habitLogged).toBe(true)
    expect(mockLogHabit).not.toHaveBeenCalled()
    expect(mockExecute.mock.calls.some(([query]) =>
      /INSERT INTO gym_habit_log_links/.test(collapseWs(sqlText(query))),
    )).toBe(true)
  })

  it('no linked habit → habitLogged false, no fn call', async () => {
    installDb({ sessionRows: [row({ weight: '100', reps: 8 })], linkedHabitId: null })
    const res = await finishWorkout(WORKOUT_ID)
    if (!res.ok) throw new Error('expected ok')
    expect(res.summary.habitLogged).toBe(false)
    expect(mockLogHabit).not.toHaveBeenCalled()
  })

  it('only warmups → no working set → habit not logged', async () => {
    installDb({
      sessionRows: [row({ set_type: 'warmup', weight: '45', reps: 10 })],
      linkedHabitId: 'habit-gym',
    })
    const res = await finishWorkout(WORKOUT_ID)
    if (!res.ok) throw new Error('expected ok')
    expect(res.summary.habitLogged).toBe(false)
    expect(mockLogHabit).not.toHaveBeenCalled()
  })
})

describe('finishWorkout — per-exercise load basis', () => {
  it('total-load rows count once and never read the retired global dumbbell toggle', async () => {
    installDb({ sessionRows: [row({ weight: '50', reps: 10, load_basis: 'total' })] })
    const res = await finishWorkout(WORKOUT_ID)
    if (!res.ok) throw new Error('expected ok')
    expect(res.summary.totalVolumeLb).toBe(500)
    expect(mockExecute.mock.calls.some(([query]) =>
      /gym_count_dumbbells_twice/.test(collapseWs(sqlText(query))),
    )).toBe(false)
  })

  it('per-side Both doubles physical volume but keeps one logical set', async () => {
    installDb({
      sessionRows: [row({
        weight: '42.5',
        reps: 10,
        load_basis: 'per_side',
        side: null,
        logical_set_id: 'round-both',
      })],
    })
    const res = await finishWorkout(WORKOUT_ID)
    if (!res.ok) throw new Error('expected ok')
    expect(res.summary.totalVolumeLb).toBe(850)
    expect(res.summary.setsCompleted).toBe(1)
  })

  it('paired L/R rows equal Both volume and count as one logical set', async () => {
    installDb({
      sessionRows: [
        row({
          set_number: 1,
          weight: '42.5',
          reps: 10,
          load_basis: 'per_side',
          side: 'left',
          logical_set_id: 'round-split',
        }),
        row({
          set_number: 2,
          weight: '42.5',
          reps: 10,
          load_basis: 'per_side',
          side: 'right',
          logical_set_id: 'round-split',
        }),
      ],
      prior: {},
    })
    const res = await finishWorkout(WORKOUT_ID)
    if (!res.ok) throw new Error('expected ok')
    expect(res.summary.totalVolumeLb).toBe(850)
    expect(res.summary.setsCompleted).toBe(1)
    expect(res.summary.prs.find((p) => p.kind === 'weight')?.value).toBe(42.5)
    expect(res.summary.prs.find((p) => p.kind === 'volume')?.value).toBe(850)
  })

  it('one explicit side contributes once', async () => {
    installDb({
      sessionRows: [row({
        weight: '42.5', reps: 10, load_basis: 'per_side', side: 'left',
      })],
    })
    const res = await finishWorkout(WORKOUT_ID)
    if (!res.ok) throw new Error('expected ok')
    expect(res.summary.totalVolumeLb).toBe(425)
  })
})

describe('finishWorkout — retain', () => {
  it('enqueues exactly one health retain with a deterministic summary', async () => {
    installDb({
      sessionRows: [row({ weight: '170', reps: 8 })],
      prior: { 'ex-bench': [{ set_type: 'normal', weight: '150', unit: 'lb', reps: 8, distance_m: null, duration_s: null, day: '2026-06-01' }] },
    })
    await finishWorkout(WORKOUT_ID)
    expect(mockEnqueueRetain).toHaveBeenCalledTimes(1)
    const [content, opts] = mockEnqueueRetain.mock.calls[0]!
    expect(content).toContain('Workout: Push Day')
    expect(content).toContain('lb volume')
    expect(opts).toMatchObject({ bank: 'health', surfaceInChat: false })
    expect(opts.documentId).toBe(`workout-${WORKOUT_ID}`)
  })

  it('a retain hiccup never fails the finish (fail-open)', async () => {
    mockEnqueueRetain.mockImplementation(() => {
      throw new Error('retain boom')
    })
    installDb({ sessionRows: [row({ weight: '100', reps: 8 })] })
    const res = await finishWorkout(WORKOUT_ID)
    expect(res.ok).toBe(true)
  })
})
