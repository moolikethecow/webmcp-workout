/**
 * The deterministic variety engine (GYM_PLAN §6, review-mandated).
 *
 * The LLM is where SAMENESS comes from, not variety — so the variety is
 * manufactured deterministically here and the model only orders/schemes the
 * result. This module builds **rotation pools per (region × movement-pattern ×
 * equipment-class)** from the enriched exercise catalog, scores each exercise for
 * STALENESS (days-since-last × frequency-weight), and `dealSlate()` samples the
 * pools weighted toward staleness — deterministic given a seed, so the same
 * request produces the same slate and a test can pin it.
 *
 * PURE by design: every function here takes plain data (the DB read that feeds it
 * lives in coach-context.ts). No `Math.random` anywhere — a seeded mulberry32 PRNG
 * is threaded through so determinism is a property, not a hope.
 *
 * Equipment compatibility, dislike filtering, and injury filtering are applied at
 * pool-build time so a dealt slate is always feasible in the user's actual gym.
 */
import type { MuscleHit, MuscleRegion } from '@/lib/fitness/muscles'
import { isBareMuscleName, musclesForExerciseEnriched } from '@/lib/fitness/muscles'
import { displayExerciseName } from './display-name'
import {
  exerciseAllowedWithInjuries,
  type ExerciseInjuryProfile,
  type InjuryConstraint,
} from './injury-profile'

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic, no Math.random in lib code.
// ---------------------------------------------------------------------------

/** A deterministic 0..1 generator. Seed with `seedFromString` for a date-derived
 *  seed so "the same day + same context" always deals the same slate. */
export type Rng = () => number

/** mulberry32 — tiny, fast, well-distributed 32-bit PRNG. Given the same seed it
 *  always yields the same sequence. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Hash an arbitrary string into a 32-bit seed (FNV-1a). Deterministic. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// Movement pattern derivation (name / force / mechanic keywords)
// ---------------------------------------------------------------------------

export type MovementPattern =
  | 'horizontal-push'
  | 'vertical-push'
  | 'horizontal-pull'
  | 'vertical-pull'
  | 'squat'
  | 'hinge'
  | 'lunge'
  | 'carry'
  | 'jump'
  | 'calf-raise'
  | 'stability'
  | 'olympic'
  | 'core'
  | `isolation-${MuscleRegion}`
  | 'isolation'
  | 'other'

/** One catalog exercise, as the pool builder consumes it. Mirrors the enriched
 *  `exercises` columns the DB read hands in (coach-context.ts). */
export interface CatalogExercise {
  id: string
  name: string
  primaryMuscle: string | null
  secondaryMuscles: string[]
  /** FEDB equipment token ('barbell' | 'dumbbell' | 'cable' | 'machine' | …) or null. */
  equipment: string | null
  /** FEDB force ('push' | 'pull' | 'static') or null. */
  force: string | null
  /** FEDB mechanic ('compound' | 'isolation') or null. */
  mechanic: string | null
  /** Set → hard-excluded (only the explicit "Don't like it" chip writes it). */
  disliked: boolean
  /** Set → explicitly preferred (the "Preferred it" replace-reason chip, #1876).
   *  Biases replacement/drafting ranking toward it; not mutually exclusive with
   *  `disliked` at the type level, though the UI never lets both be set. */
  preferred: boolean
  /** Days since last performed (null = never performed). */
  daysSinceLast: number | null
  /** Working sets logged in the trailing ~28d (recency/frequency weight). */
  recentSets: number
  archived: boolean
  /** The user has explicitly cleared this movement despite an active injury. The
   *  injury gate is skipped for it — nothing else is. */
  injuryOverride?: boolean
  /** Temporary staleness cooldown (the "Bored of it" reason chip). While in the
   *  future the exercise is skipped from rotation pools — a SOFT, self-expiring
   *  exclusion distinct from the hard `disliked`. Null/past = not snoozed. */
  snoozedUntil?: Date | string | null
  /** Explicit anatomical/support demand metadata. Null/untrusted fails closed
   *  when a limiting/out injury is active. */
  injuryProfile: ExerciseInjuryProfile | null
}

/** Is a snooze cooldown still active (in the future) relative to `now`? A null or
 *  past `snoozed_until` means the exercise is eligible again. Pure + shared by the
 *  pool build and the coach-context read. */
export function isSnoozed(snoozedUntil: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (snoozedUntil == null) return false
  const t = snoozedUntil instanceof Date ? snoozedUntil.getTime() : Date.parse(String(snoozedUntil))
  return Number.isFinite(t) && t > now.getTime()
}

// ---------------------------------------------------------------------------
// Gym equipment jsonb shape (flat list OR structured with exclusions)
// ---------------------------------------------------------------------------

/**
 * A gym's `equipment` jsonb is either a flat token list (`string[]`) or the
 * structured shape the logger's "Not available here" chip writes:
 *   { categories?: string[], machines?: string[], machines_excluded?: string[] }
 * `categories` = FEDB equipment tokens the gym has; `machines` = free-text machine
 * names; `machines_excluded` = exercise NAMES the user marked unavailable at this
 * gym (per-gym exclusion). Both shapes are supported so a legacy flat list keeps
 * working and coach-context can keep flattening to a token list.
 */
export interface GymEquipment {
  categories?: string[]
  machines?: string[]
  machines_excluded?: string[]
}

/** Flatten either equipment shape into the availability token list (categories +
 *  free-text machines) that `gymCompatible` matches against. A flat array is
 *  returned as-is. Null/empty → null (no filter). */
