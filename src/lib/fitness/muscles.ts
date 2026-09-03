/**
 * Exercise → muscle mapping + the canonical muscle-region set that the /health
 * muscle-map SVG paints. PURE + deterministic — no LLM, no DB. The map-state math
 * (lib/fitness/muscle-state.ts) and the figure component both import from here so
 * region ids never drift between the picture and the numbers.
 *
 * Why a curated mapper and not just the catalog's `primary_muscle`:
 *   - The vendored catalog's `primary_muscle` is one muscle, and its secondaries
 *     are coarse — a bench press would credit chest and little else.
 *   - Custom and imported exercise names rarely match the catalog's (the
 *     "(Barbell)"/"(Dumbbell)" suffix convention is common), so they're created
 *     on-demand with `primary_muscle = null` — i.e. NO catalog muscle at all.
 * So we resolve muscles from the exercise NAME first (keyword rules that know the
 * big compound lifts hit multiple groups), and fall back to the catalog's
 * primary_muscle only when the name teaches us nothing. Result: every real lift
 * lights up the right regions with sensible secondary credit.
 */

/** The canonical muscle regions the figure renders + the state math aggregates to.
 *  Front + back grouped; ids are stable (used as SVG region ids AND state keys). */
export const MUSCLE_REGIONS = [
  // Front
  'traps',
  'delts',
  'chest',
  'biceps',
  'forearms',
  'abs',
  'obliques',
  'quads',
  'calves',
  // Back
  'lats',
  'mid_back',
  'lower_back',
  'triceps',
  'glutes',
  'hamstrings',
  // Joint / mobility-only regions (GYM_PLAN §10b.9). These carry no strength
  // credit — they're painted ONLY on the muscle map's Mobility lens, from
  // logged hold minutes. The figure already draws their geometry as inert
  // anatomy (MuscleFigure `body.body`); the mobility lens promotes it to
  // tappable regions. Kept LAST so the 15 muscle ids keep their positions.
  'neck',
  'knees',
  'wrists',
  'ankles',
] as const

export type MuscleRegion = (typeof MUSCLE_REGIONS)[number]

/** The joint/mobility-only region ids (subset of MUSCLE_REGIONS). Strength
 *  surfaces skip these; only the Mobility lens paints them. */
export const MOBILITY_ONLY_REGIONS = ['neck', 'knees', 'wrists', 'ankles'] as const
export type MobilityOnlyRegion = (typeof MOBILITY_ONLY_REGIONS)[number]
const MOBILITY_ONLY_SET = new Set<string>(MOBILITY_ONLY_REGIONS)

/** True for the joint regions that only exist on the Mobility lens. */
export function isMobilityOnlyRegion(region: string): region is MobilityOnlyRegion {
  return MOBILITY_ONLY_SET.has(region)
}

const REGION_SET = new Set<string>(MUSCLE_REGIONS)

/** Friendly label per region (for the tap panel + legend). */
export const REGION_LABELS: Record<MuscleRegion, string> = {
  traps: 'Traps',
  delts: 'Shoulders',
  chest: 'Chest',
  biceps: 'Biceps',
  forearms: 'Forearms',
  abs: 'Abs',
  obliques: 'Obliques',
  quads: 'Quads',
  calves: 'Calves',
  lats: 'Lats',
  mid_back: 'Mid back',
  lower_back: 'Lower back',
  triceps: 'Triceps',
  glutes: 'Glutes',
  hamstrings: 'Hamstrings',
  neck: 'Neck',
  knees: 'Knees',
  wrists: 'Wrists',
  ankles: 'Ankles',
}

/** Which body-composition measurement metric (body_measurements.metric) pairs with
 *  a region, when one exists. Averages left/right for the paired limbs. Regions
 *  absent here simply show no measurement in the panel. */
export const REGION_MEASUREMENTS: Partial<Record<MuscleRegion, string[]>> = {
  biceps: ['bicep_left', 'bicep_right'],
  forearms: ['forearm_left', 'forearm_right'],
  chest: ['chest'],
  delts: ['shoulders'],
  abs: ['waist'],
  obliques: ['waist'],
  quads: ['thigh_left', 'thigh_right'],
  hamstrings: ['thigh_left', 'thigh_right'],
  calves: ['calf_left', 'calf_right'],
  glutes: ['hips'],
}

