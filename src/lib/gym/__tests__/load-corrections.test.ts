import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExecute = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() =>
  vi.fn(async (callback: (tx: { execute: typeof mockExecute }) => Promise<unknown>) =>
    callback({ execute: mockExecute }),
  ),
)

vi.mock('@/lib/db/client', () => ({
  db: { execute: mockExecute, transaction: mockTransaction },
}))

const {
  applyLoadCorrection,
  listLoadCorrections,
  previewLoadCorrection,
  revertLoadCorrection,
} = await import('../load-corrections')

const EXERCISE_ID = '11111111-1111-4111-8111-111111111111'
const CORRECTION_ID = '22222222-2222-4222-8222-222222222222'

function correctionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CORRECTION_ID,
    exercise_id: EXERCISE_ID,
    source: 'strong-import',
    start_date: '2024-10-16',
    end_date: '2026-07-08',
    divisor: '2',
    previous_load_basis: 'total',
    reason: 'Both arms were logged together',
    active: true,
    affected_sets: 192,
    created_at: '2026-07-16T12:00:00.000Z',
    reverted_at: null,
    ...overrides,
  }
}

function queryText(call: unknown): string {
  return JSON.stringify(call)
}

function stringParams(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringParams)
  if (value && typeof value === 'object' && 'queryChunks' in value) {
    const chunks = (value as { queryChunks?: unknown[] }).queryChunks
    return chunks ? chunks.flatMap(stringParams) : []
  }
  return []
}

beforeEach(() => {
  vi.clearAllMocks()
  mockTransaction.mockImplementation(async (callback) => callback({ execute: mockExecute }))
})