export function gymEquipmentTokens(equipment: string[] | GymEquipment | null | undefined): string[] | null {
  if (!equipment) return null
  if (Array.isArray(equipment)) return equipment.length > 0 ? equipment : null
  const cats = Array.isArray(equipment.categories) ? equipment.categories : []
  const machines = Array.isArray(equipment.machines) ? equipment.machines : []
  const all = [...cats, ...machines].filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
  return all.length > 0 ? all : null
}

/** The per-gym excluded exercise NAMES (the "Not available here" list). Empty for a
 *  flat-array equipment shape (which carries no exclusions). Lowercased + trimmed. */
export function gymExcludedNames(equipment: string[] | GymEquipment | null | undefined): string[] {
  if (!equipment || Array.isArray(equipment)) return []
  const ex = Array.isArray(equipment.machines_excluded) ? equipment.machines_excluded : []
  return ex.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim().toLowerCase())
}

/** Keyword rules → movement pattern. First match wins; ordered specific→general.
 *  Mirrors the muscle-mapper's philosophy: the NAME teaches the pattern. */
interface PatternRule {
  all: string[]
  not?: string[]
  pattern: MovementPattern
  /** Match `all`/`not` tokens on a leading word boundary (`\b<token>`) instead of a
   *  bare substring. Opt-in for short/ambiguous tokens so "hop" matches "hops"/
   *  "hopping" but NOT "woodchop" — the hard-won lesson that a raw substring test
   *  over-matches (e.g. "stretch" inside "outstretched"). Legacy rules omit it and
   *  keep their substring behavior unchanged. */
  boundary?: boolean
}

/** Leading-word-boundary token test used by rules that opt in via `boundary`. The
 *  needle must begin on a word boundary in `haystack` (`\b<needle>`); a trailing
 *  boundary is deliberately NOT required so "jump" still catches "jumping"/"jumps".
 *  `haystack` is already lowercased by the caller. */
function tokenOnWordBoundary(haystack: string, needle: string): boolean {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${esc}`).test(haystack)
}

const PATTERN_RULES: PatternRule[] = [
  // Olympic / explosive triple-extension lifts — a clean or snatch catches load
  // through a violent ankle+knee extension, and "clean AND PRESS" would otherwise
  // classify as a press. FIRST in the list so the explosive component wins over
  // the press/pull token. (Live leak: "barbell clean and press" dealt into an
  // ankles-out draft because no pattern owned "clean".)
  { all: ['clean'], boundary: true, pattern: 'olympic' },
  { all: ['snatch'], boundary: true, pattern: 'olympic' },
  { all: ['jerk'], boundary: true, pattern: 'olympic' },
  { all: ['high pull'], pattern: 'olympic' },
  { all: ['push press'], pattern: 'olympic' },
  // Hinge (before deadlift-as-squat confusion; RDL/good-morning are hinges)
  { all: ['romanian', 'deadlift'], pattern: 'hinge' },
  { all: ['rdl'], pattern: 'hinge' },
  { all: ['stiff', 'deadlift'], pattern: 'hinge' },
  { all: ['deadlift'], pattern: 'hinge' },
  { all: ['hip thrust'], pattern: 'hinge' },
  { all: ['good morning'], pattern: 'hinge' },
  { all: ['back extension'], pattern: 'hinge' },
  { all: ['hyperextension'], pattern: 'hinge' },
  { all: ['kettlebell', 'swing'], pattern: 'hinge' },

  // Lunge / single-leg
  { all: ['lunge'], pattern: 'lunge' },
  { all: ['split squat'], pattern: 'lunge' },
  { all: ['bulgarian'], pattern: 'lunge' },
  { all: ['step up'], pattern: 'lunge' },
  { all: ['step-up'], pattern: 'lunge' },

  // Squat (compound knee-dominant)
  { all: ['squat'], pattern: 'squat' },
  { all: ['leg press'], pattern: 'squat' },
  { all: ['hack squat'], pattern: 'squat' },

  // Vertical push
  { all: ['overhead press'], pattern: 'vertical-push' },
  { all: ['shoulder press'], pattern: 'vertical-push' },
  { all: ['military press'], pattern: 'vertical-push' },
  { all: ['arnold press'], pattern: 'vertical-push' },
  { all: ['ohp'], pattern: 'vertical-push' },

  // Horizontal push
  { all: ['bench press'], pattern: 'horizontal-push' },
  { all: ['chest press'], pattern: 'horizontal-push' },
  // FEDB often names dumbbell/barbell variants "Incline Press" or "Decline
  // Press" without the word "bench" and leaves force/mechanic null.
  { all: ['incline', 'press'], pattern: 'horizontal-push' },
  { all: ['decline', 'press'], pattern: 'horizontal-push' },
  { all: ['push up'], pattern: 'horizontal-push' },
  { all: ['push-up'], pattern: 'horizontal-push' },
  { all: ['pushup'], pattern: 'horizontal-push' },
  { all: ['dip'], not: ['tricep'], pattern: 'horizontal-push' },

  // Vertical pull
  { all: ['pull up'], pattern: 'vertical-pull' },
  { all: ['pull-up'], pattern: 'vertical-pull' },
  { all: ['pullup'], pattern: 'vertical-pull' },
  { all: ['chin up'], pattern: 'vertical-pull' },
  { all: ['chin-up'], pattern: 'vertical-pull' },
  { all: ['pulldown'], pattern: 'vertical-pull' },
  { all: ['pull down'], pattern: 'vertical-pull' },

  // Horizontal pull
  { all: ['row'], pattern: 'horizontal-pull' },
  { all: ['face pull'], pattern: 'horizontal-pull' },

  // Calf raise / press — direct ankle-joint load under the calves. Needs its own
  // pattern so an ankle injury can gate it: a bare mechanic:'isolation' would key it
  // only to 'isolation-calves', invisible to the joint-load map. Ankle-only (calves
  // drive the ankle, not the knee), so the knees set doesn't exclude it.
  // Matched on the bare 'calf'/'calves' token, not just the 'calf raise'/'calf
  // press' phrase — FEDB has calf-loading entries named after the muscle alone
  // ("Standing Calves", "Lever Rotary Calf") that the phrase-only match missed,
  // silently leaking calf work into an ankles-out draft (issue #1203). 'calves'
  // needs its own token because "calf" isn't a substring of "calves". `not:
  // ['stretch']` keeps calf STRETCHES (no ankle-joint strength load) out of this
  // strength-only pattern.
  { all: ['calf'], not: ['stretch'], boundary: true, pattern: 'calf-raise' },
  { all: ['calves'], not: ['stretch'], boundary: true, pattern: 'calf-raise' },

  // Jump / plyometric — dynamic ankle + knee load on take-off and landing. Placed
  // AFTER push/pull/squat/lunge so a "Jump Squat" stays a squat and a "Plyo Push-up"
  // stays a push; only pure jumps/hops land here. Word-bounded (\b) so "hop" catches
  // "hops"/"hopping" but not "woodchop" (which stays 'core').
  { all: ['jump'], boundary: true, pattern: 'jump' },
  { all: ['plyo'], boundary: true, pattern: 'jump' },
  { all: ['hop'], boundary: true, pattern: 'jump' },

  // Balance / agility / stability drills — dynamic single-leg or unstable-surface
  // ankle & knee load that NO strength movement class catches: these credit
  // calves/quads/glutes as the primary muscle but the contraindication is joint
  // STABILITY, not muscle load, so a region-only injury check misses them (the
  // "balance board" / "quick feet" leak). Placed AFTER the strength families so a
  // "Balancing Squat" stays a 'squat'. Word-bounded (\b) so "balance" catches
  // "balance board"/"single-leg balance" but never a legit loaded lift.
  { all: ['balance'], boundary: true, pattern: 'stability' },
  { all: ['wobble'], boundary: true, pattern: 'stability' },
  { all: ['bosu'], boundary: true, pattern: 'stability' },
  { all: ['quick feet'], pattern: 'stability' },
  { all: ['agility'], boundary: true, pattern: 'stability' },
  { all: ['ladder'], boundary: true, pattern: 'stability' },

  // Carry
  { all: ['carry'], pattern: 'carry' },
  { all: ['farmer'], pattern: 'carry' },

  // Core
  { all: ['plank'], pattern: 'core' },
  { all: ['crunch'], pattern: 'core' },
  { all: ['sit up'], pattern: 'core' },
  { all: ['sit-up'], pattern: 'core' },
  { all: ['situp'], pattern: 'core' },
  { all: ['leg raise'], pattern: 'core' },
  { all: ['knee raise'], pattern: 'core' },
  { all: ['russian twist'], pattern: 'core' },
  { all: ['woodchop'], pattern: 'core' },
  { all: ['ab wheel'], pattern: 'core' },
  { all: ['ab roller'], pattern: 'core' },
  { all: ['hollow'], pattern: 'core' },
]

