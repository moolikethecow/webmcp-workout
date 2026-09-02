/**
 * Pure shaping for the swap-sheet alternatives (GYM_PLAN §4 replace / §6 swap
 * sheet). Kept out of route.ts so it is testable without a DB — the route builds
 * the pools (via coach-context) + resolves the source exercise's region, then
 * hands both to `shapeAlternatives`.
 *
 * Deterministic per §6: NO LLM. `alternativesForProfile` ranks candidates on the
 * source exercise's FULL muscle profile — primary + secondary, not primary alone
 * (#1876) — staleness-tiebroken; this module only maps each PoolExercise → the
 * wire shape the SwapSheet renders (name, pattern, staleness hint, same-muscles
 * chips, an ISO lastPerformed derived from daysSinceLast).
 */
import {
  alternativesForProfile,
  type Pool,
  type PoolExercise,
} from '@/lib/gym/novelty'
import { REGION_LABELS, type MuscleHit, type MuscleRegion } from '@/lib/fitness/muscles'

/** One alternative row on the wire (consumed by SwapSheet). */
export interface AlternativeRow {
  exerciseId: string
  name: string
  /** Movement pattern token ('horizontal-push', 'squat', …) — a coarse grouping hint. */
  pattern: string
  /** The primary muscle region this alternative trains (same as the source's). */
  region: MuscleRegion
  /** Human region label ("Chest") for the same-muscles chip. */
  regionLabel: string
  /** Staleness score (higher = staler = fresher variety). Rounded 1dp. */
  staleness: number
  /** Whole days since last performed, or null if never performed. */
  daysSinceLast: number | null
  /** A short freshness hint, e.g. "fresh · 6w since last" / "new — never done". */
  freshness: string
}

export interface AlternativesResponse {
  /** The source exercise's resolved primary region (null when unresolvable). */
  region: MuscleRegion | null
  regionLabel: string | null
  alternatives: AlternativeRow[]
}

/** Days-since → a terse freshness hint for the swap row. Pure. */
export function freshnessHint(daysSinceLast: number | null): string {
  if (daysSinceLast == null) return 'new — never done'
  if (daysSinceLast <= 3) return 'did it recently'
  const weeks = Math.round(daysSinceLast / 7)
  if (weeks >= 1) return `fresh · ${weeks}w since last`
  return `fresh · ${daysSinceLast}d since last`
}

/** ISO date `daysSinceLast` days before `now` (UTC date only), or null. Pure —
 *  `now` is injectable so a test pins the output. */
export function lastPerformedIso(daysSinceLast: number | null, now = Date.now()): string | null {
  if (daysSinceLast == null) return null
  const d = new Date(now - daysSinceLast * 86_400_000)
  return d.toISOString().slice(0, 10)
}

/** Map one PoolExercise → the wire row. Pure. */
export function toRow(pe: PoolExercise): AlternativeRow {
  return {
    exerciseId: pe.id,
    name: pe.name,
    pattern: pe.pattern,
    region: pe.region,
    regionLabel: REGION_LABELS[pe.region] ?? pe.region,
    staleness: Math.round(pe.staleness * 10) / 10,
    daysSinceLast: pe.daysSinceLast,
    freshness: freshnessHint(pe.daysSinceLast),
  }
}

/**
 * Shape the swap-sheet response from the pools + the source exercise's FULL
 * muscle profile (primary + secondary hits, #1876). Returns the top `n`
 * alternatives ranked across every region the source trains (source excluded).
 * `region`/`regionLabel` on the response still name the source's PRIMARY region
 * (the header chip), but the ranked list is no longer limited to that one region.
 * An empty profile (pure-cardio / unmapped source) yields an empty list and the
 * SwapSheet falls back to manual search. Pure.
 */
export function shapeAlternatives(
  pools: Map<string, Pool>,
  profile: MuscleHit[],
  sourceExerciseId: string,
  n: number,
): AlternativesResponse {
  const primary = profile.find((h) => h.weight === 1) ?? profile[0]
  if (!primary) {
    return { region: null, regionLabel: null, alternatives: [] }
  }
  const alts = alternativesForProfile(pools, profile, sourceExerciseId, n)
  return {
    region: primary.region,
    regionLabel: REGION_LABELS[primary.region] ?? primary.region,
    alternatives: alts.map(toRow),
  }
}
