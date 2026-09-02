/**
 * Plate calculator (GYM_PLAN §4 "Plate calculator", P2b) — a PURE function: given a
 * target total weight and a bar weight, work out the per-side plate breakdown using a
 * standard plate set (greedy, heaviest-first). No React, no store — unit-tested in
 * isolation.
 *
 * Convention: `targetWeight` is the TOTAL loaded weight (bar + all plates), matching
 * what the logger stores for a barbell set. The breakdown is per-SIDE (one end of the
 * bar); a symmetric load is assumed. When the remainder after the bar can't be made
 * from the plate set (odd leftover), the shortfall is flagged (`remainderLb`) so the
 * UI can say "≈" rather than lie.
 */

export type PlateUnit = 'lb' | 'kg'

/** Default Olympic bar weights per unit. */
export const DEFAULT_BAR: Record<PlateUnit, number> = {
  lb: 45,
  kg: 20,
}

/** Standard commercial plate sets (heaviest → lightest), per unit. */
export const STANDARD_PLATES: Record<PlateUnit, number[]> = {
  lb: [45, 35, 25, 10, 5, 2.5],
  kg: [25, 20, 15, 10, 5, 2.5, 1.25],
}

export interface PlateBreakdown {
  /** The bar weight used (echoed for the UI). */
  barWeight: number
  /** Per-side plate list, heaviest first, e.g. [45, 25, 2.5]. */
  perSide: number[]
  /**
   * Leftover weight per side that the plate set couldn't make (0 when exact).
   * Non-zero ⇒ the target isn't achievable with these plates — the UI shows "≈".
   */
  remainderPerSide: number
  /** True when the target is below the bar itself (nothing to load). */
  belowBar: boolean
  /** True when the load is exactly achievable (remainder 0 and not below bar). */
  achievable: boolean
}

/**
 * Compute the per-side plate breakdown for a total target weight.
 *
 * @param targetWeight total loaded weight (bar + plates), in `unit`
 * @param unit         'lb' | 'kg' — selects the default bar + plate set
 * @param barWeight    override the bar (defaults to 45 lb / 20 kg)
 * @param plates       override the plate set (heaviest-first not required — sorted)
 */
export function computePlates(
  targetWeight: number,
  unit: PlateUnit,
  barWeight: number = DEFAULT_BAR[unit],
  plates: number[] = STANDARD_PLATES[unit],
): PlateBreakdown {
  const bar = barWeight
  // Below (or exactly) the bar → nothing to load.
  if (!Number.isFinite(targetWeight) || targetWeight <= bar) {
    return {
      barWeight: bar,
      perSide: [],
      remainderPerSide: 0,
      belowBar: targetWeight < bar,
      achievable: targetWeight === bar,
    }
  }

  // Weight to distribute across BOTH sides, then per side.
  let perSideRemaining = round2((targetWeight - bar) / 2)
  const sorted = [...plates].sort((a, b) => b - a).filter((p) => p > 0)
  const perSide: number[] = []

  for (const plate of sorted) {
    // Greedily take as many of this plate as fit into the per-side remainder.
    while (round2(perSideRemaining - plate) >= 0) {
      perSide.push(plate)
      perSideRemaining = round2(perSideRemaining - plate)
    }
  }

  return {
    barWeight: bar,
    perSide,
    remainderPerSide: perSideRemaining,
    belowBar: false,
    achievable: perSideRemaining === 0,
  }
}

/** Round to 2dp to kill binary-float drift (2.5 subtraction chains). */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Format a breakdown as the compact per-side label the pad sheet shows:
 *   "45 · 25 · 2.5 per side"  |  "just the bar"  |  "45 · 25 ≈ (+1.2) per side".
 */
export function formatPlateLabel(b: PlateBreakdown, unit: PlateUnit): string {
  if (b.belowBar) return `below the ${unit === 'kg' ? '20kg' : '45lb'} bar`
  if (b.perSide.length === 0) return 'just the bar'
  const list = b.perSide.map((p) => trim(p)).join(' · ')
  if (b.remainderPerSide > 0) return `${list} ≈ (+${trim(b.remainderPerSide)}) per side`
  return `${list} per side`
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

/**
 * Whether the plate calculator is relevant for an exercise — i.e. it loads a
 * barbell. Prefers the structured `equipment` / `category` tokens (FEDB 'barbell')
 * when present; falls back to a conservative NAME heuristic since the active-workout
 * read model may not carry those fields yet. Kept pure + tested.
 */
export function isBarbellExercise(input: {
  name?: string | null
  equipment?: string | null
  category?: string | null
}): boolean {
  const eq = (input.equipment ?? '').toLowerCase()
  const cat = (input.category ?? '').toLowerCase()
  if (eq === 'barbell' || cat === 'barbell') return true
  if (eq && eq !== 'barbell') return false // structured non-barbell → trust it
  const name = (input.name ?? '').toLowerCase()
  if (/\bbarbell\b/.test(name)) return true
  // Exclude clearly non-barbell variants before the classic-lift fallback.
  if (/\b(dumbbell|db|machine|cable|smith|kettlebell|band|bodyweight)\b/.test(name)) return false
  return /\b(bench press|squat|deadlift|overhead press|ohp|clean|snatch|row|front squat|rdl|romanian deadlift)\b/.test(
    name,
  )
}