/** FEDB leaves `mechanic` null on many obvious single-joint rows. Named compound
 * rules above always win; these conservative accessory tokens keep those legacy
 * rows out of compound pools without pretending every unknown movement is safe
 * to classify. */
const ACCESSORY_NAME_TOKENS = [
  'curl',
  'extension',
  'lateral raise',
  'front raise',
  'rear raise',
  'fly',
  'flye',
  'pec deck',
  'pushdown',
  'pressdown',
  'kickback',
  'skull crusher',
  'shrug',
  'adduction',
  'abduction',
  'pullover',
]

/**
 * Derive a movement pattern from an exercise. Name keywords win; then a
 * mechanic:'isolation' row becomes `isolation-<primary region>` (so a "Bicep Curl"
 * and a "Tricep Pushdown" land in DIFFERENT isolation pools and don't crowd each
 * other out). Everything else falls back to force-derived push/pull or 'other'.
 */
export function movementPattern(ex: {
  name: string
  primaryMuscle: string | null
  secondaryMuscles?: string[]
  force: string | null
  mechanic: string | null
}): MovementPattern {
  const n = ex.name.toLowerCase()
  for (const rule of PATTERN_RULES) {
    const has = rule.boundary ? (k: string) => tokenOnWordBoundary(n, k) : (k: string) => n.includes(k)
    if (rule.not && rule.not.some(has)) continue
    if (rule.all.every(has)) return rule.pattern
  }
  // Catalog naming is not a safety boundary. A live ankles-out proposal still
  // admitted "Smith Toe Raise" after the calf-token fix because its enriched
  // primary region was calves but its name contained neither calf nor calves
  // (#1216). Treat any remaining calf-primary strength row as ankle-loading.
  // Explicit stretches/circles are mobility work; named jump/stability drills
  // have already returned from the more specific rules above.
  const primaryRegion = primaryRegionOf(ex)
  if (primaryRegion === 'calves' && !n.includes('stretch') && !n.includes('circle')) {
    return 'calf-raise'
  }
  // Isolation → key by the primary region so isolation pools don't blend.
  if (ex.mechanic === 'isolation') {
    return primaryRegion ? (`isolation-${primaryRegion}` as MovementPattern) : 'isolation'
  }
  if (ACCESSORY_NAME_TOKENS.some((token) => n.includes(token))) {
    return primaryRegion ? (`isolation-${primaryRegion}` as MovementPattern) : 'isolation'
  }
  // Force fallback for un-named compounds.
  if (ex.force === 'push') return 'horizontal-push'
  if (ex.force === 'pull') return 'horizontal-pull'
  return 'other'
}

