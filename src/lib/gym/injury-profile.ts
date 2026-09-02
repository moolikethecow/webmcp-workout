/**
 * Exercise-demand metadata and the injury eligibility gate.
 *
 * This deliberately does NOT encode "safe for injury X". Rehabilitation choices
 * depend on diagnosis, irritability, load, range, technique, and the individual.
 * Instead, each catalog exercise records the anatomical sites and support demands
 * it uses. An active limiting/out injury excludes any exercise whose reviewed
 * profile involves that site. Missing/untrusted profiles fail closed.
 *
 * Profiles are PRECOMPUTED: every catalog row carries its `injury_profile` as
 * data (see the seed), read here as-is. The derivation pipeline that produces
 * them lives upstream. This is a conservative programming filter, not medical
 * clearance.
 */
import { MUSCLE_REGIONS, type MuscleRegion } from '@/lib/fitness/muscles'

export const EXTRA_INJURY_SITES = [
  'head',
  'shoulder_joint',
  'upper_arms',
  'elbows',
  'hands',
  'spine',
  'ribs',
  'hips',
  'pelvis',
  'groin',
  'thighs',
  'lower_legs',
  'feet',
  'other',
] as const

export const INJURY_SITES = [...MUSCLE_REGIONS, ...EXTRA_INJURY_SITES] as const
export type InjurySite = (typeof INJURY_SITES)[number]

const INJURY_SITE_SET = new Set<string>(INJURY_SITES)

export function isInjurySite(value: string): value is InjurySite {
  return INJURY_SITE_SET.has(value)
}

export const INJURY_SITE_LABELS: Record<InjurySite, string> = {
  traps: 'Traps',
  delts: 'Deltoids',
  chest: 'Chest muscles',
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
  head: 'Head / concussion',
  shoulder_joint: 'Shoulder joint',
  upper_arms: 'Upper arms',
  elbows: 'Elbows',
  hands: 'Hands / fingers',
  spine: 'Spine',
  ribs: 'Ribs',
  hips: 'Hips',
  pelvis: 'Pelvis',
  groin: 'Groin / adductors',
  thighs: 'Thighs',
  lower_legs: 'Lower legs',
  feet: 'Feet / toes',
  other: 'Other / not classified',
}

export const DEMAND_ROLES = [
  'primary',
  'secondary',
  'articulation',
  'stabilizer',
  'weight_bearing',
  'impact',
  'contact',
  'grip',
  'loaded_stretch',
] as const
export type DemandRole = (typeof DEMAND_ROLES)[number]

const DEMAND_ROLE_SET = new Set<string>(DEMAND_ROLES)

export const MOVEMENT_TRAITS = [
  'standing',
  'seated',
  'supine',
  'prone',
  'kneeling',
  'hanging',
  'single_leg',
  'impact',
  'grip',
  'overhead',
  'rotation',
] as const
export type MovementTrait = (typeof MOVEMENT_TRAITS)[number]

const MOVEMENT_TRAIT_SET = new Set<string>(MOVEMENT_TRAITS)

export interface ExerciseInjuryProfile {
  schemaVersion: 1
  provenance: 'catalog-derived' | 'manual-reviewed' | 'ai-unreviewed'
  /** Sparse map: absence means no material demand only for trusted profiles. */
  sites: Partial<Record<InjurySite, DemandRole[]>>
  traits: MovementTrait[]
}

export interface InjuryConstraint {
  region: InjurySite
  severity: string
  label?: string | null
}

export interface CatalogProfileInput {
  name: string
  category: string | null
  primaryMuscle: string | null
  secondaryMuscles: string[]
  equipment: string | null
  modality: string
  instructions: string[]
}

export function parseExerciseInjuryProfile(value: unknown): ExerciseInjuryProfile | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1) return null
  if (!['catalog-derived', 'manual-reviewed', 'ai-unreviewed'].includes(String(raw.provenance))) return null
  if (!raw.sites || typeof raw.sites !== 'object' || Array.isArray(raw.sites)) return null
  const sites: Partial<Record<InjurySite, DemandRole[]>> = {}
  for (const [site, roles] of Object.entries(raw.sites as Record<string, unknown>)) {
    if (!isInjurySite(site) || !Array.isArray(roles)) return null
    const parsed = roles.filter((role): role is DemandRole => typeof role === 'string' && DEMAND_ROLE_SET.has(role))
    if (parsed.length !== roles.length || parsed.length === 0) return null
    sites[site] = [...new Set(parsed)]
  }
  if (Object.keys(sites).length === 0) return null
  const traitsRaw = Array.isArray(raw.traits) ? raw.traits : []
  const traits = traitsRaw.filter(
    (trait): trait is MovementTrait => typeof trait === 'string' && MOVEMENT_TRAIT_SET.has(trait),
  )
  if (traits.length !== traitsRaw.length) return null
  return {
    schemaVersion: 1,
    provenance: raw.provenance as ExerciseInjuryProfile['provenance'],
    sites,
    traits: [...new Set(traits)],
  }
}

/** Legacy `delts` selections meant “shoulder” in the old UI. Keep them broad. */
function matchingSites(region: InjurySite): InjurySite[] {
  if (region === 'delts') return ['delts', 'shoulder_joint']
  if (region === 'lower_back' || region === 'mid_back' || region === 'neck') return [region, 'spine']
  return [region]
}

export interface InjuryEligibility {
  allowed: boolean
  reason: 'allowed' | 'untrusted_profile' | 'unclassified_injury' | 'site_demand'
  blockingSites: InjurySite[]
}

/**
 * Hard recommendation gate. Nagging injuries remain informational; limiting/out
 * injuries exclude any documented involvement. Unknown exercises and an
 * unclassified/head injury fail closed rather than manufacturing reassurance.
 */
export function exerciseAllowedWithInjuries(
  profile: ExerciseInjuryProfile | null,
  injuries: InjuryConstraint[],
): InjuryEligibility {
  const hard = injuries.filter((injury) => injury.severity === 'limiting' || injury.severity === 'out')
  if (hard.length === 0) return { allowed: true, reason: 'allowed', blockingSites: [] }
  const trusted = parseExerciseInjuryProfile(profile)
  if (!trusted || trusted.provenance === 'ai-unreviewed') {
    return { allowed: false, reason: 'untrusted_profile', blockingSites: hard.map((injury) => injury.region) }
  }
  if (hard.some((injury) => injury.region === 'other' || injury.region === 'head')) {
    return {
      allowed: false,
      reason: 'unclassified_injury',
      blockingSites: hard.filter((injury) => injury.region === 'other' || injury.region === 'head').map((injury) => injury.region),
    }
  }
  const blocked = new Set<InjurySite>()
  for (const injury of hard) {
    if (matchingSites(injury.region).some((site) => (trusted.sites[site]?.length ?? 0) > 0)) {
      blocked.add(injury.region)
    }
  }
  return blocked.size > 0
    ? { allowed: false, reason: 'site_demand', blockingSites: [...blocked] }
    : { allowed: true, reason: 'allowed', blockingSites: [] }
}

export function injurySiteIsMuscleRegion(site: InjurySite): site is MuscleRegion {
  return (MUSCLE_REGIONS as readonly string[]).includes(site)
}
