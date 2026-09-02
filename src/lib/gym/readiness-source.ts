/**
 * readiness-source.ts — where per-region readiness comes from.
 *
 * Readiness is a *training* signal. It is derived from logged sets and nothing
 * else: when a region was last worked, and how much working volume it has taken
 * in the trailing week. It is not a recovery score, not a medical assessment,
 * and no wearable, sleep or HRV data enters this calculation.
 *
 * The interface exists because readiness is exactly the kind of thing you want
 * more than one source for — a wearable-fused source, a subjective check-in
 * source. **This repository ships the history-based source only**; it is the
 * one implementation of `ReadinessSource` here, and it is complete.
 */
import { buildMuscleMap } from '@/lib/fitness/muscle-map'
import { REGION_LABELS, type MuscleRegion, isMobilityOnlyRegion } from '@/lib/fitness/muscles'
import { STATE_META, type MuscleTrainingState } from '@/lib/fitness/muscle-state'

export interface RegionReadiness {
  /** Canonical muscle region key. */
  region: MuscleRegion
  /** Human label for the region. */
  label: string
  /** The muscle-state vocabulary: fresh | ready | recovering | undertrained | untrained. */
  status: MuscleTrainingState
  /** Whole days since this region was last worked at all, or null if never. */
  lastTrainedDaysAgo: number | null
  /** Weighted working sets in the trailing 7 days (primary 1.0, secondary 0.5). */
  recentWorkingSets: number
  /** One plain sentence explaining the status. */
  note: string
}

export interface ReadinessSource {
  /** Stable identifier reported alongside the payload, so a caller can tell
   *  which signal produced the numbers. */
  name: string
  compute(now: Date): Promise<RegionReadiness[]>
}

/** Most-rested first. A region with no logged sets at all sorts to the front —
 *  from a "what should I train" standpoint, never-trained is maximally fresh —
 *  and carries status `untrained` so the caller can tell the two apart. */
function freshestFirst(a: RegionReadiness, b: RegionReadiness): number {
  const left = a.lastTrainedDaysAgo ?? Number.POSITIVE_INFINITY
  const right = b.lastTrainedDaysAgo ?? Number.POSITIVE_INFINITY
  if (left !== right) return right - left
  if (a.recentWorkingSets !== b.recentWorkingSets) return a.recentWorkingSets - b.recentWorkingSets
  return a.label.localeCompare(b.label)
}

/**
 * The only readiness source in this repository: derived from training history
 * via `buildMuscleMap` (which reads `workout_sets`) and classified by
 * `classifyMuscle`.
 */
export const historyReadiness: ReadinessSource = {
  name: 'training-history',
  async compute(now: Date): Promise<RegionReadiness[]> {
    const map = await buildMuscleMap(now)
    // Joint regions (neck, knees, wrists, ankles) carry no strength credit and
    // only exist for the mobility lens; to an agent they are noise.
    const out: RegionReadiness[] = Object.values(map.regions)
      .filter((region) => !isMobilityOnlyRegion(region.region))
      .map((region) => ({
      region: region.region,
      label: region.label || REGION_LABELS[region.region],
      status: region.state,
      lastTrainedDaysAgo: region.daysSince,
      recentWorkingSets: region.weeklySets,
      note: STATE_META[region.state].hint,
      }))
    return out.sort(freshestFirst)
  },
}
