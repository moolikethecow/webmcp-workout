/**
 * Canonical unilateral-load semantics shared by records, finish summaries, and
 * every future SQL/read boundary. Stored weight remains the entered per-set
 * value; only volume applies a side multiplier.
 */

export type LoadBasis = 'total' | 'per_side'
export type SetSide = 'left' | 'right' | null

/** Fail closed to the historical convention so old/cache payloads never double. */
export function normalizeLoadBasis(value: unknown): LoadBasis {
  return value === 'per_side' ? 'per_side' : 'total'
}

/** NULL is the canonical Both/not-applicable value. Any unknown wire value also
 * degrades to Both; write boundaries remain responsible for strict validation. */
export function normalizeSetSide(value: unknown): SetSide {
  return value === 'left' || value === 'right' ? value : null
}

/** Physical-load multiplier for one stored row.
 *
 * - total: entered weight is already the full load, regardless of side marker
 * - per_side + Both(NULL): one row represents equal work by two sides => ×2
 * - per_side + L/R: the row represents only that side => ×1
 */
export function loadVolumeMultiplier(loadBasis: LoadBasis, side: SetSide): 1 | 2 {
  return loadBasis === 'per_side' && side == null ? 2 : 1
}

/** One row's contribution to volume, in the same weight unit as `weight`. */
export function loadVolume(
  weight: number,
  reps: number,
  loadBasis: LoadBasis = 'total',
  side: SetSide = null,
): number {
  if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(reps) || reps <= 0) return 0
  return weight * reps * loadVolumeMultiplier(loadBasis, side)
}

/** Stable grouping key for logical-set aggregation. Legacy/test inputs without a
 * logical id remain separate by using the caller-provided row fallback. */
export function logicalSetKey(logicalSetId: string | null | undefined, fallback: string | number): string {
  return logicalSetId && logicalSetId.length > 0 ? `logical:${logicalSetId}` : `row:${fallback}`
}
