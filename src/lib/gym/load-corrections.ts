/**
 * Reversible normalization for Strong history whose entered weight represented
 * the combined load across two matched sides. The canonical set weight becomes
 * per-side, while `source_weight` always preserves the exact imported number.
 *
 * Corrections are durable rules, not one-off row edits: importStrong reads the
 * active rules and reapplies them whenever it refreshes Strong rows. Historical
 * matched work remains one row with side=NULL; this lane never invents separate
 * left/right measurements.
 */
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db/client'

export const STRONG_IMPORT_SOURCE = 'strong-import' as const

export type LoadCorrectionCode = 'not_found' | 'overlap' | 'inactive'

export class LoadCorrectionError extends Error {
  constructor(
    readonly code: LoadCorrectionCode,
    message: string,
  ) {
    super(message)
    this.name = 'LoadCorrectionError'
  }
}

export interface LoadCorrection {
  id: string
  exerciseId: string
  source: typeof STRONG_IMPORT_SOURCE
  startDate: string | null
  endDate: string | null
  divisor: number
  previousLoadBasis: 'total' | 'per_side'
  reason: string | null
  active: boolean
  affectedSets: number
  createdAt: string
  revertedAt: string | null
}

export interface LoadCorrectionScope {
  exerciseId: string
  startDate?: string | null
  endDate?: string | null
  divisor?: number
  reason?: string | null
}

export interface LoadCorrectionPreview {
  exerciseId: string
  source: typeof STRONG_IMPORT_SOURCE
  startDate: string | null
  endDate: string | null
  divisor: number
  affectedSets: number
  firstDate: string | null
  lastDate: string | null
  rawWeightTotal: number
  correctedWeightTotal: number
  minRawWeight: number | null
  maxRawWeight: number | null
  minCorrectedWeight: number | null
  maxCorrectedWeight: number | null
  /** Both sides were matched, so dividing weight and counting two sides keeps
   * total work numerically identical. */
  rawVolume: number
  correctedMatchedVolume: number
}

interface CorrectionDbRow {
  id: string
  exercise_id: string
  source: string
  start_date: string | null
  end_date: string | null
  divisor: string | number
  previous_load_basis: string
  reason: string | null
  active: boolean
  affected_sets: number
  created_at: string
  reverted_at: string | null
}

interface PreviewDbRow {
  affected_sets: number | string
  first_date: string | null
  last_date: string | null
  raw_weight_total: number | string | null
  raw_volume: number | string | null
  min_raw_weight: number | string | null
  max_raw_weight: number | string | null
}

function finiteNumber(value: number | string | null | undefined): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function correctionFromRow(row: CorrectionDbRow): LoadCorrection {
  return {
    id: row.id,
    exerciseId: row.exercise_id,
    source: STRONG_IMPORT_SOURCE,
    startDate: row.start_date,
    endDate: row.end_date,
    divisor: finiteNumber(row.divisor),
    previousLoadBasis: row.previous_load_basis === 'per_side' ? 'per_side' : 'total',
    reason: row.reason,
    active: row.active,
    affectedSets: row.affected_sets,
    createdAt: row.created_at,
    revertedAt: row.reverted_at,
  }
}

function scopeValues(input: LoadCorrectionScope): {
  startDate: string | null
  endDate: string | null
  divisor: number
} {
  const divisor = input.divisor ?? 2
  if (!Number.isFinite(divisor) || divisor <= 0) {
    throw new RangeError('divisor must be a positive finite number')
  }
  return {
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    divisor,
  }
}

/** List one exercise's correction audit trail, newest first. */
export async function listLoadCorrections(
  exerciseId: string,
  includeReverted = false,
): Promise<LoadCorrection[]> {
  const rows = (
    await db.execute(sql`
      SELECT c.id, c.exercise_id, c.source, c.start_date::text AS start_date,
        c.end_date::text AS end_date, c.divisor::text AS divisor,
        c.previous_load_basis, c.reason, c.active,
        CASE WHEN c.active THEN (
          SELECT count(*)::int FROM workout_sets ws WHERE ws.load_correction_id = c.id
        ) ELSE c.affected_sets END AS affected_sets,
        c.created_at::text AS created_at, c.reverted_at::text AS reverted_at
      FROM exercise_load_corrections c
      WHERE c.exercise_id = ${exerciseId}
        AND c.source = ${STRONG_IMPORT_SOURCE}
        AND (${includeReverted} OR (c.active = true AND c.reverted_at IS NULL))
      ORDER BY c.created_at DESC, c.id DESC
    `)
  ).rows as unknown as CorrectionDbRow[]
  return rows.map(correctionFromRow)
}

type SqlExecutor = Pick<typeof db, 'execute'>

