import { beforeEach, describe, expect, it, vi } from 'vitest'

import { collapseWs, sqlParams, sqlText } from '@/lib/gym/__tests__/sql-text'

const mockExecute = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db/client', () => ({ db: { execute: mockExecute } }))

const { ActiveLoadCorrectionError, getExerciseDetail, patchExercise } = await import('../exercise-detail')

beforeEach(() => mockExecute.mockReset())

const exerciseRow = {
  id: 'e1',
  name: 'Barbell Bench Press',
  category: 'strength',
  equipment: 'barbell',
  primary_muscle: 'chest',
  secondary_muscles: ['triceps'],
  tracks: 'weight_reps',
  load_basis: 'total',
  is_custom: false,
  ai_filled: false,
  tracked_at: null,
  disliked_at: null,
  dislike_reason: null,
  catalog_slug: null,
  instructions: [],
  images: [],
  default_rest_seconds: 120,
  rest_seconds_warmup: 60,
  preferred_unit: null,
}

function setRow(overrides: Record<string, unknown> = {}) {
  return {
    workout_id: 'w1',
    workout_name: 'Push',
    day: '2026-07-14',
    set_number: 1,
    set_type: 'normal',
    weight: '220.46226218',
    weight_unit: 'lb',
    reps: 10,
    distance_m: null,
    duration_s: null,
    rpe: '8',
    side: null,
    logical_set_id: 'logical-1',
    ...overrides,
  }
}

describe('getExerciseDetail display-unit boundary', () => {
  it('returns records, mixed-unit history, and charts entirely in the app unit', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [exerciseRow] })
      .mockResolvedValueOnce({
        rows: [
          setRow(),
          setRow({ set_number: 2, weight: '100', weight_unit: 'kg', logical_set_id: 'logical-2' }),
        ],
      })

    const detail = await getExerciseDetail('e1', 'kg')

    expect(detail?.weightUnit).toBe('kg')
    expect(detail?.records.bestWeight).toMatchObject({ value: 100, unit: 'kg' })
    expect(detail?.records.bestE1rm).toMatchObject({ unit: 'kg', weight: 100 })
    expect(detail?.records.bestSetVolume).toMatchObject({
      value: 1000,
      unit: 'kg',
      weight: 100,
    })
    expect(detail?.records.repMaxes).toEqual([
      expect.objectContaining({ reps: 10, weight: 100, unit: 'kg' }),
    ])

    expect(detail?.history[0]?.sets).toEqual([
      expect.objectContaining({ setNumber: 1, weight: 100, unit: 'kg' }),
      expect.objectContaining({ setNumber: 2, weight: 100, unit: 'kg' }),
    ])
    expect(detail?.charts.e1rm[0]?.value).toBeCloseTo(133.3, 1)
    expect(detail?.charts.volume[0]?.value).toBeCloseTo(2000, 1)
    expect(detail?.charts.bestSet[0]?.value).toBeCloseTo(1000, 1)
  })

  it('defaults internal callers to canonical pounds', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [exerciseRow] })
      .mockResolvedValueOnce({ rows: [setRow({ weight: '100', weight_unit: 'kg' })] })

    const detail = await getExerciseDetail('e1')

    expect(detail?.weightUnit).toBe('lb')
    expect(detail?.records.bestWeight?.unit).toBe('lb')
    expect(detail?.history[0]?.sets[0]).toMatchObject({ weight: 220.46, unit: 'lb' })
  })

  it('shows per-side strength records while counting Both and split rows as logical sets', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ ...exerciseRow, name: 'Bayesian Bicep Curl', load_basis: 'per_side' }] })
      .mockResolvedValueOnce({
        rows: [
          setRow({ weight: '42.5', reps: 10, logical_set_id: 'both-1' }),
          setRow({ set_number: 2, weight: '45', reps: 10, side: 'left', logical_set_id: 'split-2' }),
          setRow({ set_number: 3, weight: '45', reps: 10, side: 'right', logical_set_id: 'split-2' }),
        ],
      })

    const detail = await getExerciseDetail('e1')

    expect(detail?.exercise).toMatchObject({ loadBasis: 'per_side', sets: 2 })
    expect(detail?.records.bestWeight).toMatchObject({ value: 45, unit: 'lb' })
    expect(detail?.records.bestE1rm?.value).toBe(60)
    expect(detail?.records.bestSetVolume?.value).toBe(900)
    expect(detail?.charts.volume[0]?.value).toBe(1750)
    expect(detail?.charts.bestSet[0]?.value).toBe(900)
    expect(detail?.history[0]?.sets.map((set) => [set.logicalSetId, set.side])).toEqual([
      ['both-1', null],
      ['split-2', 'left'],
      ['split-2', 'right'],
    ])
  })
})

