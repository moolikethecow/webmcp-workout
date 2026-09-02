/**
 * Writing grip (2026-08-31).
 *
 * Two rules carry the weight: every write is SCOPED to its workout by a join,
 * and an explicit null CLEARS rather than being ignored — because on a set,
 * cleared means "inherit from the exercise", so a mis-tapped override has to be
 * undoable.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockExecute = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/client', () => ({ db: { execute: mockExecute } }))

import { collapseWs, sqlText } from './sql-text'
import { inheritTemplateGrip, setExerciseGrip, setSetGrip } from '../grip-write'

const lastSql = () =>
  collapseWs(sqlText(mockExecute.mock.calls[mockExecute.mock.calls.length - 1]![0]))
const lastParams = () =>
  JSON.stringify(mockExecute.mock.calls[mockExecute.mock.calls.length - 1]![0])

beforeEach(() => mockExecute.mockReset())

describe('setExerciseGrip', () => {
  it('writes only the fields passed', async () => {
    mockExecute.mockResolvedValue({ rowCount: 1 })
    await setExerciseGrip('w1', 'Lat Pulldown', { attachment: 'mag' })
    const text = lastSql()
    expect(text).toContain('attachment =')
    expect(text).not.toContain('grip_width =')
    expect(text).not.toContain('grip_orientation =')
  })

  // Clearing has to reach the database. Treating null as "nothing to do" would
  // make a wrong grip permanent.
  it('an explicit null clears rather than being skipped', async () => {
    mockExecute.mockResolvedValue({ rowCount: 1 })
    await setExerciseGrip('w1', 'Lat Pulldown', { attachment: null })
    expect(lastSql()).toContain('attachment =')
  })

  it('refuses an empty patch instead of running a no-op UPDATE', async () => {
    const res = await setExerciseGrip('w1', 'Lat Pulldown', {})
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/at least one/i)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  // A wrong id must not be able to reach another session.
  it('is scoped to the workout', async () => {
    mockExecute.mockResolvedValue({ rowCount: 1 })
    await setExerciseGrip('w1', 'Lat Pulldown', { attachment: 'rope' })
    expect(lastSql()).toContain('we.workout_id =')
  })

  // Uses the SHARED name normalization (#1871), so "lat pulldown" and
  // "Lat-Pulldown" reach the same row every other resolver would reach.
  it('resolves the exercise name through the shared normalization', async () => {
    mockExecute.mockResolvedValue({ rowCount: 1 })
    await setExerciseGrip('w1', '  Lat-Pulldown ', { attachment: 'rope' })
    expect(lastSql()).toContain('regexp_replace(lower(trim(')
    expect(lastParams()).toContain('lat pulldown')
  })

  it('reports a miss rather than a silent success', async () => {
    mockExecute.mockResolvedValue({ rowCount: 0 })
    const res = await setExerciseGrip('w1', 'Bench Press', { attachment: 'rope' })
    expect(res).toMatchObject({ ok: false, changed: 0 })
    expect(res.error).toMatch(/not in that workout/)
  })
})

describe('setSetGrip', () => {
  it('is scoped to the workout through the exercise join', async () => {
    mockExecute.mockResolvedValue({ rowCount: 1 })
    await setSetGrip('w1', 's1', { gripWidth: 'close' })
    const text = lastSql()
    expect(text).toContain('we.workout_id =')
    expect(text).toContain('ws.id =')
  })

  it('refuses an empty patch', async () => {
    const res = await setSetGrip('w1', 's1', {})
    expect(res.ok).toBe(false)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('reports a miss', async () => {
    mockExecute.mockResolvedValue({ rowCount: 0 })
    const res = await setSetGrip('w1', 'nope', { gripWidth: 'close' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not in that workout/)
  })
})

describe('inheritTemplateGrip', () => {
  // A mid-session change must survive: only exercises with NO grip yet are
  // filled, so calling this twice cannot overwrite what someone just set.
  it('fills only exercises whose session grip is still empty', async () => {
    mockExecute.mockResolvedValue({ rowCount: 2 })
    const n = await inheritTemplateGrip('w1', 't1')
    expect(n).toBe(2)
    const text = lastSql()
    expect(text).toContain('we.grip_width IS NULL')
    expect(text).toContain('we.attachment IS NULL')
  })

  // Nothing to copy is not a write. Without this the UPDATE would blank every
  // session grip whenever the template specified none.
  it('skips template rows that specify no grip at all', async () => {
    mockExecute.mockResolvedValue({ rowCount: 0 })
    await inheritTemplateGrip('w1', 't1')
    expect(lastSql()).toContain('te.grip_width IS NOT NULL')
  })
})
