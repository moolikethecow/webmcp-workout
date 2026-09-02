/**
 * log_workout (GYM_PLAN §6) — post-hoc bulk entry. db.execute / db.transaction +
 * createExerciseWithFill + finishWorkout are mocked; we assert the WIRING, not the
 * PR/habit math (finish.test.ts owns that):
 *   - names resolve case-insensitively; an UNKNOWN name is created (fail-open
 *     LLM-fill lane) and reported as created;
 *   - the transaction inserts the workout (active), its exercises, and its
 *     COMPLETED sets, mapping the tool's set fields to columns; warmup set_type
 *     flows through; empty (no-data) sets are skipped;
 *   - finishWorkout is called ONCE with the new workout id (the side-effect reuse
 *     — PRs + habit + retain never duplicated here);
 *   - an all-empty session rolls the placeholder to 'discarded' and returns an
 *     error (never pollutes history).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sqlText } from './sql-text'

const mockExecute = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/client', () => ({
  db: { execute: mockExecute, transaction: mockTransaction },
}))
vi.mock('@/lib/db/ensure-fitness', () => ({
  ensureFitnessTables: vi.fn().mockResolvedValue(undefined),
  ensureGymSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/today', () => ({
  getAppTimezone: vi.fn().mockResolvedValue('UTC'),
  todayInZone: vi.fn().mockReturnValue('2026-07-10'),
}))

const mockCreateWithFill = vi.hoisted(() => vi.fn())
vi.mock('../exercise-detail', () => ({ createExerciseWithFill: mockCreateWithFill }))

const mockFinishWorkout = vi.hoisted(() => vi.fn())
vi.mock('../finish', () => ({ finishWorkout: mockFinishWorkout }))

const { logWorkout } = await import('../log-workout')

/** Build a tx.execute stub: INSERT workout → {id}, INSERT exercise → {id}, sets → []. */
function txStub(workoutId = 'w-1') {
  const tx = vi.fn()
  tx.mockImplementation((q: unknown) => {
    const text = sqlText(q)
    if (text.includes('INSERT INTO workouts')) return Promise.resolve({ rows: [{ id: workoutId }] })
    if (text.includes('INSERT INTO workout_exercises')) {
      return Promise.resolve({ rows: [{ id: `we-${tx.mock.calls.length}` }] })
    }
    return Promise.resolve({ rows: [] })
  })
  return tx
}

function uuidParams(value: unknown): string[] {
  if (typeof value === 'string') {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      ? [value]
      : []
  }
  if (Array.isArray(value)) return value.flatMap(uuidParams)
  if (value && typeof value === 'object' && 'queryChunks' in value) {
    const chunks = (value as { queryChunks?: unknown[] }).queryChunks
    return chunks ? chunks.flatMap(uuidParams) : []
  }
  return []
}

const FINISH_OK = {
  ok: true as const,
  summary: {
    durationSeconds: 0,
    totalVolumeLb: 5625,
    setsCompleted: 5,
    exercisesCompleted: 1,
    prs: [{ exerciseName: 'Squat (Barbell)', kind: 'e1rm' as const, value: 315, unit: 'lb', prev: 300 }],
    habitLogged: true,
    templateDiff: { verdict: 'unchanged' as const, canUpdate: false },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockExecute.mockResolvedValue({ rows: [] })
})