/** The dominant (primary) region of an exercise via the enriched muscle mapper. */
function primaryRegionOf(ex: {
  name: string
  primaryMuscle: string | null
  secondaryMuscles?: string[]
}): MuscleRegion | null {
  const hits = musclesForExerciseEnriched(ex.name, ex.primaryMuscle, ex.secondaryMuscles ?? [])
  const primary = hits.find((h) => h.weight === 1) ?? hits[0]
  return primary?.region ?? null
}

// ---------------------------------------------------------------------------
// Equipment class + gym compatibility
// ---------------------------------------------------------------------------

/** FEDB equipment values (13) collapsed into the coarse "class" the coach reasons
 *  about. Bodyweight is always allowed; unknown/null → 'other'. */
export type EquipmentClass =
  | 'barbell'
  | 'dumbbell'
  | 'machine'
  | 'cable'
  | 'bodyweight'
  | 'kettlebell'
  | 'bands'
  | 'other'

/**
 * Equipment token → coarse class.
 *
 * ⚠️ TWO VOCABULARIES MEET HERE and they are not the same list. The My-Gyms
 * checklist (`GYM_EQUIPMENT_VOCAB`) speaks FEDB v1 — "body only", "kettlebells",
 * "e-z curl bar". The shipped catalog speaks the v2 dataset it is generated
 * from — "body weight", "kettlebell", "ez barbell". Only barbell, dumbbell,
 * cable and medicine ball are spelled the same in both.
 *
 * Every token from BOTH vocabularies must appear here, because the class is the
 * only thing the two sides can be compared on. An unmapped token silently
 * becomes 'other', which is not a loud failure — it is an exercise quietly
 * dropping out of every drafted workout.
 *
 * Measured against the shipped catalog before this was filled in: 18 tokens
 * covering 542 of 1318 rows fell through to 'other', including ALL 324
 * bodyweight movements — which made the `cls === 'bodyweight'` escape hatch
 * below dead code and would have hidden every calisthenics exercise the moment
 * a gym equipment checklist was saved.
 */
const EQUIP_TO_CLASS: Record<string, EquipmentClass> = {
  // — barbells —
  barbell: 'barbell',
  'e-z curl bar': 'barbell',
  'ez bar': 'barbell',
  'ez barbell': 'barbell',
  'olympic barbell': 'barbell',
  'trap bar': 'barbell',
  // — free weights —
  dumbbell: 'dumbbell',
  kettlebells: 'kettlebell',
  kettlebell: 'kettlebell',
  // — machines (an assisted pull-up/dip station IS a machine) —
  machine: 'machine',
  'leverage machine': 'machine',
  'smith machine': 'machine',
  'sled machine': 'machine',
  assisted: 'machine',
  'stationary bike': 'machine',
  'elliptical machine': 'machine',
  'stepmill machine': 'machine',
  'skierg machine': 'machine',
  'upper body ergometer': 'machine',
  cable: 'cable',
  // — bodyweight. "weighted" lands here on purpose: a weighted pull-up uses the
  //   same station as an unweighted one, and this class already treats "needs a
  //   bar" as available (a plain pull-up is 'body weight' too). —
  'body only': 'bodyweight',
  bodyweight: 'bodyweight',
  'body weight': 'bodyweight',
  weighted: 'bodyweight',
  // — bands —
  bands: 'bands',
  band: 'bands',
  'resistance band': 'bands',
  // — everything genuinely miscellaneous —
  'medicine ball': 'other',
  'exercise ball': 'other',
  'stability ball': 'other',
  'bosu ball': 'other',
  'foam roll': 'other',
  roller: 'other',
  'wheel roller': 'other',
  rope: 'other',
  hammer: 'other',
  tire: 'other',
  other: 'other',
}

/** Every equipment token this codebase knows — both vocabularies. Exported so a
 *  caller can expand one token into its class siblings (the Exercises-tab
 *  filter) instead of re-deriving the mapping. */
export const EQUIPMENT_TOKENS: readonly string[] = Object.keys(EQUIP_TO_CLASS)

export function equipmentClass(equipment: string | null): EquipmentClass {
  if (!equipment) return 'other'
  return EQUIP_TO_CLASS[equipment.trim().toLowerCase()] ?? 'other'
}

/**
 * Is `ex` doable in the given gym? Rules:
 *   - null gymEquipment (no default gym / no equipment listed) → everything allowed.
 *   - bodyweight is ALWAYS allowed.
 *   - otherwise the exercise's equipment token must be one of the gym's listed
 *     equipment tokens (case-insensitive), OR the exercise name must contain a
 *     listed free-text machine string (so "Hammer Strength Row" matches a gym that
 *     lists "hammer strength").
 * `gymEquipment` is the raw jsonb list (FEDB tokens + free-text machine names).
 */
