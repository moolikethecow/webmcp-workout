/**
 * Deterministic per-muscle training/recovery state for the /health muscle map.
 * PURE — takes the flat "which muscle was hit, when, with how many sets" rows and
 * folds them into a state per region. No LLM, no DB (the route does the query).
 *
 * State model (recovery-oriented, from strength-training convention that a worked
 * muscle needs ~48–72h before it's fresh again):
 *   - `days_since` — days since the muscle was last WORKED (as a primary OR a
 *                    secondary mover). A muscle hit hard as a secondary — e.g.
 *                    triceps on incline bench — is genuinely fatigued, so it must
 *                    NOT read as rested just because it wasn't the headline lift.
 *                    (This was the bug: benching yesterday left triceps showing
 *                    "5d ago, ready" because only primary days counted.)
 *   - `recovering` — hit within the last ~2 days (still adapting; train light).
 *   - `ready`      — 2–~5 days since; recovered and due.
 *   - `fresh`      — trained historically but not recently (well past recovery);
 *                    also the resting-but-not-overdue middle.
 *   - `undertrained` — appears in almost no recent volume (needs attention).
 *   - `untrained`  — no history at all for this region.
 * "Recent" volume is the trailing 7 days of PRIMARY-mover sets; secondary sets
 * count at half. The thresholds are intentionally simple and explained in the
 * legend rather than tuned to a model. `lastPrimaryDate` is kept alongside for a
 * "last trained directly" nuance, but the headline recovery clock is last-worked.
 */
import { MUSCLE_REGIONS, type MuscleRegion } from './muscles'

export type MuscleTrainingState =
  | 'recovering'
  | 'ready'
  | 'fresh'
  | 'undertrained'
  | 'untrained'

/** One aggregated fact per (region) the query produced. */
export interface MuscleAggregate {
  region: MuscleRegion
  /** ISO date (YYYY-MM-DD) this region was last WORKED at all (primary OR
   *  secondary mover), or null. Drives the recovery clock. */
  lastWorkedDate: string | null
  /** ISO date this region was last a PRIMARY mover, or null. Kept for a
   *  "last trained directly" nuance; not the headline recovery clock. */
  lastPrimaryDate: string | null
  /** Weighted sets in the trailing 7 days (primary=1, secondary=0.5). */
  weeklySets: number
  /** Weighted sets in the 7 days BEFORE that (for a trend arrow). */
  priorWeeklySets: number
  /** Distinct exercise names that hit this region in the window (for the panel). */
  exercises: string[]
}

export interface MuscleState extends MuscleAggregate {
  state: MuscleTrainingState
  /** Days since last worked (primary or secondary) — the recovery clock. */
  daysSince: number | null
  /** Days since last a PRIMARY mover (last direct training), or null. */
  daysSincePrimary: number | null
  /** -1 down / 0 flat / +1 up, comparing weeklySets to priorWeeklySets. */
  volumeTrend: -1 | 0 | 1
}

const DAY_MS = 86_400_000

/** Whole days between an ISO date (midnight) and `now`. */
export function daysSinceDate(iso: string | null, now: Date): number | null {
  if (!iso) return null
  const then = new Date(`${iso}T00:00:00Z`).getTime()
  if (!Number.isFinite(then)) return null
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.max(0, Math.round((startOfToday - then) / DAY_MS))
}

/** Classify one region from its aggregate. Pure; thresholds live here. */
export function classifyMuscle(agg: MuscleAggregate, now: Date): MuscleState {
  // Recovery clock = last WORKED (primary OR secondary). Fall back to the
  // primary date so a caller that only tracks primary days still classifies.
  const daysSince = daysSinceDate(agg.lastWorkedDate ?? agg.lastPrimaryDate, now)
  const daysSincePrimary = daysSinceDate(agg.lastPrimaryDate, now)
  const volumeTrend: -1 | 0 | 1 =
    agg.weeklySets > agg.priorWeeklySets + 0.5
      ? 1
      : agg.weeklySets < agg.priorWeeklySets - 0.5
        ? -1
        : 0

  let state: MuscleTrainingState
  if (daysSince == null) {
    state = 'untrained'
  } else if (daysSince <= 2) {
    state = 'recovering'
  } else if (daysSince <= 5) {
    state = 'ready'
  } else {
    // Past the recovery window and not hit lately. If it's also barely in the
    // recent rotation, flag it as undertrained (needs attention); else it's just
    // fresh/rested.
    state = agg.weeklySets < 2 ? 'undertrained' : 'fresh'
  }

  return { ...agg, state, daysSince, daysSincePrimary, volumeTrend }
}

/**
 * Fold the raw per-region rows into a full state for EVERY region (regions with
 * no data come back `untrained`), so the figure always has all 15 keys.
 */
export function computeMuscleStates(
  rows: MuscleAggregate[],
  now: Date = new Date(),
): Record<MuscleRegion, MuscleState> {
  const byRegion = new Map<MuscleRegion, MuscleAggregate>()
  for (const r of rows) byRegion.set(r.region, r)

  const out = {} as Record<MuscleRegion, MuscleState>
  for (const region of MUSCLE_REGIONS) {
    const agg =
      byRegion.get(region) ??
      ({ region, lastWorkedDate: null, lastPrimaryDate: null, weeklySets: 0, priorWeeklySets: 0, exercises: [] } as MuscleAggregate)
    out[region] = classifyMuscle(agg, now)
  }
  return out
}

/** Display metadata for each state — label + the CSS var the figure fills with. */
export const STATE_META: Record<
  MuscleTrainingState,
  { label: string; color: string; hint: string }
> = {
  recovering: { label: 'Recovering', color: 'var(--danger)', hint: 'Hit in the last 2 days — still adapting' },
  ready: { label: 'Ready', color: 'var(--warning)', hint: 'Recovered and due — 2–5 days since' },
  fresh: { label: 'Fresh', color: 'var(--success)', hint: 'Rested and in the rotation' },
  undertrained: { label: 'Undertrained', color: 'var(--fg-subtle)', hint: 'Barely any recent volume — needs attention' },
  untrained: { label: 'No data', color: 'var(--border-muted)', hint: 'No logged sets hit this muscle' },
}
