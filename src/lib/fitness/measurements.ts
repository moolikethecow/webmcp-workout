/**
 * Body-measurement presentation helpers — the canonical label, display order, and
 * "which direction is good" for every metric that lands in body_measurements.
 * Shared by the read model and the Body section so labels + ordering never
 * drift.
 *
 * Historically the UI surfaced only a hardcoded 6 metrics; everything else was
 * imported but hidden. This module is the allow-EVERYTHING replacement: any metric
 * present renders, ordered head-to-toe, unknown slugs falling to the end.
 */

/** Head-to-toe display order; composition summary first. Unknown metrics sort last. */
export const MEASUREMENT_ORDER: string[] = [
  'weight',
  'body_fat',
  'lean_mass',
  'neck',
  'shoulders',
  'chest',
  'bicep_left',
  'bicep_right',
  'forearm_left',
  'forearm_right',
  'waist',
  'hips',
  'thigh_left',
  'thigh_right',
  'calf_left',
  'calf_right',
]

const MEASUREMENT_LABELS: Record<string, string> = {
  weight: 'Weight',
  body_fat: 'Body fat',
  lean_mass: 'Lean mass',
  neck: 'Neck',
  shoulders: 'Shoulders',
  chest: 'Chest',
  bicep_left: 'Bicep (L)',
  bicep_right: 'Bicep (R)',
  forearm_left: 'Forearm (L)',
  forearm_right: 'Forearm (R)',
  waist: 'Waist',
  hips: 'Hips',
  thigh_left: 'Thigh (L)',
  thigh_right: 'Thigh (R)',
  calf_left: 'Calf (L)',
  calf_right: 'Calf (R)',
}

/** Friendly label for a metric slug; unknowns humanize the slug (bicep_left → "bicep left"). */
export function measurementLabel(metric: string): string {
  return MEASUREMENT_LABELS[metric] ?? metric.replace(/_/g, ' ')
}

/** Sort key for a metric — its index in MEASUREMENT_ORDER, unknowns last (alphabetical). */
export function measurementRank(metric: string): number {
  const i = MEASUREMENT_ORDER.indexOf(metric)
  return i === -1 ? MEASUREMENT_ORDER.length : i
}

/** Metrics where a DOWN trend is the good/green direction. Circumferences are neutral. */
export function lowerIsBetter(metric: string): boolean {
  return metric === 'weight' || metric === 'body_fat' || metric === 'waist'
}

/** Color token for an all-time delta given the metric's good-direction (neutral when not down-good). */
export function measurementDeltaColor(metric: string, delta: number): string {
  if (!lowerIsBetter(metric)) return 'var(--fg-subtle)'
  return delta < 0 ? 'var(--success)' : 'var(--danger)'
}