describe('patchExercise load-basis guard', () => {
  it('requires an active Strong correction to be undone before switching to total', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'correction-1' }] })

    await expect(patchExercise('e1', { loadBasis: 'total' })).rejects.toBeInstanceOf(
      ActiveLoadCorrectionError,
    )
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })
})

// #1840 follow-up. The side-labelled set rows only appear for a row whose
// `per_side` is true, and NOTHING could set that after creation — the catalog
// generator's name heuristic skips `modality: 'strength'` by design, and the
// patch surface had no field for it. So every strength unilateral was stuck
// ungrouped with no way to correct it.
describe('patchExercise per_side', () => {
  /** Serve the post-update detail re-read so patchExercise can resolve. */
  function stubPatchReads(perSide: boolean) {
    mockExecute.mockImplementation(async (query: unknown) => {
      const text = sqlText(query)
      if (text.includes('FROM exercises e')) {
        return { rows: [{ ...exerciseRow, per_side: perSide }] }
      }
      if (text.includes('UPDATE exercises SET')) return { rows: [{ id: 'e1' }] }
      return { rows: [] }
    })
  }

  function updateCall(): unknown {
    return mockExecute.mock.calls.map(([q]) => q).find((q) => sqlText(q).includes('UPDATE exercises SET'))
  }

  function updateStatement(): string {
    return collapseWs(sqlText(updateCall()))
  }

  it('writes the flag, and does not confuse it with load_basis', async () => {
    stubPatchReads(true)

    const detail = await patchExercise('e1', { perSide: true })

    expect(updateStatement()).toContain('per_side =')
    // load_basis is a DIFFERENT column with overlapping vocabulary — a
    // per-side-EXECUTION edit must never rewrite per-side-LOAD semantics.
    expect(updateStatement()).not.toContain('load_basis =')
    // No load-basis change means the active-correction guard must not run.
    expect(
      mockExecute.mock.calls.map(([q]) => sqlText(q)).some((s) => s.includes('exercise_load_corrections')),
    ).toBe(false)
    // The bound value must be the boolean itself — a statement that merely
    // MENTIONS the column proves nothing about what it writes.
    expect(sqlParams(updateCall())).toContain(true)
    // And the flag must read back on the detail, or no surface can show it.
    expect(detail?.exercise.perSide).toBe(true)
  })

  it('can turn the flag back off', async () => {
    stubPatchReads(false)

    const detail = await patchExercise('e1', { perSide: false })

    expect(updateStatement()).toContain('per_side =')
    expect(sqlParams(updateCall())).toContain(false)
    expect(detail?.exercise.perSide).toBe(false)
  })

  it('is left alone when not supplied', async () => {
    stubPatchReads(false)

    await patchExercise('e1', { primaryMuscle: 'abs' })

    expect(updateStatement()).toContain('primary_muscle =')
    expect(updateStatement()).not.toContain('per_side =')
  })
})

// #1876 — the "Preference" replace-reason chip persists as preferred_at, mirroring
// the existing tracked_at "keep this on my radar" flag.
describe('patchExercise preferred', () => {
  function stubPatchReads() {
    mockExecute.mockImplementation(async (query: unknown) => {
      const text = sqlText(query)
      if (text.includes('FROM exercises e')) return { rows: [exerciseRow] }
      if (text.includes('UPDATE exercises SET')) return { rows: [{ id: 'e1' }] }
      return { rows: [] }
    })
  }

  function updateStatement(): string {
    const call = mockExecute.mock.calls.map(([q]) => q).find((q) => sqlText(q).includes('UPDATE exercises SET'))
    return collapseWs(sqlText(call))
  }

  it('stamps preferred_at when set true', async () => {
    stubPatchReads()
    await patchExercise('e1', { preferred: true })
    expect(updateStatement()).toContain('preferred_at = now()')
  })

  it('clears preferred_at when set false', async () => {
    stubPatchReads()
    await patchExercise('e1', { preferred: false })
    expect(updateStatement()).toContain('preferred_at = NULL')
  })

  it('is left alone when not supplied', async () => {
    stubPatchReads()
    await patchExercise('e1', { primaryMuscle: 'abs' })
    expect(updateStatement()).not.toContain('preferred_at')
  })
})

