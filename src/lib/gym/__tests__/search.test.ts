/**
 * Pure list-helper logic (lib/gym/search.ts): token parsing, token-AND name match,
 * region computation, the muscle predicate, and the tracked/history-first ordering.
 * No DB — the SQL wrapper `queryExercises` is exercised on prod.
 */
import { describe, it, expect } from 'vitest'

import {
  compareListItems,
  nameMatchesTokens,
  queryTokens,
  regionsForRow,
  rowMatchesMuscle,
  tokenForms,
  tokenStem,
  type ExerciseListItem,
} from '../search'

describe('queryTokens', () => {
  it('lowercases and splits on whitespace, dropping empties', () => {
    expect(queryTokens('  Incline  Bench ')).toEqual(['incline', 'bench'])
    expect(queryTokens('')).toEqual([])
  })
})

describe('nameMatchesTokens', () => {
  it('requires ALL tokens present (token-AND), case-insensitive', () => {
    expect(nameMatchesTokens('Incline Bench Press', ['incline', 'press'])).toBe(true)
    expect(nameMatchesTokens('Incline Bench Press', ['incline', 'squat'])).toBe(false)
    expect(nameMatchesTokens('Anything', [])).toBe(true) // empty matches all
  })

  it('tolerates plural query tokens against singular catalog names', () => {
    // The 2026-08-17 gym moment: "tricep pushdowns" found NOTHING because no
    // catalog name contains the plural.
    expect(nameMatchesTokens('Cable Pushdown (With Rope Attachment)', ['pushdowns'])).toBe(true)
    expect(nameMatchesTokens('Incline Bench Press', ['presses'])).toBe(true)
    expect(nameMatchesTokens('Barbell Curl', ['curls'])).toBe(true)
    // A haystack with muscle metadata satisfies tokens the bare name lacks.
    expect(
      nameMatchesTokens('cable pushdown (with rope attachment) triceps cable', [
        'tricep',
        'pushdowns',
        'rope',
      ]),
    ).toBe(true)
    // Still token-AND: an unrelated word must not match.
    expect(nameMatchesTokens('Cable Pushdown', ['pulldowns'])).toBe(false)
  })
})

describe('tokenForms / tokenStem', () => {
  it('keeps short tokens intact and stems plurals', () => {
    expect(tokenForms('abs')).toEqual(['abs'])
    expect(tokenForms('pushdowns')).toContain('pushdown')
    expect(tokenForms('presses')).toContain('press')
    expect(tokenStem('presses')).toBe('press')
    expect(tokenStem('pushdowns')).toBe('pushdown')
    expect(tokenStem('rope')).toBe('rope')
  })
})

describe('regionsForRow', () => {
  it('maps a known lift to its regions via the enriched mapper', () => {
    const regions = regionsForRow('Barbell Bench Press', 'chest', ['triceps', 'shoulders'])
    const ids = regions.map((r) => r.region)
    expect(ids).toContain('chest')
    // bench-press rule credits triceps + delts as secondaries.
    expect(ids).toContain('triceps')
    expect(ids).toContain('delts')
    // primary carries weight 1.
    expect(regions.find((r) => r.region === 'chest')?.weight).toBe(1)
  })

  it('falls back to catalog primary+secondaries for names no rule knows', () => {
    const regions = regionsForRow('Cable Woodchopper Variant XYZ', 'abdominals', ['obliques'])
    // No rule matches "woodchopper variant xyz" exactly → catalog fallback.
    const ids = regions.map((r) => r.region)
    expect(ids).toContain('abs')
    expect(ids).toContain('obliques')
  })
})

describe('rowMatchesMuscle', () => {
  it('matches a region present in the credits (primary or secondary)', () => {
    const regions = regionsForRow('Barbell Bench Press', 'chest', [])
    expect(rowMatchesMuscle(regions, 'chest')).toBe(true)
    expect(rowMatchesMuscle(regions, 'triceps')).toBe(true) // secondary
    expect(rowMatchesMuscle(regions, 'quads')).toBe(false)
  })
})

describe('compareListItems', () => {
  const base: ExerciseListItem = {
    id: 'x',
    name: '',
    category: null,
    equipment: null,
    primaryMuscle: null,
    secondaryMuscles: [],
    regions: [],
    tracks: 'weight_reps',
    modality: 'strength',
    perSide: false,
    isCustom: false,
    aiFilled: false,
    tracked: false,
    disliked: false,
    sets: 0,
    lastPerformed: null,
    hasImages: false,
    slug: null,
    imagePath: null,
  }
  const mk = (over: Partial<ExerciseListItem>): ExerciseListItem => ({ ...base, ...over })

  it('puts tracked/has-history rows before untracked, then A→Z', () => {
    const items = [
      mk({ name: 'Zercher Squat' }), // untracked, no history
      mk({ name: 'Bench Press', sets: 40 }), // has history
      mk({ name: 'Ab Wheel', tracked: true }), // tracked flag
      mk({ name: 'Arnold Press' }), // untracked
    ]
    const sorted = [...items].sort(compareListItems)
    // First two: the tracked/history rows, alphabetized among themselves.
    expect(sorted.map((i) => i.name)).toEqual([
      'Ab Wheel',
      'Bench Press',
      'Arnold Press',
      'Zercher Squat',
    ])
  })
})
