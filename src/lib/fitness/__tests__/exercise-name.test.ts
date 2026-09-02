/**
 * Name-resolution split-brain (#1871).
 *
 * `manage_exercise action:"create"` reported `created:false, "already existed"`
 * for "Bodyweight Squat" and "Stairmaster", which `manage_exercise get` and the
 * template resolver then could not find. Creation matched on the UNIQUE index
 * (case-SENSITIVE, blind to `archived_at`); lookup matched on
 * `lower(name) AND archived_at IS NULL`. Two axes, disagreeing independently.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { normalizeExerciseName, normalizedNameSql } from '../exercise-name'

const mockExecute = vi.hoisted(() => vi.fn())
const mockInsert = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/client', () => ({
  db: { execute: mockExecute, insert: mockInsert, update: mockUpdate },
}))
vi.mock('@/lib/db/ensure-fitness', () => ({
  ensureExerciseTrackingColumn: vi.fn(),
  ensureFitnessTables: vi.fn(),
  ensureGymSchema: vi.fn(),
}))

import { collapseWs, sqlText } from '@/lib/gym/__tests__/sql-text'
import { createCustomExercise } from '../catalog'

const sqlOf = (call: unknown[]) => collapseWs(sqlText(call[0]))
const allSql = () => mockExecute.mock.calls.map(sqlOf).join(' ')

const CATALOG_ROW = {
  id: 'ex-1',
  name: 'Bodyweight Squat',
  category: null,
  primary_muscle: 'quadriceps',
  modality: 'strength',
  per_side: false,
  is_custom: false,
  tracked_at: '2026-08-31T00:00:00.000Z',
  sets: 0,
  last_performed: null,
}

beforeEach(() => {
  mockExecute.mockReset()
  mockInsert.mockReset()
  mockUpdate.mockReset()
  mockUpdate.mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) })
})

describe('normalizeExerciseName', () => {
  // Both axes that disagreed, plus the punctuation fold that stops a second
  // row being created under a different spelling of the same movement.
  it.each([
    ['Bodyweight Squat', 'bodyweight squat'],
    ['  Stairmaster  ', 'stairmaster'],
    ['Pull-Up', 'pull up'],
    ['pull_up', 'pull up'],
    ['Cable   Row', 'cable row'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeExerciseName(input)).toBe(expected)
  })

  // Plurals are for DUPLICATE REPORTING, not for resolution: silently routing
  // "Rows" onto "Row" would log sets against a movement nobody named.
  it('does not fold plurals', () => {
    expect(normalizeExerciseName('Pull Ups')).not.toBe(normalizeExerciseName('Pull Up'))
  })

  it('has a SQL twin that applies the same folds', () => {
    const text = collapseWs(sqlText(normalizedNameSql('name')))
    expect(text).toContain('lower(trim(')
    expect(text).toContain("[-_[:space:]]+")
  })
})

describe('createCustomExercise restores an archived row', () => {
  // The bug in one test: create said "already existed" and left the row
  // archived, so every lookup still reported it missing. Creating is an
  // explicit statement that the movement should exist.
  it('un-archives the match and reports restored', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: 'ex-1', isArchived: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [CATALOG_ROW] })

    const res = await createCustomExercise({ name: 'Bodyweight Squat' })

    expect(res.created).toBe(false)
    expect(res.restored).toBe(true)
    expect(allSql()).toContain('archived_at = NULL')
    // Never inserted — that would have violated the unique index anyway.
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('reports restored:false when the existing row was not archived', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: 'ex-1', isArchived: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [CATALOG_ROW] })

    const res = await createCustomExercise({ name: 'Bodyweight Squat' })
    expect(res).toMatchObject({ created: false, restored: false })
  })

  // The existence check must NOT filter archived rows — that filter is what
  // made an archived row look absent to the lookup and present to the insert.
  it('looks for the existing row WITHOUT the archived filter', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: 'ex-1', isArchived: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [CATALOG_ROW] })

    await createCustomExercise({ name: 'Bodyweight Squat' })
    expect(sqlOf(mockExecute.mock.calls[0]!)).not.toContain('archived_at IS NULL')
  })

  // The case axis: the unique index would have accepted a second row.
  it('matches an existing row that differs only by case', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: 'ex-1', isArchived: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [CATALOG_ROW] })

    await createCustomExercise({ name: 'bodyweight squat' })
    const params = JSON.stringify(mockExecute.mock.calls[0]![0])
    expect(params).toContain('bodyweight squat')
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('still inserts when nothing matches', async () => {
    mockExecute
      // name lookup → nothing
      .mockResolvedValueOnce({ rows: [] })
      // INSERT … ON CONFLICT DO NOTHING RETURNING id → a fresh row
      .mockResolvedValueOnce({ rows: [{ id: 'new-1' }] })
      // read-back
      .mockResolvedValueOnce({ rows: [{ ...CATALOG_ROW, name: 'Stairmaster' }] })

    const res = await createCustomExercise({ name: 'Stairmaster', modality: 'cardio' })
    expect(res).toMatchObject({ created: true, restored: false })
    expect(allSql()).toContain('INSERT INTO exercises')
  })
})