async function previewWith(
  executor: SqlExecutor,
  input: LoadCorrectionScope,
): Promise<LoadCorrectionPreview> {
  const { startDate, endDate, divisor } = scopeValues(input)
  const [row] = (
    await executor.execute(sql`
      SELECT count(*)::int AS affected_sets,
        min(w.started_at::date)::text AS first_date,
        max(w.started_at::date)::text AS last_date,
        COALESCE(sum(COALESCE(ws.source_weight, ws.weight)), 0)::float8 AS raw_weight_total,
        COALESCE(sum(COALESCE(ws.source_weight, ws.weight) * COALESCE(ws.reps, 0)), 0)::float8 AS raw_volume,
        min(COALESCE(ws.source_weight, ws.weight))::float8 AS min_raw_weight,
        max(COALESCE(ws.source_weight, ws.weight))::float8 AS max_raw_weight
      FROM workout_sets ws
      JOIN workout_exercises we ON we.id = ws.workout_exercise_id
      JOIN workouts w ON w.id = we.workout_id
      WHERE we.exercise_id = ${input.exerciseId}
        AND w.source = ${STRONG_IMPORT_SOURCE}
        AND w.status = 'completed'
        AND COALESCE(ws.source_weight, ws.weight) IS NOT NULL
        AND (${startDate}::date IS NULL OR w.started_at::date >= ${startDate}::date)
        AND (${endDate}::date IS NULL OR w.started_at::date <= ${endDate}::date)
    `)
  ).rows as unknown as PreviewDbRow[]
  const rawWeightTotal = finiteNumber(row?.raw_weight_total)
  const rawVolume = finiteNumber(row?.raw_volume)
  const minRawWeight = row?.min_raw_weight == null ? null : finiteNumber(row.min_raw_weight)
  const maxRawWeight = row?.max_raw_weight == null ? null : finiteNumber(row.max_raw_weight)
  return {
    exerciseId: input.exerciseId,
    source: STRONG_IMPORT_SOURCE,
    startDate,
    endDate,
    divisor,
    affectedSets: Math.trunc(finiteNumber(row?.affected_sets)),
    firstDate: row?.first_date ?? null,
    lastDate: row?.last_date ?? null,
    rawWeightTotal,
    correctedWeightTotal: rawWeightTotal / divisor,
    minRawWeight,
    maxRawWeight,
    minCorrectedWeight: minRawWeight == null ? null : minRawWeight / divisor,
    maxCorrectedWeight: maxRawWeight == null ? null : maxRawWeight / divisor,
    rawVolume,
    correctedMatchedVolume: rawVolume * (2 / divisor),
  }
}

/** Read-only impact preview. Dates are inclusive and only completed Strong rows
 * are eligible. */
export async function previewLoadCorrection(
  input: LoadCorrectionScope,
): Promise<LoadCorrectionPreview> {
  return previewWith(db, input)
}

/** Apply one durable, non-overlapping correction rule. */
export async function applyLoadCorrection(
  input: LoadCorrectionScope,
): Promise<{ correction: LoadCorrection; preview: LoadCorrectionPreview }> {
  const { startDate, endDate, divisor } = scopeValues(input)
  return db.transaction(async (tx) => {
    // Serialize correction changes for this exercise and fail honestly if the
    // exercise disappeared between preview and apply.
    const exerciseRows = (
      await tx.execute(sql`
        SELECT id, load_basis FROM exercises WHERE id = ${input.exerciseId} FOR UPDATE
      `)
    ).rows as unknown as Array<{ id: string; load_basis: string }>
    if (exerciseRows.length === 0) {
      throw new LoadCorrectionError('not_found', 'Exercise not found')
    }

    const activeRules = (
      await tx.execute(sql`
        SELECT id, previous_load_basis,
          (
            (end_date IS NULL OR ${startDate}::date IS NULL OR end_date >= ${startDate}::date)
            AND
            (start_date IS NULL OR ${endDate}::date IS NULL OR start_date <= ${endDate}::date)
          ) AS overlaps
        FROM exercise_load_corrections
        WHERE exercise_id = ${input.exerciseId}
          AND source = ${STRONG_IMPORT_SOURCE}
          AND active = true
          AND reverted_at IS NULL
        ORDER BY created_at, id
        FOR UPDATE
      `)
    ).rows as unknown as Array<{
      id: string
      previous_load_basis: string
      overlaps: boolean
    }>
    if (activeRules.some((rule) => rule.overlaps)) {
      throw new LoadCorrectionError(
        'overlap',
        'An active history correction already overlaps that date range',
      )
    }
    // Every active date range belongs to one load-basis transition. Inheriting
    // the first rule's original basis makes final Undo exact in any order.
    const inheritedBasis = activeRules[0]?.previous_load_basis
    const previousLoadBasis = inheritedBasis === 'total' || inheritedBasis === 'per_side'
      ? inheritedBasis
      : exerciseRows[0]!.load_basis === 'per_side'
        ? 'per_side'
        : 'total'

    const preview = await previewWith(tx as unknown as SqlExecutor, {
      ...input,
      startDate,
      endDate,
      divisor,
    })
    const [inserted] = (
      await tx.execute(sql`
        INSERT INTO exercise_load_corrections
          (exercise_id, source, start_date, end_date, divisor, previous_load_basis, reason, active, affected_sets)
        VALUES
          (${input.exerciseId}, ${STRONG_IMPORT_SOURCE}, ${startDate}::date,
           ${endDate}::date, ${divisor}, ${previousLoadBasis}, ${input.reason ?? null}, true,
           ${preview.affectedSets})
        RETURNING id, exercise_id, source, start_date::text AS start_date,
          end_date::text AS end_date, divisor::text AS divisor, previous_load_basis, reason, active,
          affected_sets, created_at::text AS created_at,
          reverted_at::text AS reverted_at
      `)
    ).rows as unknown as CorrectionDbRow[]
    if (!inserted) throw new Error('Correction insert returned no row')

    await tx.execute(sql`
      UPDATE workout_sets ws
      SET source_weight = COALESCE(ws.source_weight, ws.weight),
          weight = COALESCE(ws.source_weight, ws.weight) / ${divisor},
          load_correction_id = ${inserted.id}
      FROM workout_exercises we, workouts w
      WHERE we.id = ws.workout_exercise_id
        AND w.id = we.workout_id
        AND we.exercise_id = ${input.exerciseId}
        AND w.source = ${STRONG_IMPORT_SOURCE}
        AND w.status = 'completed'
        AND COALESCE(ws.source_weight, ws.weight) IS NOT NULL
        AND (${startDate}::date IS NULL OR w.started_at::date >= ${startDate}::date)
        AND (${endDate}::date IS NULL OR w.started_at::date <= ${endDate}::date)
    `)
    await tx.execute(sql`
      UPDATE exercises SET load_basis = 'per_side' WHERE id = ${input.exerciseId}
    `)

    return { correction: correctionFromRow(inserted), preview }
  })
}