describe('logWorkout', () => {
  it('resolves an existing name, inserts a completed session, and reuses finishWorkout', async () => {
    // exactExercise name lookup → existing id.
    mockExecute.mockImplementation((q: unknown) => {
      const text = sqlText(q)
      if (text.includes('FROM exercises')) return Promise.resolve({ rows: [{ id: 'ex-squat' }] })
      return Promise.resolve({ rows: [] })
    })
    const tx = txStub('w-1')
    mockTransaction.mockImplementation(async (cb: (t: { execute: typeof tx }) => unknown) => cb({ execute: tx }))
    mockFinishWorkout.mockResolvedValue(FINISH_OK)

    const res = await logWorkout({
      name: 'Leg Day',
      exercises: [
        {
          exerciseName: 'Squat (Barbell)',
          sets: [
            { weight: 225, reps: 5, unit: 'lb' },
            { weight: 135, reps: 8, setType: 'warmup' },
          ],
        },
      ],
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.workoutId).toBe('w-1')
    expect(res.setsLogged).toBe(2)
    expect(res.exercises[0]).toMatchObject({ name: 'Squat (Barbell)', created: false, setCount: 2 })
    expect(res.prs[0]!.exerciseName).toBe('Squat (Barbell)')
    expect(res.habitLogged).toBe(true)

    // finishWorkout called ONCE with the new id (side-effect reuse).
    expect(mockFinishWorkout).toHaveBeenCalledOnce()
    expect(mockFinishWorkout).toHaveBeenCalledWith('w-1')

    // The workout was inserted 'active' + source 'app'.
    const insertWorkout = tx.mock.calls.find((c) => sqlText(c[0]).includes('INSERT INTO workouts'))
    expect(insertWorkout).toBeDefined()
    expect(sqlText(insertWorkout![0])).toMatch(/'active'/)
    expect(sqlText(insertWorkout![0])).toMatch(/'app'/)

    // Two set inserts (warmup flows through — finish handles the exclusion).
    const setInserts = tx.mock.calls.filter((c) => sqlText(c[0]).includes('INSERT INTO workout_sets'))
    expect(setInserts).toHaveLength(2)
    expect(sqlText(setInserts[0]![0])).toMatch(/completed/)
  })

  it('creates an unknown exercise via the fail-open fill lane and marks it created', async () => {
    mockExecute.mockResolvedValue({ rows: [] }) // no exact match → create path
    mockCreateWithFill.mockResolvedValue({
      detail: { exercise: { id: 'ex-nordic', name: 'Nordic Curl' } },
      created: true,
      aiFilled: true,
    })
    const tx = txStub('w-2')
    mockTransaction.mockImplementation(async (cb: (t: { execute: typeof tx }) => unknown) => cb({ execute: tx }))
    mockFinishWorkout.mockResolvedValue(FINISH_OK)

    const res = await logWorkout({
      exercises: [{ exerciseName: 'Nordic Curl', sets: [{ reps: 8 }] }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(mockCreateWithFill).toHaveBeenCalledWith('Nordic Curl')
    expect(res.exercises[0]).toMatchObject({ name: 'Nordic Curl', created: true })
  })

  it('skips empty (no-data) sets', async () => {
    mockExecute.mockImplementation((q: unknown) => {
      const text = sqlText(q)
      if (text.includes('FROM exercises')) return Promise.resolve({ rows: [{ id: 'ex-1' }] })
      return Promise.resolve({ rows: [] })
    })
    const tx = txStub('w-3')
    mockTransaction.mockImplementation(async (cb: (t: { execute: typeof tx }) => unknown) => cb({ execute: tx }))
    mockFinishWorkout.mockResolvedValue(FINISH_OK)

    const res = await logWorkout({
      exercises: [{ exerciseName: 'Bench', sets: [{ weight: 185, reps: 5 }, { reps: null, weight: null }] }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Only the one real set persisted.
    expect(res.setsLogged).toBe(1)
    const setInserts = tx.mock.calls.filter((c) => sqlText(c[0]).includes('INSERT INTO workout_sets'))
    expect(setInserts).toHaveLength(1)
  })

  it('logs adjacent opposite L/R rows as one logical set', async () => {
    mockExecute.mockImplementation((q: unknown) => {
      const text = sqlText(q)
      if (text.includes('FROM exercises')) return Promise.resolve({ rows: [{ id: 'ex-1' }] })
      return Promise.resolve({ rows: [] })
    })
    const tx = txStub('w-split')
    mockTransaction.mockImplementation(async (cb: (t: { execute: typeof tx }) => unknown) => cb({ execute: tx }))
    mockFinishWorkout.mockResolvedValue(FINISH_OK)

    const res = await logWorkout({
      exercises: [{
        exerciseName: 'Bayesian Curl',
        sets: [
          { weight: 42.5, reps: 10, side: 'left' },
          { weight: 42.5, reps: 10, side: 'right' },
          { weight: 45, reps: 10 },
          { weight: 40, reps: 12, side: 'right', setType: 'failure' },
          { weight: 40, reps: 12, side: 'left', setType: 'failure' },
        ],
      }],
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.setsLogged).toBe(3)
    expect(res.exercises[0]?.setCount).toBe(3)

    const setInserts = tx.mock.calls.filter((call) =>
      sqlText(call[0]).includes('INSERT INTO workout_sets'),
    )
    expect(setInserts).toHaveLength(5) // exact physical L/R rows remain
    expect(setInserts.every((call) => sqlText(call[0]).includes('logical_set_id'))).toBe(true)
    const ids = setInserts.map((call) => uuidParams(call[0])[0])
    expect(ids[0]).toBe(ids[1])
    expect(ids[1]).not.toBe(ids[2])
    expect(ids[3]).toBe(ids[4])
  })

  it('does not pair opposite sides across warmup and default-normal set types', async () => {
    mockExecute.mockImplementation((q: unknown) => {
      const text = sqlText(q)
      if (text.includes('FROM exercises')) return Promise.resolve({ rows: [{ id: 'ex-1' }] })
      return Promise.resolve({ rows: [] })
    })
    const tx = txStub('w-split-types')
    mockTransaction.mockImplementation(async (cb: (t: { execute: typeof tx }) => unknown) => cb({ execute: tx }))
    mockFinishWorkout.mockResolvedValue(FINISH_OK)

    const res = await logWorkout({
      exercises: [{
        exerciseName: 'Bayesian Curl',
        sets: [
          { weight: 20, reps: 12, side: 'left', setType: 'warmup' },
          { weight: 42.5, reps: 10, side: 'right' },
        ],
      }],
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.setsLogged).toBe(2)
    const inserts = tx.mock.calls.filter((call) =>
      sqlText(call[0]).includes('INSERT INTO workout_sets'),
    )
    const ids = inserts.map((call) => uuidParams(call[0])[0])
    expect(ids[0]).not.toBe(ids[1])
  })

  it('discards the placeholder and errors when every set is empty', async () => {
    mockExecute.mockImplementation((q: unknown) => {
      const text = sqlText(q)
      if (text.includes('FROM exercises')) return Promise.resolve({ rows: [{ id: 'ex-1' }] })
      return Promise.resolve({ rows: [] })
    })
    const tx = txStub('w-4')
    mockTransaction.mockImplementation(async (cb: (t: { execute: typeof tx }) => unknown) => cb({ execute: tx }))

    const res = await logWorkout({
      exercises: [{ exerciseName: 'Bench', sets: [{ reps: 0, weight: 0 }] }],
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/nothing to log/i)
    // finishWorkout NEVER runs on an empty session.
    expect(mockFinishWorkout).not.toHaveBeenCalled()
    // A discard UPDATE was issued for the placeholder.
    const discard = mockExecute.mock.calls.find((c) => sqlText(c[0]).includes("status = 'discarded'"))
    expect(discard).toBeDefined()
  })

  it('errors with no exercises', async () => {
    const res = await logWorkout({ exercises: [] })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/at least one exercise/i)
  })
})
