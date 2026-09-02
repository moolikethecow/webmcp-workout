/**
 * Baked injury profiles for the test catalogs.
 *
 * Profiles are DATA in this repo: the catalog ships with `injury_profile`
 * already on every row (see the seed), so tests carry the same thing — a
 * recorded map from a catalog row's identifying fields to its profile — rather
 * than deriving one at test time.
 */
import profiles from './injury-profiles.fixture.json'

import type { CatalogProfileInput, ExerciseInjuryProfile } from '../injury-profile'

const BAKED = profiles as unknown as Record<string, ExerciseInjuryProfile>

function fixtureKey(input: CatalogProfileInput): string {
  return [
    input.name,
    input.category ?? '',
    input.primaryMuscle ?? '',
    [...input.secondaryMuscles].join('+'),
    input.equipment ?? '',
    input.modality,
    input.instructions.join(' '),
  ].join('|').toLowerCase()
}

/** The baked profile for a catalog row. Throws on an unbaked fixture so a new
 *  test row fails loudly instead of silently getting an empty profile. */
export function fixtureInjuryProfile(input: CatalogProfileInput): ExerciseInjuryProfile {
  const profile = BAKED[fixtureKey(input)]
  if (!profile) throw new Error(`no baked injury profile for fixture: ${fixtureKey(input)}`)
  return profile
}