/** Undo one correction exactly from source_weight. The raw value remains stored
 * as provenance, while future Strong imports ignore the now-inactive rule. */
export async function revertLoadCorrection(
  exerciseId: string,
  correctionId: string,
): Promise<{ correction: LoadCorrection; restoredSets: number }> {
  return db.transaction(async (tx) => {
    // All import/apply/revert paths acquire the exercise row first. Besides
    // serializing row rewrites, this prevents two final reverts from both seeing
    // another active rule and leaving the exercise stuck on per_side.
    const exerciseRows = (
      await tx.execute(sql`
        SELECT id FROM exercises WHERE id = ${exerciseId} FOR UPDATE
      `)
    ).rows as unknown as Array<{ id: string }>
    if (exerciseRows.length === 0) {
      throw new LoadCorrectionError('not_found', 'Exercise not found')
    }
    const [row] = (
      await tx.execute(sql`
        SELECT id, exercise_id, source, start_date::text AS start_date,
          end_date::text AS end_date, divisor::text AS divisor, previous_load_basis, reason, active,
          affected_sets, created_at::text AS created_at,
          reverted_at::text AS reverted_at
        FROM exercise_load_corrections
        WHERE id = ${correctionId}
          AND exercise_id = ${exerciseId}
          AND source = ${STRONG_IMPORT_SOURCE}
        FOR UPDATE
      `)
    ).rows as unknown as CorrectionDbRow[]
    if (!row) throw new LoadCorrectionError('not_found', 'Correction not found')
    if (!row.active || row.reverted_at != null) {
      throw new LoadCorrectionError('inactive', 'Correction has already been reverted')
    }

    const restored = (
      await tx.execute(sql`
        UPDATE workout_sets
        SET weight = source_weight,
            load_correction_id = NULL
        WHERE load_correction_id = ${correctionId}
          AND source_weight IS NOT NULL
        RETURNING id
      `)
    ).rows as unknown as Array<{ id: string }>

    const [reverted] = (
      await tx.execute(sql`
        UPDATE exercise_load_corrections
        SET active = false, reverted_at = now()
        WHERE id = ${correctionId}
        RETURNING id, exercise_id, source, start_date::text AS start_date,
          end_date::text AS end_date, divisor::text AS divisor, previous_load_basis, reason, active,
          affected_sets, created_at::text AS created_at,
          reverted_at::text AS reverted_at
      `)
    ).rows as unknown as CorrectionDbRow[]
    if (!reverted) throw new Error('Correction revert returned no row')
    const remaining = (
      await tx.execute(sql`
        SELECT id FROM exercise_load_corrections
        WHERE exercise_id = ${exerciseId}
          AND source = ${STRONG_IMPORT_SOURCE}
          AND active = true AND reverted_at IS NULL
        LIMIT 1
      `)
    ).rows as unknown as Array<{ id: string }>
    if (remaining.length === 0) {
      await tx.execute(sql`
        UPDATE exercises SET load_basis = ${row.previous_load_basis}
        WHERE id = ${exerciseId}
      `)
    }
    return { correction: correctionFromRow(reverted), restoredSets: restored.length }
  })
}