export function gymCompatible(
  ex: { name: string; equipment: string | null },
  gymEquipment: string[] | null,
  /** Per-gym excluded exercise NAMES (the "Not available here" chip). An exact
   *  case-insensitive name match here fails compatibility regardless of equipment. */
  excludedNames: string[] = [],
): boolean {
  // Per-gym exclusion is a hard gate — checked first, independent of equipment.
  // Defensively lowercase both sides (gymExcludedNames already lowercases, but a
  // direct caller might not).
  if (excludedNames.length > 0) {
    const target = ex.name.trim().toLowerCase()
    if (excludedNames.some((n) => n.trim().toLowerCase() === target)) return false
  }
  if (!gymEquipment || gymEquipment.length === 0) return true
  const cls = equipmentClass(ex.equipment)
  if (cls === 'bodyweight') return true

  const listed = gymEquipment.map((e) => e.trim().toLowerCase()).filter(Boolean)
  if (listed.length === 0) return true

  const exEquip = (ex.equipment ?? '').trim().toLowerCase()
  // Compare on CLASS from both sides. Comparing a checklist token against a
  // class is what made "kettlebells" (what the user ticks) miss "kettlebell" (what
  // the catalog says) — the two vocabularies only ever agree once normalized.
  if (exEquip && listed.includes(exEquip)) return true
  if (listed.some((l) => equipmentClass(l) === cls)) return true

  // Free-text machine match: a listed machine string appears in the exercise name.
  const name = ex.name.toLowerCase()
  for (const l of listed) {
    // Skip the coarse equipment-class words for the substring test (they'd
    // over-match: "cable" appears in tons of names). Only free-text machine
    // names (multi-word or not a known class token) drive the name match.
    if (l.length >= 4 && !(l in EQUIP_TO_CLASS) && name.includes(l)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/** Never-performed exercises get this many "days since" — stale enough to surface
 *  (novelty) but not so stale they crowd out a genuinely rotated-out staple. */
export const NEVER_PERFORMED_DAYS = 60
/** Days-since is capped so an ancient exercise can't dominate the weighting. */
export const STALENESS_DAY_CAP = 90

/**
 * Staleness score for one exercise (higher = staler = more novel). Days-since
 * (capped) is the base; a frequency weight PULLS DOWN exercises used heavily in the
 * recent window (so a staple you did 3× this month reads fresh even if today is day
 * 3). Deterministic, pure.
 *
 *   score = min(daysSince, CAP) × frequencyWeight
 *   frequencyWeight = 1 / (1 + recentSets/4)   (0 sets → 1.0; 8 sets → 0.33)
 */
export function stalenessScore(ex: Pick<CatalogExercise, 'daysSinceLast' | 'recentSets'>): number {
  const days = ex.daysSinceLast == null ? NEVER_PERFORMED_DAYS : Math.min(ex.daysSinceLast, STALENESS_DAY_CAP)
  const freqWeight = 1 / (1 + Math.max(0, ex.recentSets) / 4)
  return days * freqWeight
}

// ---------------------------------------------------------------------------
// Injury-aware anatomical demand (GYM_PLAN §6 injury constraints)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/** One rotation pool = every eligible exercise sharing a (region, pattern,
 *  equipmentClass) key, each carrying its staleness score, staleness-desc. */
export interface Pool {
  region: MuscleRegion
  pattern: MovementPattern
  equipmentClass: EquipmentClass
  exercises: PoolExercise[]
}

export interface PoolExercise {
  id: string
  name: string
  pattern: MovementPattern
  equipmentClass: EquipmentClass
  region: MuscleRegion
  staleness: number
  daysSinceLast: number | null
  injuryProfile: ExerciseInjuryProfile | null
  /** The "Preferred it" replace-reason chip (#1876) — `alternativesForProfile`
   *  ranks these first, ahead of profile-match strength/staleness. */
  preferred: boolean
}

/** A pool key string (region|pattern|equipClass). Stable + sortable. */
export function poolKey(region: MuscleRegion, pattern: MovementPattern, ec: EquipmentClass): string {
  return `${region}|${pattern}|${ec}`
}

/**
 * Build rotation pools from the catalog. An exercise appears in a pool for EACH
 * region it credits as a PRIMARY mover (weight 1) — so a bench press is in the
 * chest pool, a deadlift in hamstrings+glutes+lower_back. Secondary-only regions
 * don't seed pools (they'd flood every region with assistance movements).
 *
 * Filters (all applied here so a pool is always feasible):
 *   - not archived, not disliked, not snoozed (temporary "bored" cooldown);
 *   - gym-equipment-compatible (when a default gym with equipment exists),
 *     honoring the per-gym "Not available here" exclusion list;
 *   - compatible with every active limiting/out injury according to the exercise's
 *     explicit anatomical/support profile. Missing/untrusted metadata fails closed.
 *
 * `gymEquipment` accepts either the flat token list (legacy / coach-context) or the
 * structured `{categories, machines, machines_excluded}` jsonb — both are handled.
 *
 * PURE — the DB read that produces `catalog` lives in coach-context.ts.
 */
export function buildPools(
  catalog: CatalogExercise[],
  gymEquipment: string[] | GymEquipment | null,
  injuries: InjuryConstraint[] = [],
): Map<string, Pool> {
  const pools = new Map<string, Pool>()
  const tokens = gymEquipmentTokens(gymEquipment)
  const excluded = gymExcludedNames(gymEquipment)

  for (const ex of catalog) {
    if (ex.archived || ex.disliked) continue
    // Degenerate imported row named as a bare muscle word ("quads"): never a real
    // movement — keep it out of AI rotation pools (data untouched; eligibility only).
    if (isBareMuscleName(ex.name)) continue
    // Soft, self-expiring cooldown ("Bored of it") — skip while still snoozed.
    if (isSnoozed(ex.snoozedUntil)) continue
    if (!gymCompatible(ex, tokens, excluded)) continue

    const pattern = movementPattern(ex)
    // An explicit override means the user has cleared THIS movement; every other
    // filter still applies to it.
    if (!ex.injuryOverride && !exerciseAllowedWithInjuries(ex.injuryProfile, injuries).allowed) continue
    const ec = equipmentClass(ex.equipment)
    const staleness = stalenessScore(ex)

    const hits = musclesForExerciseEnriched(ex.name, ex.primaryMuscle, ex.secondaryMuscles)
    const primaryRegions = hits.filter((h) => h.weight === 1).map((h) => h.region)
    // No primary region resolved (pure cardio / unknown) → skip; it can't anchor
    // a region target.
    if (primaryRegions.length === 0) continue

    for (const region of primaryRegions) {
      const key = poolKey(region, pattern, ec)
      let pool = pools.get(key)
      if (!pool) {
        pool = { region, pattern, equipmentClass: ec, exercises: [] }
        pools.set(key, pool)
      }
      pool.exercises.push({
        id: ex.id,
        name: displayExerciseName(ex.name),
        pattern,
        equipmentClass: ec,
        region,
        staleness,
        daysSinceLast: ex.daysSinceLast,
        injuryProfile: ex.injuryProfile,
        preferred: ex.preferred,
      })
    }
  }

  // Sort each pool staleness-desc (stalest first), tie-break by name for
  // determinism (so ordering never depends on catalog row order).
  for (const pool of pools.values()) {
    pool.exercises.sort((a, b) => b.staleness - a.staleness || a.name.localeCompare(b.name))
  }
  return pools
}

/**
 * Why a catalog exercise is missing from the rotation pools — the SAME filter
 * chain as buildPools, in the same order, naming the FIRST tripped filter in
 * user-readable text. Null = it would be eligible (or is archived/degenerate,
 * which isn't worth surfacing as "hidden"). PURE. Lets search surfaces say
 * "cable pushdowns exist but your active ankle injury hides them" instead of
 * returning a silent empty list.
 */
export function poolExclusionReason(
  ex: CatalogExercise,
  gymEquipment: string[] | GymEquipment | null,
  injuries: InjuryConstraint[] = [],
): string | null {
  if (ex.archived || isBareMuscleName(ex.name)) return null
  if (ex.disliked) return 'marked disliked'
  if (isSnoozed(ex.snoozedUntil)) return 'snoozed ("bored of it")'
  if (!gymCompatible(ex, gymEquipmentTokens(gymEquipment), gymExcludedNames(gymEquipment))) {
    return 'not available at this gym'
  }
  const verdict = ex.injuryOverride
    ? ({ allowed: true } as const)
    : exerciseAllowedWithInjuries(ex.injuryProfile, injuries)
  if (!verdict.allowed) {
    if (verdict.reason === 'site_demand') {
      return `blocked by your active ${verdict.blockingSites.join('/')} injury`
    }
    if (verdict.reason === 'untrusted_profile') {
      return 'held back while an injury is active (movement profile not yet verified)'
    }
    return 'held back by an active injury'
  }
  // buildPools' LAST filter, which this used to omit: an exercise whose name and
  // muscle columns resolve to no primary region can't anchor a region target, so
  // it is skipped. Without this branch such a row fell through to `null` —
  // reported as "would be eligible" while being invisible everywhere. That is the
  // silent case, because unlike a dislike or an injury nothing about the row
  // looks wrong: it is active, liked, and in the gym. (Live 2026-08-26: "Kegels"
  // has primary_muscle NULL and returned zero matches with no explanation; 132 of
  // 2324 catalog rows are in this state.)
  if (musclesForExerciseEnriched(ex.name, ex.primaryMuscle, ex.secondaryMuscles).every((h) => h.weight !== 1)) {
    return 'no primary muscle set — it can\'t be placed in a rotation pool'
  }
  return null
}

/**
 * How many DISTINCT eligible exercises a region's pools hold (post equipment/injury/
 * dislike/snooze/degenerate filtering — pools are already filtered at build time).
 * The split chooser uses this to detect when an injury has gutted a region's pool
 * below the depth needed to fill its volume target. PURE.
 */
export function poolDepthForRegion(pools: Map<string, Pool>, region: MuscleRegion): number {
  return regionCandidates(pools, region).length
}

/** Every pool exercise for a region (across all patterns/equipment), preferred
 *  first (#1876 "Preferred it" chip), then staleness-desc. */
function regionCandidates(pools: Map<string, Pool>, region: MuscleRegion): PoolExercise[] {
  const out: PoolExercise[] = []
  for (const pool of pools.values()) {
    if (pool.region === region) out.push(...pool.exercises)
  }
  // Dedupe by exercise id (an exercise can be in multiple equip/pattern pools for
  // the SAME region only if patterns differ — but id is unique per region here).
  const seen = new Set<string>()
  const deduped: PoolExercise[] = []
  for (const e of out.sort(
    (a, b) => Number(b.preferred) - Number(a.preferred) || b.staleness - a.staleness || a.name.localeCompare(b.name),
  )) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    deduped.push(e)
  }
  return deduped
}

// ---------------------------------------------------------------------------
// Dealing a slate
// ---------------------------------------------------------------------------

/** A per-region working-set target the slate must hit. */
export interface RegionTarget {
  region: MuscleRegion
  workingSets: number
}

/** One anchor-template exercise (tune mode) — the structure to honor. */
export interface AnchorExercise {
  exerciseId: string
  region: MuscleRegion
  /** Flagged for a swap (injured/unavailable/bored/excluded) → replace from pools. */
  swap?: boolean
}

export interface DealSlateOptions {
  /** Exercise ids to never deal (shuffle excludes the prior proposal's ids). */
  exclude?: string[]
  /** Tune mode: keep these template exercises unless flagged/excluded/unavailable. */
  anchorTemplate?: AnchorExercise[]
}

/** One dealt exercise slot + its region and the target sets it carries. */
export interface DealtExercise {
  exerciseId: string
  name: string
  region: MuscleRegion
  pattern: MovementPattern
  equipmentClass: EquipmentClass
  sets: number
  staleness: number
  /** True when this slot came from the anchor template verbatim (tune mode). */
  fromAnchor: boolean
  injuryProfile: ExerciseInjuryProfile | null
}

export interface Slate {
  exercises: DealtExercise[]
}

/**
 * Deal a slate: for each region target, pick exercise(s) sampling the region's pool
 * weighted toward staleness, honoring the anchor template when given.
 *
 *   - DRAFT (no anchor): for each region target, pick roughly one exercise per ~3
 *     working sets (min 1), staleness-weighted, no repeats. The picked exercise
 *     carries an even share of the region's target sets.
 *   - TUNE (anchor given): keep every anchor exercise whose region still has a
 *     target and that isn't flagged/excluded/unavailable; for flagged/unavailable
 *     ones, swap in a staleness-weighted pick from the same region's pool that
 *     isn't already used. Sets carry from the region target split.
 *
 * Deterministic given `rng` (seed it from a date-derived string upstream).
 */
export function dealSlate(
  pools: Map<string, Pool>,
  regionTargets: RegionTarget[],
  rng: Rng,
  opts: DealSlateOptions = {},
): Slate {
  const exclude = new Set(opts.exclude ?? [])
  const used = new Set<string>()
  const dealt: DealtExercise[] = []

  // Index anchor exercises by region for tune mode.
  const anchorByRegion = new Map<MuscleRegion, AnchorExercise[]>()
  for (const a of opts.anchorTemplate ?? []) {
    const arr = anchorByRegion.get(a.region) ?? []
    arr.push(a)
    anchorByRegion.set(a.region, arr)
  }

  for (const target of regionTargets) {
    const region = target.region
    const cands = regionCandidates(pools, region).filter(
      (e) => !exclude.has(e.id) && !used.has(e.id),
    )
    const anchors = anchorByRegion.get(region) ?? []

    if (anchors.length > 0) {
      // ── Tune mode: honor the anchor structure. ──
      const slotsForRegion = anchors.length
      const perSlotSets = splitSets(target.workingSets, slotsForRegion)
      let slotIdx = 0
      for (const a of anchors) {
        const sets = perSlotSets[slotIdx] ?? 1
        slotIdx += 1
        const meta = candidateMeta(pools, region, a.exerciseId)
        const flagged = a.swap === true || exclude.has(a.exerciseId) || meta == null
        if (!flagged) {
          // Keep the anchor exercise verbatim.
          used.add(a.exerciseId)
          dealt.push({
            exerciseId: a.exerciseId,
            name: meta?.name ?? a.exerciseId,
            region,
            pattern: meta?.pattern ?? 'other',
            equipmentClass: meta?.equipmentClass ?? 'other',
            sets,
            staleness: meta?.staleness ?? 0,
            fromAnchor: true,
            injuryProfile: meta?.injuryProfile ?? null,
          })
          continue
        }
        // Swap: staleness-weighted pick from the region pool, not already used.
        const pick = weightedPick(
          cands.filter((c) => !used.has(c.id)),
          rng,
        )
        if (pick) {
          used.add(pick.id)
          dealt.push({
            exerciseId: pick.id,
            name: pick.name,
            region,
            pattern: pick.pattern,
            equipmentClass: pick.equipmentClass,
            sets,
            staleness: pick.staleness,
            fromAnchor: false,
            injuryProfile: pick.injuryProfile,
          })
        }
      }
      continue
    }

    // ── Draft mode: pick ~1 exercise per 3 working sets, min 1. ──
    const slots = Math.max(1, Math.round(target.workingSets / 3))
    const perSlotSets = splitSets(target.workingSets, slots)
    for (let i = 0; i < slots; i += 1) {
      const pool = cands.filter((c) => !used.has(c.id))
      const pick = weightedPick(pool, rng)
      if (!pick) break
      used.add(pick.id)
      dealt.push({
        exerciseId: pick.id,
        name: pick.name,
        region,
        pattern: pick.pattern,
        equipmentClass: pick.equipmentClass,
        sets: perSlotSets[i] ?? 1,
        staleness: pick.staleness,
        fromAnchor: false,
        injuryProfile: pick.injuryProfile,
      })
    }
  }

  return { exercises: dealt }
}

/** Split `total` working sets across `n` slots as evenly as possible (front-loaded
 *  by 1 for the remainder). Always sums to `total`; each slot ≥1 when total≥n. */
function splitSets(total: number, n: number): number[] {
  if (n <= 0) return []
  const base = Math.floor(total / n)
  const rem = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0))
}

