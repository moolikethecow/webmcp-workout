/**
 * Editing a COMPLETED workout (#1833).
 *
 * The case that forced this: pendulum squats logged under Hack Squat because
 * the catalog had no entry for them, permanently polluting BOTH movements'
 * records. Every operation is scoped to a completed session by a join, so a
 * wrong id cannot reach another workout and an ACTIVE session is untouchable.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockExecute = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/client', () => ({
  db: { execute: mockExecute, transaction: mockTransaction },
}))

import {
  moveCompletedSet,
  removeCompletedSet,
  renameCompletedWorkout,
  repointCompletedExercise,
  updateCompletedSetValues,
} from '../edit-completed'

const sqlOf = (call: unknown[]) => JSON.stringify(call[0] ?? '')
const lastSql = () => sqlOf(mockExecute.mock.calls[mockExecute.mock.calls.length - 1]!)

beforeEach(() => {
  mockExecute.mockReset()
  mockTransaction.mockReset()
  mockTransaction.mockImplementation((fn: (tx: { execute: typeof mockExecute }) => unknown) =>
    fn({ execute: mockExecute }),
  )
})

describe('every edit is scoped to a COMPLETED session', () => {
  // An active session belongs to edit_active_workout, which has its own
  // in-progress guards; reaching it from here would bypass them.
  it.each([
    ['rename', () => renameCompletedWorkout('w1', 'DAY 2')],
    ['repoint', () => repointCompletedExercise('w1', 'we1', 'ex1')],
    ['set values', () => updateCompletedSetValues('w1', 's1', { reps: 8 })],
    ['remove set', () => removeCompletedSet('w1', 's1')],
  ])('%s requires status completed', async (_label, run) => {
    mockExecute.mockResolvedValue({ rowCount: 1 })
    await run()
    expect(lastSql()).toContain('completed')
  })

  it.each([
    ['rename', () => renameCompletedWorkout('w1', 'DAY 2')],
    ['repoint', () => repointCompletedExercise('w1', 'we1', 'ex1')],
    ['set values', () => updateCompletedSetValues('w1', 's1', { reps: 8 })],
    ['remove set', () => removeCompletedSet('w1', 's1')],
  ])('%s reports a miss rather than claiming success', async (_label, run) => {
    mockExecute.mockResolvedValue({ rowCount: 0 })
    const res = await run()
    expect(res.ok).toBe(false)
    expect(res.changed).toBe(0)
    expect(res.error).toBeTruthy()
  })
})

describe('renameCompletedWorkout', () => {
  it('refuses a blank name without touching the database', async () => {
    const res = await renameCompletedWorkout('w1', '   ')
    expect(res.ok).toBe(false)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('trims before writing', async () => {
    mockExecute.mockResolvedValue({ rowCount: 1 })
    expect((await renameCompletedWorkout('w1', '  DAY 2  ')).ok).toBe(true)
  })
})

describe('updateCompletedSetValues is a PATCH', () => {
  // Replace-all here would silently blank whatever the caller omitted — the
  // exact failure #1830 raises about templates.
  it('touches only the fields passed', async () => {
    mockExecute.mockResolvedValue({ rowCount: 1 })
    await updateCompletedSetValues('w1', 's1', { reps: 8 })
    const text = lastSql()
    expect(text).toContain('reps')
    expect(text).not.toContain('rpe')
    expect(text).not.toContain('weight')
  })

  it('treats an explicit null as a clear, not an omission', async () => {
    mockExecute.mockResolvedValue({ rowCount: 1 })
    await updateCompletedSetValues('w1', 's1', { rpe: null })
    expect(lastSql()).toContain('rpe')
  })

  it('refuses an empty patch instead of running a no-op UPDATE', async () => {
    const res = await updateCompletedSetValues('w1', 's1', {})
    expect(res.ok).toBe(false)
    expect(mockExecute).not.toHaveBeenCalled()
  })
})

describe('removeCompletedSet', () => {
  // A gap is honest — it records that a set was removed. Resequencing would
  // rewrite numbers other rows already reference, including the logical_set_id
  // pairing that keeps a split L/R round counted once.
  it('does not renumber the surviving sets', async () => {
    mockExecute.mockResolvedValue({ rowCount: 1 })
    await removeCompletedSet('w1', 's1')
    const all = mockExecute.mock.calls.map(sqlOf).join(' ')
    expect(all).not.toMatch(/set_number\s*=/)
  })
})

/**
 * Moving ONE set: "move over that set too".
 *
 * His 2025-08-05 leg day logged 230, 230 and 90 lb under a single name — two
 * machines in one entry. `repointCompletedExercise` moves all three or none,
 * so either choice mislabels a set.
 */
describe('moveCompletedSet', () => {
  const found = (over: Record<string, unknown> = {}) => ({
    rows: [{ fromEntryId: 'we-src', logicalSetId: null, fromExerciseId: 'ex-hack', ...over }],
  })

  it('creates the destination entry, renumbers to its tail, and clears an emptied source', async () => {
    mockExecute
      .mockResolvedValueOnce(found())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'we-new' }] })
      .mockResolvedValueOnce({ rows: [{ next: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })

    const res = await moveCompletedSet('w1', 's-90', 'ex-pendulum')
    expect(res).toEqual({ ok: true, changed: 1 })

    const all = mockExecute.mock.calls.map(sqlOf).join(' ')
    expect(all).toContain('INSERT INTO workout_exercises')
    // Appended, never inserted — existing positions must not shift.
    expect(all).toContain('max(position)')
    expect(all).toContain('DELETE FROM workout_exercises')
  })

  it('reuses an existing destination entry rather than adding a second', async () => {
    mockExecute
      .mockResolvedValueOnce(found())
      .mockResolvedValueOnce({ rows: [{ id: 'we-existing' }] })
      .mockResolvedValueOnce({ rows: [{ next: 4 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })

    await moveCompletedSet('w1', 's-90', 'ex-pendulum')
    expect(mockExecute.mock.calls.map(sqlOf).join(' ')).not.toContain('INSERT INTO workout_exercises')
  })

  // 1L and 1R are ONE round sharing a logical_set_id. Moving a single half
  // would leave the pair straddling two exercises and double-count the round.
  it('moves both halves of a split L/R round together', async () => {
    mockExecute
      .mockResolvedValueOnce(found({ logicalSetId: 'lsid-1' }))
      .mockResolvedValueOnce({ rows: [{ id: 'we-existing' }] })
      .mockResolvedValueOnce({ rows: [{ next: 2 }] })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 0 })

    const res = await moveCompletedSet('w1', 's-left', 'ex-pendulum')
    expect(res).toEqual({ ok: true, changed: 2 })
    expect(mockExecute.mock.calls.map(sqlOf).join(' ')).toContain('logical_set_id')
  })

  it('refuses a set that is not in that completed session', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] })
    const res = await moveCompletedSet('w1', 's-90', 'ex-pendulum')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not in this completed session')
  })

  it('refuses a no-op move onto the exercise it already sits on', async () => {
    mockExecute.mockResolvedValueOnce(found({ fromExerciseId: 'ex-pendulum' }))
    const res = await moveCompletedSet('w1', 's-90', 'ex-pendulum')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('already on that exercise')
  })

  it('is scoped to a COMPLETED session', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] })
    await moveCompletedSet('w1', 's-90', 'ex-pendulum')
    expect(sqlOf(mockExecute.mock.calls[0]!)).toContain('completed')
  })
})