/** Normalize the free-exercise-db `primary_muscle` vocabulary → our region ids.
 *  (quadriceps→quads, abdominals→abs, "middle back"→mid_back, shoulders→delts, …) */
const CATALOG_MUSCLE_TO_REGION: Record<string, MuscleRegion> = {
  quadriceps: 'quads',
  shoulders: 'delts',
  abdominals: 'abs',
  chest: 'chest',
  hamstrings: 'hamstrings',
  triceps: 'triceps',
  biceps: 'biceps',
  lats: 'lats',
  'middle back': 'mid_back',
  calves: 'calves',
  'lower back': 'lower_back',
  forearms: 'forearms',
  glutes: 'glutes',
  traps: 'traps',
  neck: 'traps', // no neck region on the figure — fold into traps
  adductors: 'quads', // inner thigh → nearest region we draw
  abductors: 'glutes',
  // exercises-dataset target + secondary vocabulary.
  abs: 'abs',
  core: 'abs',
  obliques: 'obliques',
  pectorals: 'chest',
  delts: 'delts',
  deltoids: 'delts',
  quads: 'quads',
  'upper back': 'mid_back',
  rhomboids: 'mid_back',
  'latissimus dorsi': 'lats',
  trapezius: 'traps',
  spine: 'lower_back',
}

export function catalogMuscleToRegion(primaryMuscle: string | null | undefined): MuscleRegion | null {
  if (!primaryMuscle) return null
  return CATALOG_MUSCLE_TO_REGION[primaryMuscle.trim().toLowerCase()] ?? null
}

export interface MuscleHit {
  region: MuscleRegion
  /** 1 = primary mover, 0.5 = secondary/assisting — weights set volume credit. */
  weight: number
}

/** A keyword rule: if ALL `all` substrings appear in the lowercased name (and none
 *  of `not`), credit these regions. First matching rule wins. Ordered specific →
 *  general so "romanian deadlift" beats the generic "deadlift". */
interface Rule {
  all: string[]
  not?: string[]
  primary: MuscleRegion[]
  secondary?: MuscleRegion[]
}