describe('Load corrections', () => {
  it('previews an inclusive date range without writing', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        affected_sets: 192,
        first_date: '2024-10-16',
        last_date: '2026-07-08',
        raw_weight_total: 1000,
        raw_volume: 100390.67,
        min_raw_weight: 20,
        max_raw_weight: 85.98,
      }],
    })

    const preview = await previewLoadCorrection({
      exerciseId: EXERCISE_ID,
      startDate: '2024-10-16',
      endDate: '2026-07-08',
    })

    expect(preview).toMatchObject({
      divisor: 2,
      affectedSets: 192,
      correctedWeightTotal: 500,
      rawVolume: 100390.67,
      correctedMatchedVolume: 100390.67,
      minCorrectedWeight: 10,
      maxCorrectedWeight: 42.99,
    })
    const text = queryText(mockExecute.mock.calls[0]?.[0])
    expect(text).toContain("w.source = ")
    expect(text).toContain("w.status = 'completed'")
    expect(text).toContain('w.started_at::date >=')
    expect(text).toContain('w.started_at::date <=')
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it('applies once, preserves source_weight, and never writes a side', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: EXERCISE_ID, load_basis: 'total' }] }) // lock exercise
      .mockResolvedValueOnce({ rows: [] }) // no overlap
      .mockResolvedValueOnce({
        rows: [{
          affected_sets: 192,
          first_date: '2024-10-16',
          last_date: '2026-07-08',
          raw_weight_total: 1000,
          raw_volume: 100390.67,
          min_raw_weight: 20,
          max_raw_weight: 85.98,
        }],
      })
      .mockResolvedValueOnce({ rows: [correctionRow()] }) // correction insert
      .mockResolvedValueOnce({ rows: [] }) // sets update
      .mockResolvedValueOnce({ rows: [] }) // exercise basis

    const result = await applyLoadCorrection({
      exerciseId: EXERCISE_ID,
      startDate: '2024-10-16',
      endDate: '2026-07-08',
      reason: 'Both arms were logged together',
    })

    expect(result.correction).toMatchObject({
      id: CORRECTION_ID,
      divisor: 2,
      previousLoadBasis: 'total',
      affectedSets: 192,
      active: true,
    })
    expect(mockTransaction).toHaveBeenCalledOnce()
    expect(queryText(mockExecute.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    const setUpdate = queryText(mockExecute.mock.calls[4]?.[0])
    expect(setUpdate).toContain('source_weight = COALESCE')
    expect(setUpdate).toContain('load_correction_id =')
    expect(setUpdate).not.toContain('side =')
    expect(queryText(mockExecute.mock.calls[5]?.[0])).toContain("load_basis = 'per_side'")
  })

  it('rejects an overlapping active correction before any row update', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: EXERCISE_ID, load_basis: 'total' }] })
      .mockResolvedValueOnce({
        rows: [{ id: CORRECTION_ID, previous_load_basis: 'total', overlaps: true }],
      })

    await expect(
      applyLoadCorrection({ exerciseId: EXERCISE_ID, startDate: '2025-01-01' }),
    ).rejects.toMatchObject({ code: 'overlap' })
    expect(mockExecute).toHaveBeenCalledTimes(2)
  })

  it('reverts exactly from source_weight and retires the durable rule', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: EXERCISE_ID }] }) // lock exercise
      .mockResolvedValueOnce({ rows: [correctionRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 's1' }, { id: 's2' }] })
      .mockResolvedValueOnce({
        rows: [correctionRow({ active: false, reverted_at: '2026-07-16T13:00:00.000Z' })],
      })
      .mockResolvedValueOnce({ rows: [] }) // no active rules remain
      .mockResolvedValueOnce({ rows: [] }) // restore the prior exercise basis

    const result = await revertLoadCorrection(EXERCISE_ID, CORRECTION_ID)

    expect(result.restoredSets).toBe(2)
    expect(result.correction.active).toBe(false)
    expect(queryText(mockExecute.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    const restore = queryText(mockExecute.mock.calls[2]?.[0])
    expect(restore).toContain('SET weight = source_weight')
    expect(restore).toContain('load_correction_id = NULL')
    expect(queryText(mockExecute.mock.calls[3]?.[0])).toContain('active = false')
    expect(queryText(mockExecute.mock.calls[5]?.[0])).toContain('load_basis =')
  })

  it('keeps per-side semantics while another correction range is active', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: EXERCISE_ID }] })
      .mockResolvedValueOnce({ rows: [correctionRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 's1' }] })
      .mockResolvedValueOnce({
        rows: [correctionRow({ active: false, reverted_at: '2026-07-16T13:00:00.000Z' })],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'another-rule' }] })

    await revertLoadCorrection(EXERCISE_ID, CORRECTION_ID)

    expect(mockExecute).toHaveBeenCalledTimes(5)
  })

  it('inherits the original basis for a second non-overlapping active range', async () => {
    const secondId = '33333333-3333-4333-8333-333333333333'
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: EXERCISE_ID, load_basis: 'per_side' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: CORRECTION_ID,
          previous_load_basis: 'total',
          overlaps: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          affected_sets: 3,
          first_date: '2026-07-09',
          last_date: '2026-07-10',
          raw_weight_total: 240,
          raw_volume: 2400,
          min_raw_weight: 80,
          max_raw_weight: 80,
        }],
      })
      .mockResolvedValueOnce({
        rows: [correctionRow({
          id: secondId,
          start_date: '2026-07-09',
          end_date: '2026-07-10',
          affected_sets: 3,
          previous_load_basis: 'total',
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await applyLoadCorrection({
      exerciseId: EXERCISE_ID,
      startDate: '2026-07-09',
      endDate: '2026-07-10',
    })

    expect(result.correction).toMatchObject({
      id: secondId,
      previousLoadBasis: 'total',
    })
    expect(stringParams(mockExecute.mock.calls[3]?.[0])).toContain('total')
  })

  it('restores that inherited original basis when the newer range is undone last', async () => {
    const secondId = '33333333-3333-4333-8333-333333333333'
    const second = correctionRow({
      id: secondId,
      start_date: '2026-07-09',
      end_date: '2026-07-10',
      previous_load_basis: 'total',
    })
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: EXERCISE_ID }] })
      .mockResolvedValueOnce({ rows: [second] })
      .mockResolvedValueOnce({ rows: [{ id: 's-new' }] })
      .mockResolvedValueOnce({
        rows: [{ ...second, active: false, reverted_at: '2026-07-16T14:00:00.000Z' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await revertLoadCorrection(EXERCISE_ID, secondId)

    expect(result.restoredSets).toBe(1)
    expect(queryText(mockExecute.mock.calls[5]?.[0])).toContain('load_basis =')
  })

  it('lists the audit trail with numeric divisors', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [correctionRow()] })
    const rows = await listLoadCorrections(EXERCISE_ID, true)
    expect(rows).toEqual([
      expect.objectContaining({ id: CORRECTION_ID, divisor: 2, affectedSets: 192 }),
    ])
  })
})
