/**
 * Composite daily readiness.
 *
 * Readiness here is history-only: the wearable-fused composite lives upstream,
 * so this reports no zone and every caller is written to fail open on null.
 */
export type ZoneWord = 'Primed' | 'Moderate' | 'Low'

export interface ReadinessResult {
  /** 0-100, or null when no factor could be computed. */
  score: number | null
  zone: ZoneWord | null
}

export async function computeReadiness(): Promise<ReadinessResult> {
  return { score: null, zone: null }
}