/** Look up an anchor exercise's pool metadata (name/pattern/class/staleness). */
function candidateMeta(
  pools: Map<string, Pool>,
  region: MuscleRegion,
  exerciseId: string,
): PoolExercise | null {
  return regionCandidates(pools, region).find((e) => e.id === exerciseId) ?? null
}

/**
 * Staleness-weighted random pick from a candidate list (roulette-wheel). A staler
 * exercise is proportionally more likely, but a fresh one still can surface — the
 * variety is stochastic, not a deterministic "always the stalest" (which would be
 * its own kind of sameness). Deterministic given `rng`. Returns null on empty.
 *
 * A tiny epsilon floor keeps zero-staleness candidates pickable.
 */
export function weightedPick(cands: PoolExercise[], rng: Rng): PoolExercise | null {
  if (cands.length === 0) return null
  if (cands.length === 1) return cands[0]!
  const EPS = 0.5
  let total = 0
  for (const c of cands) total += c.staleness + EPS
  let r = rng() * total
  for (const c of cands) {
    r -= c.staleness + EPS
    if (r <= 0) return c
  }
  return cands[cands.length - 1]!
}

// ---------------------------------------------------------------------------
// Alternatives (the swap sheet)
// ---------------------------------------------------------------------------

/** Alternatives for one exercise: the SAME region's other exercises, preferred
 *  first (the "Preferred it" chip, #1876) then staleness-ranked. Powers the
 *  candidate-list expansion for the LLM + the draft-time swap action. The source
 *  exercise itself is excluded. */
