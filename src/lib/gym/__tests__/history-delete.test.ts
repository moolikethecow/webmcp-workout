import { beforeEach, describe, expect, it, vi } from 'vitest'

import { collapseWs, sqlText } from './sql-text'

const mockTransaction = vi.hoisted(() => vi.fn())
const mockReconcileHabit = vi.hoisted(() => vi.fn())
const mockDropQueued = vi.hoisted(() => vi.fn())
const mockDeleteDocument = vi.hoisted(() => vi.fn())
const mockInvalidate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db/client', () => ({ db: { transaction: mockTransaction } }))
vi.mock('@/lib/habits', () => ({ reconcileHabitAfterLogMutation: mockReconcileHabit }))
vi.mock('@/lib/ai/retain-queue', () => ({ dropQueuedRetain: mockDropQueued }))
vi.mock('@/lib/memory/store', () => ({ deleteDocument: mockDeleteDocument }))
vi.mock('../coach-context', () => ({ invalidateCoachContext: mockInvalidate }))

const { deleteCompletedWorkout } = await import('../history-delete')

function installTx(opts: {
  exists?: boolean
  link?: { habit_id: string; habit_log_id: string; habit_date: string; gym_managed: boolean } | null
  otherOwners?: number
}) {
  const execute = vi.fn((query: unknown) => {
    const text = collapseWs(sqlText(query))
    if (/SELECT id FROM workouts/.test(text)) {
      return Promise.resolve({ rows: opts.exists === false ? [] : [{ id: 'w1' }] })
    }
    if (/FROM gym_habit_log_links WHERE workout_id/.test(text)) {
      return Promise.resolve({ rows: opts.link ? [opts.link] : [] })
    }
    if (/count\(\*\).*FROM gym_habit_log_links/.test(text)) {
      return Promise.resolve({ rows: [{ count: opts.otherOwners ?? 0 }] })
    }
    return Promise.resolve({ rows: [] })
  })
  mockTransaction.mockImplementation(async (callback: (tx: { execute: typeof execute }) => unknown) => callback({ execute }))
  return execute
}

beforeEach(() => {
  vi.clearAllMocks()
  mockReconcileHabit.mockResolvedValue({ current_streak: 0 })
  mockDeleteDocument.mockResolvedValue(undefined)
})

describe('deleteCompletedWorkout', () => {
  it('deletes the session but never touches a manual habit completion', async () => {
    const execute = installTx({ link: null })
    await expect(deleteCompletedWorkout('w1')).resolves.toEqual({
      deleted: true,
      habitCompletionRemoved: false,
    })
    expect(mockReconcileHabit).not.toHaveBeenCalled()
    expect(execute.mock.calls.some(([query]) => /DELETE FROM workouts/.test(collapseWs(sqlText(query))))).toBe(true)
  })

  it('removes a gym-owned habit completion when the final workout owner is deleted', async () => {
    const link = { habit_id: 'h1', habit_log_id: 'hl1', habit_date: '2026-07-15', gym_managed: true }
    const execute = installTx({ link, otherOwners: 0 })
    await expect(deleteCompletedWorkout('w1')).resolves.toEqual({
      deleted: true,
      habitCompletionRemoved: true,
    })
    expect(mockReconcileHabit).toHaveBeenCalledWith({ habit_id: 'h1', date: '2026-07-15' })
    expect(execute.mock.calls.some(([query]) => /DELETE FROM habit_log/.test(collapseWs(sqlText(query))))).toBe(true)
  })

  it('keeps the completion while another workout still owns it', async () => {
    const link = { habit_id: 'h1', habit_log_id: 'hl1', habit_date: '2026-07-15', gym_managed: true }
    const execute = installTx({ link, otherOwners: 1 })
    const result = await deleteCompletedWorkout('w1')
    expect(result?.habitCompletionRemoved).toBe(false)
    expect(mockReconcileHabit).not.toHaveBeenCalled()
    expect(execute.mock.calls.some(([query]) => /DELETE FROM habit_log/.test(collapseWs(sqlText(query))))).toBe(false)
  })

  it('returns null for an active, discarded, or missing workout', async () => {
    installTx({ exists: false })
    await expect(deleteCompletedWorkout('w1')).resolves.toBeNull()
    expect(mockDropQueued).not.toHaveBeenCalled()
  })

  it('invalidates coach context and removes the workout retain', async () => {
    installTx({ link: null })
    await deleteCompletedWorkout('w1')
    expect(mockDropQueued).toHaveBeenCalledWith(expect.stringContaining('w1'))
    expect(mockDeleteDocument).toHaveBeenCalledWith('health', expect.stringContaining('w1'))
    expect(mockInvalidate).toHaveBeenCalled()
  })
})