const RULES: Rule[] = [
  // ---- Legs ----
  { all: ['romanian', 'deadlift'], primary: ['hamstrings'], secondary: ['glutes', 'lower_back'] },
  { all: ['rdl'], primary: ['hamstrings'], secondary: ['glutes', 'lower_back'] },
  { all: ['stiff', 'deadlift'], primary: ['hamstrings'], secondary: ['glutes', 'lower_back'] },
  { all: ['sumo', 'deadlift'], primary: ['glutes', 'hamstrings'], secondary: ['quads', 'lower_back'] },
  { all: ['deadlift'], primary: ['hamstrings', 'glutes', 'lower_back'], secondary: ['quads', 'traps', 'forearms'] },
  { all: ['hip thrust'], primary: ['glutes'], secondary: ['hamstrings'] },
  { all: ['glute'], primary: ['glutes'], secondary: ['hamstrings'] },
  { all: ['leg press'], primary: ['quads', 'glutes'], secondary: ['hamstrings'] },
  { all: ['hack squat'], primary: ['quads'], secondary: ['glutes'] },
  { all: ['front squat'], primary: ['quads'], secondary: ['glutes', 'abs'] },
  { all: ['bulgarian'], primary: ['quads', 'glutes'], secondary: ['hamstrings'] },
  { all: ['split squat'], primary: ['quads', 'glutes'], secondary: ['hamstrings'] },
  { all: ['lunge'], primary: ['quads', 'glutes'], secondary: ['hamstrings'] },
  { all: ['step up'], primary: ['quads', 'glutes'], secondary: ['hamstrings'] },
  { all: ['step-up'], primary: ['quads', 'glutes'], secondary: ['hamstrings'] },
  { all: ['squat'], primary: ['quads', 'glutes'], secondary: ['hamstrings', 'lower_back', 'abs'] },
  { all: ['leg extension'], primary: ['quads'] },
  { all: ['leg curl'], primary: ['hamstrings'] },
  { all: ['hamstring'], primary: ['hamstrings'] },
  { all: ['calf'], primary: ['calves'] },
  { all: ['calve'], primary: ['calves'] },
  { all: ['seated calf'], primary: ['calves'] },
  { all: ['adduct'], primary: ['quads'] },
  { all: ['abduct'], primary: ['glutes'] },

  // ---- Chest (press before "row"; incline/decline before flat) ----
  { all: ['bench press'], primary: ['chest'], secondary: ['triceps', 'delts'] },
  { all: ['chest press'], primary: ['chest'], secondary: ['triceps', 'delts'] },
  { all: ['chest fly'], primary: ['chest'], secondary: ['delts'] },
  { all: ['chest flye'], primary: ['chest'], secondary: ['delts'] },
  { all: ['pec deck'], primary: ['chest'], secondary: ['delts'] },
  { all: ['pec-deck'], primary: ['chest'], secondary: ['delts'] },
  { all: ['dips'], not: ['tricep'], primary: ['chest'], secondary: ['triceps', 'delts'] },
  { all: ['dip'], not: ['tricep'], primary: ['chest'], secondary: ['triceps', 'delts'] },
  { all: ['push up'], primary: ['chest'], secondary: ['triceps', 'delts', 'abs'] },
  { all: ['push-up'], primary: ['chest'], secondary: ['triceps', 'delts', 'abs'] },
  { all: ['pushup'], primary: ['chest'], secondary: ['triceps', 'delts', 'abs'] },
  { all: ['fly'], not: ['rear', 'reverse'], primary: ['chest'], secondary: ['delts'] },
  { all: ['flye'], not: ['rear', 'reverse'], primary: ['chest'], secondary: ['delts'] },

  // ---- Back (rows / pulldowns / pull-ups) ----
  { all: ['pull up'], primary: ['lats'], secondary: ['biceps', 'mid_back', 'forearms'] },
  { all: ['pull-up'], primary: ['lats'], secondary: ['biceps', 'mid_back', 'forearms'] },
  { all: ['pullup'], primary: ['lats'], secondary: ['biceps', 'mid_back', 'forearms'] },
  { all: ['chin up'], primary: ['lats'], secondary: ['biceps', 'mid_back'] },
  { all: ['chin-up'], primary: ['lats'], secondary: ['biceps', 'mid_back'] },
  { all: ['pulldown'], primary: ['lats'], secondary: ['biceps', 'mid_back'] },
  { all: ['pull down'], primary: ['lats'], secondary: ['biceps', 'mid_back'] },
  { all: ['pullover'], primary: ['lats'], secondary: ['chest', 'triceps'] },
  { all: ['face pull'], primary: ['mid_back'], secondary: ['delts', 'traps'] },
  { all: ['rear', 'fly'], primary: ['mid_back'], secondary: ['delts'] },
  { all: ['rear', 'delt'], primary: ['delts'], secondary: ['mid_back'] },
  { all: ['reverse', 'fly'], primary: ['mid_back'], secondary: ['delts'] },
  { all: ['t bar', 'row'], primary: ['mid_back', 'lats'], secondary: ['biceps', 'forearms'] },
  { all: ['t-bar', 'row'], primary: ['mid_back', 'lats'], secondary: ['biceps', 'forearms'] },
  { all: ['row'], primary: ['mid_back', 'lats'], secondary: ['biceps', 'forearms', 'lower_back'] },
  { all: ['shrug'], primary: ['traps'], secondary: ['forearms'] },
  { all: ['back extension'], primary: ['lower_back'], secondary: ['glutes', 'hamstrings'] },
  { all: ['hyperextension'], primary: ['lower_back'], secondary: ['glutes', 'hamstrings'] },
  { all: ['good morning'], primary: ['hamstrings', 'lower_back'], secondary: ['glutes'] },

  // ---- Shoulders ----
  { all: ['overhead press'], primary: ['delts'], secondary: ['triceps', 'traps'] },
  { all: ['shoulder press'], primary: ['delts'], secondary: ['triceps', 'traps'] },
  { all: ['military press'], primary: ['delts'], secondary: ['triceps', 'traps'] },
  { all: ['arnold press'], primary: ['delts'], secondary: ['triceps'] },
  { all: ['lateral raise'], primary: ['delts'] },
  { all: ['side raise'], primary: ['delts'] },
  { all: ['front raise'], primary: ['delts'] },
  { all: ['upright row'], primary: ['delts', 'traps'], secondary: ['biceps'] },
  { all: ['ohp'], primary: ['delts'], secondary: ['triceps', 'traps'] },

  // ---- Arms ----
  { all: ['tricep'], primary: ['triceps'] },
  { all: ['triceps'], primary: ['triceps'] },
  { all: ['pushdown'], primary: ['triceps'] },
  { all: ['push down'], primary: ['triceps'] },
  { all: ['skull'], primary: ['triceps'] }, // skullcrusher
  { all: ['close grip', 'bench'], primary: ['triceps'], secondary: ['chest', 'delts'] },
  { all: ['kickback'], primary: ['triceps'] },
  { all: ['curl'], not: ['leg', 'hamstring'], primary: ['biceps'], secondary: ['forearms'] },
  { all: ['bicep'], primary: ['biceps'], secondary: ['forearms'] },
  { all: ['biceps'], primary: ['biceps'], secondary: ['forearms'] },
  { all: ['wrist'], primary: ['forearms'] },
  { all: ['forearm'], primary: ['forearms'] },
  { all: ['grip'], primary: ['forearms'] },

  // ---- Core ----
  { all: ['oblique'], primary: ['obliques'] },
  { all: ['russian twist'], primary: ['obliques'], secondary: ['abs'] },
  { all: ['side bend'], primary: ['obliques'] },
  { all: ['woodchop'], primary: ['obliques'], secondary: ['abs'] },
  { all: ['crunch'], primary: ['abs'] },
  { all: ['sit up'], primary: ['abs'] },
  { all: ['sit-up'], primary: ['abs'] },
  { all: ['situp'], primary: ['abs'] },
  { all: ['leg raise'], primary: ['abs'], secondary: ['obliques'] },
  { all: ['knee raise'], primary: ['abs'], secondary: ['obliques'] },
  { all: ['plank'], primary: ['abs'], secondary: ['obliques', 'lower_back'] },
  { all: ['ab wheel'], primary: ['abs'], secondary: ['obliques'] },
  { all: ['ab roller'], primary: ['abs'], secondary: ['obliques'] },
  { all: ['hollow'], primary: ['abs'] },
  { all: ['mountain climber'], primary: ['abs'], secondary: ['obliques'] },
]