export function alternativesFor(
  pools: Map<string, Pool>,
  region: MuscleRegion,
  exerciseId: string,
  n: number,
): PoolExercise[] {
  return regionCandidates(pools, region)
    .filter((e) => e.id !== exerciseId)
    .slice(0, Math.max(0, n))
}

/**
 * Alternatives ranked on the source exercise's FULL muscle profile — primary AND
 * secondary hits, not primary alone (#1876). Powers the swap sheet.
 *
 * Replacing a reverse curl (primary biceps, secondary forearms) used to only
 * consult the biceps pool, so a movement chosen for its FOREARM role never
 * offered a forearm alternative — the point of the lift was invisible to the
 * ranking. Every region in `profile` contributes its own pool; a candidate's
 * score is the highest source-side weight it matched under (1.0 via a region
 * where it's the source's primary mover, 0.5 via a secondary), so primary-primary
 * matches still rank first but secondary-region candidates are no longer simply
 * absent. A `preferred` candidate (the "Preferred it" chip, #1876) ranks ahead of
 * profile-match strength entirely. Ties break on staleness, then name.
 */
export function alternativesForProfile(
  pools: Map<string, Pool>,
  profile: MuscleHit[],
  exerciseId: string,
  n: number,
): PoolExercise[] {
  const best = new Map<string, { ex: PoolExercise; score: number }>()
  for (const hit of profile) {
    for (const ex of regionCandidates(pools, hit.region)) {
      if (ex.id === exerciseId) continue
      const current = best.get(ex.id)
      if (!current || hit.weight > current.score) {
        best.set(ex.id, { ex, score: hit.weight })
      }
    }
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        Number(b.ex.preferred) - Number(a.ex.preferred) ||
        b.score - a.score ||
        b.ex.staleness - a.ex.staleness ||
        a.ex.name.localeCompare(b.ex.name),
    )
    .slice(0, Math.max(0, n))
    .map((entry) => entry.ex)
}

