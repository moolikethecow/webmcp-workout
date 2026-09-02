/**
 * Templates CRUD layer (P2b — the builder). Covers the PURE validator + folder
 * grouper (the load-bearing invariants: dense positions, invalid-policy rejection,
 * null-folder bucket sorts last) and the DB wrappers with a mocked db.execute /
 * db.transaction (archive/restore rowcount honesty, duplicate carry-through,
 * replace-all wiring).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sqlText } from './sql-text'

const mockExecute = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())
const mockWeightUnit = vi.hoisted(() => vi.fn().mockResolvedValue('lb'))

vi.mock('@/lib/db/client', () => ({
  db: { execute: mockExecute, transaction: mockTransaction },
}))
vi.mock('@/lib/gym/unit-preferences', () => ({ getGymWeightUnit: mockWeightUnit }))

const {
  archiveTemplate,
  createTemplateFromEditor,
  duplicateTemplate,
  findMissingExerciseId,
  getTemplateForEditor,
  groupTemplatesByFolder,
  unarchiveTemplate,
  updateTemplateFromEditor,
  validateEditorPayload,
} = await import('../templates-read')

beforeEach(() => {
  mockExecute.mockReset()
  mockTransaction.mockReset()
  mockWeightUnit.mockReset()
  mockWeightUnit.mockResolvedValue('lb')
})

// ── validateEditorPayload (pure) ─────────────────────────────────────────────
describe('validateEditorPayload', () => {
  const ex = (o: Record<string, unknown> = {}) => ({ exerciseId: 'e1', position: 0, ...o })

  it('rejects a missing name', () => {
    const r = validateEditorPayload({ name: '  ', exercises: [ex()] })
    expect(r.ok).toBe(false)
  })

  it('rejects an empty exercise list', () => {
    const r = validateEditorPayload({ name: 'Push', exercises: [] })
    expect(r.ok).toBe(false)
  })

  it('rejects an exercise missing an exerciseId', () => {
    const r = validateEditorPayload({ name: 'Push', exercises: [{ position: 0 }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/exerciseId/)
  })

  it('RE-INDEXES positions densely in the given position order (gaps/dupes collapse)', () => {
    const r = validateEditorPayload({
      name: 'Push',
      exercises: [
        ex({ exerciseId: 'c', position: 9 }),
        ex({ exerciseId: 'a', position: 2 }),
        ex({ exerciseId: 'b', position: 2 }), // duplicate position — stable-sorted after a
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.payload.exercises.map((e) => e.exerciseId)).toEqual(['a', 'b', 'c'])
      expect(r.payload.exercises.map((e) => e.position)).toEqual([0, 1, 2])
    }
  })

  it('accepts a null progression (last_time default)', () => {
    const r = validateEditorPayload({ name: 'P', exercises: [ex({ progression: null })] })
    expect(r.ok).toBe(true)
  })

  it('accepts a valid §2.5 policy and carries it through', () => {
    const policy = { type: 'double_progression', repRange: [8, 12], increment: 5 }
    const r = validateEditorPayload({ name: 'P', exercises: [ex({ progression: policy })] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.payload.exercises[0]!.progression).toEqual(policy)
  })

  it('REJECTS an unreadable progression policy (never save garbage)', () => {
    const r = validateEditorPayload({
      name: 'P',
      exercises: [ex({ progression: { type: 'double_progression', repRange: [12, 8], increment: 5 } })],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/progression/)
  })

  it('trims meta + numeric targets and rejects non-finite rest', () => {
    const r = validateEditorPayload({
      name: '  Push  ',
      folder: '  PPL  ',
      notes: '   ',
      exercises: [ex({ targetSets: 3.9, targetReps: 10, targetWeight: 135.5, restSeconds: Infinity })],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/rest/)
  })

  it('normalizes an exact heterogeneous set prescription and derives the legacy summary', () => {
    const r = validateEditorPayload({
      name: 'Push',
      exercises: [ex({
        restSeconds: 120,
        restSecondsWarmup: 30,
        sets: [
          { setNumber: 1, setType: 'warmup', targetWeight: 20, targetReps: 12, restSeconds: 30 },
          { setNumber: 3, setType: 'failure', targetWeight: 50, targetReps: 8, targetRpe: 9, restSeconds: 150 },
          { setNumber: 2, setType: 'normal', targetWeight: 45, targetReps: 10, side: 'left' },
        ],
      })],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const normalized = r.payload.exercises[0]!
      expect(normalized.sets.map((set) => [set.setNumber, set.setType])).toEqual([
        [1, 'warmup'],
        [2, 'normal'],
        [3, 'failure'],
      ])
      expect(normalized.targetSets).toBe(2)
      expect(normalized.targetWeight).toBe(50)
      expect(normalized.restSecondsWarmup).toBe(30)
    }
  })

  it('rejects invalid per-set rest/RPE/side values', () => {
    for (const badSet of [
      { restSeconds: -1 },
      { targetRpe: 11 },
      { side: 'middle' },
    ]) {
      const r = validateEditorPayload({
        name: 'Bad',
        exercises: [ex({ sets: [{ setType: 'normal', ...badSet }] })],
      })
      expect(r.ok).toBe(false)
    }
  })

  it('uses the supplied app unit when an older editor payload omits its target unit', () => {
    const r = validateEditorPayload(
      { name: 'Metric', exercises: [ex({ targetWeight: 100 })] },
      'kg',
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.payload.exercises[0]!.targetWeightUnit).toBe('kg')
  })
})

// ── groupTemplatesByFolder (pure) ────────────────────────────────────────────
describe('groupTemplatesByFolder', () => {
  const card = (o: Partial<import('../templates-read').TemplateCard>) => ({
    id: 'x',
    name: 'X',
    folder: null,
    notes: null,
    source: 'user',
    exerciseCount: 0,
    lastPerformed: null,
    exercisePreview: [],
    archived: false,
    ...o,
  })

  it('groups by folder, sorts named folders A→Z, null bucket last', () => {
    const groups = groupTemplatesByFolder([
      card({ id: '1', folder: 'Pull' }),
      card({ id: '2', folder: null }),
      card({ id: '3', folder: 'Legs' }),
      card({ id: '4', folder: 'Pull' }),
    ])
    expect(groups.map((g) => g.folder)).toEqual(['Legs', 'Pull', null])
    expect(groups[1]!.templates.map((t) => t.id)).toEqual(['1', '4'])
  })

  it('omits the null bucket when every card has a folder', () => {
    const groups = groupTemplatesByFolder([card({ folder: 'A' })])
    expect(groups.map((g) => g.folder)).toEqual(['A'])
  })
})

// ── archive / restore (rowcount honesty) ─────────────────────────────────────
describe('archiveTemplate / unarchiveTemplate', () => {
  it('archiveTemplate returns true only when a row flipped', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 't1' }] })
    expect(await archiveTemplate('t1')).toBe(true)
    mockExecute.mockResolvedValueOnce({ rows: [] })
    expect(await archiveTemplate('t1')).toBe(false)
  })

  it('unarchiveTemplate returns true only when a row flipped', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 't1' }] })
    expect(await unarchiveTemplate('t1')).toBe(true)
    mockExecute.mockResolvedValueOnce({ rows: [] })
    expect(await unarchiveTemplate('t1')).toBe(false)
  })
})

// ── findMissingExerciseId ────────────────────────────────────────────────────
describe('findMissingExerciseId', () => {
  it('returns null when every id resolves', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] })
    expect(await findMissingExerciseId(['a', 'b'])).toBeNull()
  })

  it('returns the first missing id', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'a' }] })
    expect(await findMissingExerciseId(['a', 'b'])).toBe('b')
  })

  it('short-circuits on an empty list (no query)', async () => {
    expect(await findMissingExerciseId([])).toBeNull()
    expect(mockExecute).not.toHaveBeenCalled()
  })
})

// ── createTemplateFromEditor (mocked transaction) ────────────────────────────
describe('createTemplateFromEditor', () => {
  it('inserts the template + exercises in a transaction and returns the id', async () => {
    const txExecute = vi.fn()
    txExecute
      .mockResolvedValueOnce({ rows: [{ id: 'new-tpl' }] }) // INSERT template RETURNING id
      .mockResolvedValueOnce({ rows: [{ id: 'te-a' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'te-b' }] })
    txExecute.mockResolvedValue({ rows: [] })
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) =>
      cb({ execute: txExecute }),
    )

    const id = await createTemplateFromEditor({
      name: 'Push',
      folder: 'PPL',
      notes: null,
      exercises: [
        { exerciseId: 'a', position: 0, targetSets: 3, targetReps: 10, targetWeight: null, targetWeightUnit: 'lb', targetDurationS: null, restSeconds: null, restSecondsWarmup: null, supersetGroup: null, section: 'main', sets: [], progression: null, notes: null },
        { exerciseId: 'b', position: 1, targetSets: 3, targetReps: 8, targetWeight: 61.23, targetWeightUnit: 'kg', targetDurationS: null, restSeconds: 120, restSecondsWarmup: 45, supersetGroup: 1, section: 'main', sets: [], progression: { type: 'linear', increment: 5 }, notes: null },
      ],
    })
    expect(id).toBe('new-tpl')
    // 1 template insert + 2 exercise inserts.
    expect(txExecute).toHaveBeenCalledTimes(3)
    expect(sqlText(txExecute.mock.calls[0]![0])).toMatch(/INSERT INTO workout_templates/)
    expect(sqlText(txExecute.mock.calls[1]![0])).toMatch(/INSERT INTO template_exercises/)
    expect(sqlText(txExecute.mock.calls[1]![0])).toContain('target_weight_unit')
    expect(sqlText(txExecute.mock.calls[1]![0])).toContain("'lb'")
  })
})

// ── updateTemplateFromEditor (replace-all) ───────────────────────────────────
describe('updateTemplateFromEditor', () => {
  it('returns false when the template is missing (meta UPDATE affects no row)', async () => {
    const txExecute = vi.fn().mockResolvedValueOnce({ rows: [] }) // UPDATE … RETURNING id → none
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) =>
      cb({ execute: txExecute }),
    )
    expect(await updateTemplateFromEditor('gone', { name: 'X', folder: null, notes: null, exercises: [] })).toBe(false)
    // Only the meta UPDATE ran — no DELETE / re-insert.
    expect(txExecute).toHaveBeenCalledTimes(1)
  })

  it('updates meta, wipes exercises, and re-inserts in one transaction', async () => {
    const txExecute = vi.fn()
    txExecute.mockResolvedValueOnce({ rows: [{ id: 't1' }] }) // meta UPDATE RETURNING id
    txExecute
      .mockResolvedValueOnce({ rows: [] }) // DELETE
      .mockResolvedValueOnce({ rows: [{ id: 'te-a' }] })
      .mockResolvedValue({ rows: [] })
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) =>
      cb({ execute: txExecute }),
    )

    const ok = await updateTemplateFromEditor('t1', {
      name: 'X',
      folder: null,
      notes: null,
      exercises: [
        { exerciseId: 'a', position: 0, targetSets: 3, targetReps: 10, targetWeight: null, targetWeightUnit: 'lb', targetDurationS: null, restSeconds: null, restSecondsWarmup: null, supersetGroup: null, section: 'main', sets: [], progression: null, notes: null },
      ],
    })
    expect(ok).toBe(true)
    // meta UPDATE + DELETE + 1 insert.
    expect(txExecute).toHaveBeenCalledTimes(3)
    expect(sqlText(txExecute.mock.calls[0]![0])).toMatch(/UPDATE workout_templates/)
    expect(sqlText(txExecute.mock.calls[1]![0])).toMatch(/DELETE FROM template_exercises/)
    expect(sqlText(txExecute.mock.calls[2]![0])).toMatch(/INSERT INTO template_exercises/)
  })
})

// ── duplicateTemplate ────────────────────────────────────────────────────────
describe('duplicateTemplate', () => {
  it('converts a stored target into the app unit and reports that unit', async () => {
    mockWeightUnit.mockResolvedValue('kg')
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ id: 'src', name: 'Push', folder: null, notes: null, source: 'user', archived: false }],
      })
      .mockResolvedValueOnce({
        rows: [{
          template_exercise_id: 'te-a', exercise_id: 'a', name: 'Bench', tracks: 'weight_reps', preferred_unit: null,
          position: 0, target_sets: 3, target_reps: 8, target_weight: '220.46',
          target_weight_unit: 'lb', target_duration_s: null, rest_seconds: 120,
          rest_seconds_warmup: 45, section: 'main', superset_group: null, progression: null, notes: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const template = await getTemplateForEditor('src')
    expect(template?.exercises[0]).toMatchObject({
      targetWeight: 100,
      targetWeightUnit: 'kg',
    })
  })

  it('returns null when the source is missing', async () => {
    // getTemplateForEditor → template lookup returns none.
    mockExecute.mockResolvedValueOnce({ rows: [] })
    expect(await duplicateTemplate('gone')).toBeNull()
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it('copies the source name (+ copy) and carries every slot verbatim', async () => {
    // getTemplateForEditor: 1) template row, 2) exercise rows, 3) exact sets.
    mockExecute.mockResolvedValueOnce({
      rows: [{ id: 'src', name: 'Push', folder: 'PPL', notes: 'n', source: 'ai', archived: false }],
    })
    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          template_exercise_id: 'te-a', exercise_id: 'a', name: 'Bench', tracks: 'weight_reps', preferred_unit: 'lb',
          position: 0, target_sets: 3, target_reps: 8, target_weight: '135',
          target_weight_unit: 'lb',
          target_duration_s: null, rest_seconds: 120, rest_seconds_warmup: 45,
          section: 'main', superset_group: 1,
          progression: { type: 'linear', increment: 5 }, notes: null,
        },
      ],
    })
    mockExecute.mockResolvedValueOnce({ rows: [] })
    const txExecute = vi.fn()
    txExecute.mockResolvedValueOnce({ rows: [{ id: 'copy' }] }).mockResolvedValue({ rows: [] })
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) =>
      cb({ execute: txExecute }),
    )

    const out = await duplicateTemplate('src')
    expect(out).toEqual({ id: 'copy', name: 'Push (copy)', folder: 'PPL', exerciseCount: 1 })
    // The copy is a fresh 'user' template (a duplicated AI draft becomes the user's).
    expect(sqlText(txExecute.mock.calls[0]![0])).toMatch(/INSERT INTO workout_templates/)
  })
})
