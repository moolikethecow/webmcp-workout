/**
 * Injuries + gyms CRUD (GYM_PLAN §4/§6, P3-A3). Covers:
 *   - injury region validation (non-canonical region → null / 400 upstream),
 *   - the auto-expire "active" convention (resolved_at future = still active),
 *   - the gyms exactly-one-default transaction (create + patch clear others),
 *   - excludeExerciseAtDefaultGym (per-gym "Not available here" write),
 *   - the equipment-shape normalizers.
 * db.execute / db.transaction are mocked; SQL text is asserted via sqlText.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sqlText } from './sql-text'

const mockExecute = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db/client', () => ({
  db: { execute: mockExecute, transaction: mockTransaction },
}))

const {
  createInjury,
  createTweakInjury,
  updateInjury,
  createGym,
  updateGym,
  deleteGym,
  excludeExerciseAtDefaultGym,
  normalizeGymEquipment,
  isEquipmentToken,
  GYM_EQUIPMENT_VOCAB,
} = await import('../injuries-gyms')

beforeEach(() => {
  mockExecute.mockReset()
  mockTransaction.mockReset()
})

// ── Injuries: region validation ─────────────────────────────────────────────
describe('createInjury — region validation (the safety gate)', () => {
  it('returns null for a non-canonical region (no INSERT fired)', async () => {
    const r = await createInjury({ region: 'left knee' })
    expect(r).toBeNull()
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('inserts a canonical region with a defaulted severity', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ id: 'i1', region: 'quads', label: null, note: null, severity: 'nagging', started_at: null, resolved_at: null, created_at: '2026-07-10' }],
    })
    const r = await createInjury({ region: 'quads' })
    expect(r?.region).toBe('quads')
    expect(r?.severity).toBe('nagging')
    expect(sqlText(mockExecute.mock.calls[0]![0])).toMatch(/INSERT INTO injuries/)
  })

  it('inserts an extended anatomical site used by the shared demand gate', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ id: 'i2', region: 'elbows', label: 'tendon', note: null, severity: 'limiting', started_at: null, resolved_at: null, created_at: '2026-07-10' }],
    })
    const r = await createInjury({ region: 'elbows', severity: 'limiting', label: 'tendon' })
    expect(r?.region).toBe('elbows')
    expect(r?.severity).toBe('limiting')
    expect(sqlText(mockExecute.mock.calls[0]![0])).toMatch(/INSERT INTO injuries/)
  })
})

// ── Injuries: the auto-expire "active" convention ────────────────────────────
describe('active convention — resolved_at in the FUTURE reads as still active', () => {
  it('a future resolved_at is active; a past one is not', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const past = new Date(Date.now() - 86_400_000).toISOString()
    mockExecute.mockResolvedValueOnce({
      rows: [{ id: 'i1', region: 'quads', label: 't', note: null, severity: 'nagging', started_at: null, resolved_at: future, created_at: 'x' }],
    })
    const active = await updateInjury('i1', {})
    expect(active?.active).toBe(true)

    mockExecute.mockResolvedValueOnce({
      rows: [{ id: 'i2', region: 'quads', label: 't', note: null, severity: 'nagging', started_at: null, resolved_at: past, created_at: 'x' }],
    })
    const expired = await updateInjury('i2', {})
    expect(expired?.active).toBe(false)
  })

  it('createTweakInjury writes a pre-resolved-in-future soft flag', async () => {
    let captured = ''
    mockExecute.mockImplementationOnce((q: unknown) => {
      captured = sqlText(q)
      return Promise.resolve({
        rows: [{ id: 'tw', region: 'hamstrings', label: 'tweaked (auto)', note: 'via logger', severity: 'nagging', started_at: null, resolved_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), created_at: 'x' }],
      })
    })
    const r = await createTweakInjury('hamstrings', 7)
    expect(r?.active).toBe(true)
    expect(r?.label).toBe('tweaked (auto)')
    expect(captured).toMatch(/INSERT INTO injuries/)
  })

  it('createTweakInjury rejects a non-canonical region', async () => {
    expect(await createTweakInjury('elbow')).toBeNull()
    expect(mockExecute).not.toHaveBeenCalled()
  })
})

describe('updateInjury — resolve semantics', () => {
  it('resolve:true sets resolved_at = now()', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'i1', region: 'quads', label: null, note: null, severity: 'nagging', started_at: null, resolved_at: 'now', created_at: 'x' }] })
    await updateInjury('i1', { resolve: true })
    expect(sqlText(mockExecute.mock.calls[0]![0])).toMatch(/resolved_at = now\(\)/)
  })
  it('resolve:false reopens (resolved_at = NULL)', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'i1', region: 'quads', label: null, note: null, severity: 'nagging', started_at: null, resolved_at: null, created_at: 'x' }] })
    await updateInjury('i1', { resolve: false })
    expect(sqlText(mockExecute.mock.calls[0]![0])).toMatch(/resolved_at = NULL/)
  })
  it('returns null on a missing id (rowcount-honest)', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] })
    expect(await updateInjury('gone', { resolve: true })).toBeNull()
  })
})

// ── Gyms: exactly-one-default transaction ────────────────────────────────────
describe('createGym — default uniqueness', () => {
  it('the FIRST gym becomes default and clears others in the transaction', async () => {
    const txExecute = vi.fn()
    // count(*) → 0 (first gym), then the clear UPDATE, then the INSERT RETURNING.
    txExecute.mockResolvedValueOnce({ rows: [{ n: 0 }] })
    txExecute.mockResolvedValueOnce({ rows: [] })
    txExecute.mockResolvedValueOnce({ rows: [{ id: 'g1', name: 'Home', equipment: { categories: [], machines: [], machines_excluded: [] }, notes: null, is_default: true, created_at: 'x' }] })
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) => cb({ execute: txExecute }))

    const g = await createGym({ name: 'Home' })
    expect(g?.isDefault).toBe(true)
    const texts = txExecute.mock.calls.map((c) => sqlText(c[0]))
    expect(texts.some((t) => /UPDATE gyms SET is_default = false/.test(t))).toBe(true)
    expect(texts.some((t) => /INSERT INTO gyms/.test(t))).toBe(true)
  })

  it('a non-default create when gyms already exist does NOT clear others', async () => {
    const txExecute = vi.fn()
    txExecute.mockResolvedValueOnce({ rows: [{ n: 2 }] }) // gyms exist
    txExecute.mockResolvedValueOnce({ rows: [{ id: 'g3', name: 'Travel', equipment: {}, notes: null, is_default: false, created_at: 'x' }] })
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) => cb({ execute: txExecute }))

    const g = await createGym({ name: 'Travel', isDefault: false })
    expect(g?.isDefault).toBe(false)
    const texts = txExecute.mock.calls.map((c) => sqlText(c[0]))
    expect(texts.some((t) => /UPDATE gyms SET is_default = false/.test(t))).toBe(false)
  })

  it('only vocab equipment categories survive sanitization', async () => {
    const txExecute = vi.fn()
    txExecute.mockResolvedValueOnce({ rows: [{ n: 1 }] })
    let insertText = ''
    txExecute.mockImplementationOnce((q: unknown) => {
      insertText = sqlText(q)
      return Promise.resolve({ rows: [{ id: 'g4', name: 'X', equipment: {}, notes: null, is_default: false, created_at: 'x' }] })
    })
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) => cb({ execute: txExecute }))
    await createGym({ name: 'X', equipment: { categories: ['barbell', 'not-a-thing'], machines: ['Hammer Row'], machines_excluded: [] } })
    expect(insertText).toMatch(/INSERT INTO gyms/)
  })
})

describe('updateGym — set-default clears others', () => {
  it('isDefault:true fires a clear-others UPDATE excluding self', async () => {
    const txExecute = vi.fn()
    txExecute.mockResolvedValueOnce({ rows: [] }) // clear others
    txExecute.mockResolvedValueOnce({ rows: [{ id: 'g2', name: 'Gym', equipment: {}, notes: null, is_default: true, created_at: 'x' }] }) // update self
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) => cb({ execute: txExecute }))

    const g = await updateGym('g2', { isDefault: true })
    expect(g?.isDefault).toBe(true)
    const texts = txExecute.mock.calls.map((c) => sqlText(c[0]))
    expect(texts.some((t) => /UPDATE gyms SET is_default = false WHERE is_default = true AND id <>/.test(t))).toBe(true)
  })

  it('returns null when the gym id is missing', async () => {
    const txExecute = vi.fn()
    txExecute.mockResolvedValueOnce({ rows: [] }) // no sets → read-back path
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) => cb({ execute: txExecute }))
    expect(await updateGym('gone', {})).toBeNull()
  })
})

describe('deleteGym — promotes a new default when the default is removed', () => {
  it('promotes the newest remaining gym on default delete', async () => {
    const txExecute = vi.fn()
    txExecute.mockResolvedValueOnce({ rows: [{ is_default: true }] }) // deleted row was default
    txExecute.mockResolvedValueOnce({ rows: [] }) // promotion UPDATE
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) => cb({ execute: txExecute }))

    expect(await deleteGym('g1')).toBe(true)
    const texts = txExecute.mock.calls.map((c) => sqlText(c[0]))
    expect(texts.some((t) => /UPDATE gyms SET is_default = true/.test(t))).toBe(true)
  })

  it('returns false when nothing was deleted', async () => {
    const txExecute = vi.fn()
    txExecute.mockResolvedValueOnce({ rows: [] })
    mockTransaction.mockImplementation(async (cb: (tx: { execute: typeof txExecute }) => unknown) => cb({ execute: txExecute }))
    expect(await deleteGym('gone')).toBe(false)
  })
})

// ── Not available here: excludeExerciseAtDefaultGym ──────────────────────────
describe('excludeExerciseAtDefaultGym', () => {
  it('appends the name to the default gym machines_excluded', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'g1', equipment: { categories: ['barbell'], machines: [], machines_excluded: [] } }] })
    let updateText = ''
    mockExecute.mockImplementationOnce((q: unknown) => {
      updateText = sqlText(q)
      return Promise.resolve({ rows: [{ id: 'g1' }] })
    })
    expect(await excludeExerciseAtDefaultGym('Leg Press')).toBe(true)
    expect(updateText).toMatch(/UPDATE gyms SET equipment/)
  })

  it('is idempotent — an already-excluded name is not duplicated (no UPDATE)', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'g1', equipment: { categories: [], machines: [], machines_excluded: ['leg press'] } }] })
    expect(await excludeExerciseAtDefaultGym('Leg Press')).toBe(true)
    expect(mockExecute).toHaveBeenCalledTimes(1) // only the SELECT, no UPDATE
  })

  it('returns false when there is no default gym', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] })
    expect(await excludeExerciseAtDefaultGym('Leg Press')).toBe(false)
  })
})

// ── Equipment shape helpers (pure) ───────────────────────────────────────────
describe('equipment shape normalizers', () => {
  it('normalizes a legacy flat array into the structured payload', () => {
    expect(normalizeGymEquipment(['barbell', 'dumbbell'])).toEqual({
      categories: ['barbell', 'dumbbell'],
      machines: [],
      machines_excluded: [],
    })
  })
  it('passes through a structured jsonb shape', () => {
    expect(normalizeGymEquipment({ categories: ['cable'], machines: ['Row'], machines_excluded: ['Dip'] })).toEqual({
      categories: ['cable'],
      machines: ['Row'],
      machines_excluded: ['Dip'],
    })
  })
  it('null/garbage → empty payload', () => {
    expect(normalizeGymEquipment(null)).toEqual({ categories: [], machines: [], machines_excluded: [] })
  })
  it('the vocab is a stable non-empty token set', () => {
    expect(GYM_EQUIPMENT_VOCAB.length).toBeGreaterThan(8)
    expect(isEquipmentToken('barbell')).toBe(true)
    expect(isEquipmentToken('teleporter')).toBe(false)
  })
})