// ---------------------------------------------------------------------------
// Region-volume conservation (the GATE's check too — share the fn)
// ---------------------------------------------------------------------------

/** Per-region weekly working-set totals across a set of {region, sets} slots. */
export function regionVolume(
  slots: Array<{ region: MuscleRegion; sets: number }>,
): Map<MuscleRegion, number> {
  const out = new Map<MuscleRegion, number>()
  for (const s of slots) out.set(s.region, (out.get(s.region) ?? 0) + s.sets)
  return out
}

export interface VolumeConservationResult {
  ok: boolean
  /** Regions whose volume drifted outside ±tolerance of the anchor split. */
  violations: Array<{ region: MuscleRegion; anchor: number; actual: number }>
}

/**
 * Check per-region volume conservation: every region's actual working-set total
 * must stay within ±`tolerance` (fraction, default 0.20 = ±20%) of the anchor
 * split. A region present in the anchor but absent from actual (0 sets) is a
 * violation unless the anchor was 0. Regions ONLY in actual (a net-new region the
 * anchor never had) are allowed (the coach may add work), so this is asymmetric:
 * we never LOSE a region's volume, but adding is fine.
 *
 * The SHARED check for both novelty (a dealt slate must conserve) and plan.ts's
 * validation gate (the LLM's output must conserve vs the anchor). Pure + tested.
 */
export function checkVolumeConservation(
  anchor: Map<MuscleRegion, number>,
  actual: Map<MuscleRegion, number>,
  tolerance = 0.2,
): VolumeConservationResult {
  const violations: VolumeConservationResult['violations'] = []
  for (const [region, anchorSets] of anchor) {
    if (anchorSets <= 0) continue
    const actualSets = actual.get(region) ?? 0
    const lo = anchorSets * (1 - tolerance)
    const hi = anchorSets * (1 + tolerance)
    if (actualSets < lo || actualSets > hi) {
      violations.push({ region, anchor: anchorSets, actual: actualSets })
    }
  }
  return { ok: violations.length === 0, violations }
}