/**
 * Resolve an exercise to the muscle regions it trains, with a weight per region
 * (1 primary, 0.5 secondary). Name keywords win; the catalog's primary_muscle is
 * a fallback for names no rule recognizes. Returns [] for pure cardio / unknowns
 * (e.g. "Running") so they don't paint the figure.
 */
export function musclesForExercise(
  name: string,
  catalogPrimaryMuscle?: string | null,
): MuscleHit[] {
  const n = name.toLowerCase()
  for (const rule of RULES) {
    if (rule.not && rule.not.some((k) => n.includes(k))) continue
    if (!rule.all.every((k) => n.includes(k))) continue
    const hits = new Map<MuscleRegion, number>()
    for (const r of rule.primary) hits.set(r, 1)
    for (const r of rule.secondary ?? []) if (!hits.has(r)) hits.set(r, 0.5)
    return [...hits].map(([region, weight]) => ({ region, weight }))
  }
  // No name rule matched — fall back to the catalog's primary muscle if we have one.
  const region = catalogMuscleToRegion(catalogPrimaryMuscle)
  return region ? [{ region, weight: 1 }] : []
}

/**
 * Enriched variant for the gym surfaces (GYM_PLAN §5). Same keyword-rules-first
 * contract as `musclesForExercise` — a matching name rule wins outright. The ONLY
 * difference is a richer fallback when NO rule matches: instead of just the
 * catalog primary, it credits the catalog primary (weight 1) AND every catalog
 * secondary (weight 0.5), each mapped through `catalogMuscleToRegion` and deduped
 * (primary wins a tie). This lets enriched FEDB rows light up secondary regions
 * the old primary-only fallback missed. Existing callers keep using
 * `musclesForExercise` — its signature/behavior is unchanged.
 */
export function musclesForExerciseEnriched(
  name: string,
  catalogPrimaryMuscle?: string | null,
  catalogSecondaryMuscles?: string[] | null,
): MuscleHit[] {
  // Rules still win — delegate so the two functions never drift on rule matches.
  const n = name.toLowerCase()
  for (const rule of RULES) {
    if (rule.not && rule.not.some((k) => n.includes(k))) continue
    if (!rule.all.every((k) => n.includes(k))) continue
    return musclesForExercise(name, catalogPrimaryMuscle)
  }

  // No rule matched — build from catalog primary + secondaries.
  const hits = new Map<MuscleRegion, number>()
  const primary = catalogMuscleToRegion(catalogPrimaryMuscle)
  if (primary) hits.set(primary, 1)
  for (const s of catalogSecondaryMuscles ?? []) {
    const region = catalogMuscleToRegion(s)
    if (region && !hits.has(region)) hits.set(region, 0.5)
  }
  return [...hits].map(([region, weight]) => ({ region, weight }))
}

/** Is `s` one of our canonical region ids? (guards data coming back from the DB) */
export function isMuscleRegion(s: string): s is MuscleRegion {
  return REGION_SET.has(s)
}

/** Bare muscle/region words that are never a legitimate exercise NAME — a catalog
 *  row named exactly "quads", "chest", or "hamstrings" is a degenerate imported
 *  artifact (no movement, no equipment), not a real exercise. Union of our region
 *  ids, their friendly labels, and the FEDB `primary_muscle` vocabulary. */
const BARE_MUSCLE_WORDS: ReadonlySet<string> = new Set<string>([
  ...MUSCLE_REGIONS,
  ...Object.keys(CATALOG_MUSCLE_TO_REGION),
  ...Object.values(REGION_LABELS).map((l) => l.toLowerCase()),
])

/**
 * True when `name` is nothing but a bare muscle/region word ("quads", "Chest",
 * "middle back"). Such rows are degenerate catalog artifacts — the coach must keep
 * them out of its rotation pools (pool-eligibility only; the row is never deleted).
 * A real exercise always carries a movement/equipment qualifier, so this never
 * catches a legitimate name. PURE.
 */
export function isBareMuscleName(name: string): boolean {
  const n = name.trim().toLowerCase()
  return n.length > 0 && BARE_MUSCLE_WORDS.has(n)
}

/**
 * Joint-name → mobility region. Mobility work is joint-centric (you mobilize an
 * ankle, not a muscle), so before falling back to the muscle mapper we check for
 * joint keywords and credit the joint region. Word-bounded so "knee raise" (an
 * ab move) and "kneeling" don't match knees, etc. Used ONLY by the mobility
 * lens/fold — strength credit never touches these regions.
 */
const JOINT_NAME_RULES: { re: RegExp; region: MobilityOnlyRegion }[] = [
  { re: /\bneck\b|levator scapulae|sternocleidomastoid|scalene/i, region: 'neck' },
  // \bknee\b but NOT the strength ab-move family ("knee raise/up/tuck/drive/lift"),
  // which are modality=strength and never reach this resolver anyway — defensive.
  { re: /\bknees?\b(?!\s*(raise|up|tuck|drive|lift|to\b))|patell/i, region: 'knees' },
  { re: /\bwrists?\b/i, region: 'wrists' },
  { re: /\bankles?\b|dorsiflex|plantarflex|peroneal|posterior tibialis/i, region: 'ankles' },
]

/**
 * Region credit for a MOBILITY exercise (GYM_PLAN §10b.9). Joint keywords in the
 * name win first (neck/knees/wrists/ankles), so a "neck side stretch" credits the
 * Neck region instead of folding into Traps. Otherwise it defers to the enriched
 * muscle mapper (calf stretch → calves, hip flexor → glutes, etc.). Deterministic;
 * shared by the map fold, the chat mobility read, and coach-context so every
 * surface agrees.
 */
export function mobilityRegionsForExercise(
  name: string,
  catalogPrimaryMuscle?: string | null,
  catalogSecondaryMuscles?: string[] | null,
): MuscleHit[] {
  const n = name.toLowerCase()
  // A joint stretch may span two joints ("standing hamstring and calf stretch"
  // is muscle, but "wrist and forearm" — credit each named joint at full weight).
  const jointHits = JOINT_NAME_RULES.filter((r) => r.re.test(n)).map((r) => ({
    region: r.region as MuscleRegion,
    weight: 1,
  }))
  if (jointHits.length > 0) {
    // Dedupe (a name could match one joint rule twice via aliases).
    const seen = new Set<string>()
    return jointHits.filter((h) => (seen.has(h.region) ? false : (seen.add(h.region), true)))
  }
  return musclesForExerciseEnriched(name, catalogPrimaryMuscle, catalogSecondaryMuscles)
}
