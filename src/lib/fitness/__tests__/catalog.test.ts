/**
 * Guards the vendored exercise catalog (full metadata + a looping GIF per move).
 * If a re-vendor drops fields, truncates, or drifts the muscle vocab, this fails
 * before a broken seed ships. Regenerate with scripts/generate-exercise-catalog.mjs.
 */
import { describe, it, expect } from 'vitest'

import catalog from '../exercise-catalog.json'

type Entry = {
  name: string
  category: string | null
  primary_muscle: string | null
  secondary_muscles: string[]
  equipment: string | null
  force: string | null
  mechanic: string | null
  level: string | null
  instructions: string[]
  images: string[]
  slug: string
  tracks: string
  modality: string
  per_side: boolean
}

// Must stay in lockstep with catalog.ts:TRACKS (§3a — grew by 2 for the gym build).
const TRACKS = new Set([
  'weight_reps',
  'weighted_bodyweight',
  'assisted_bodyweight',
  'reps',
  'time',
  'distance_time',
])

// Must stay in lockstep with catalog.ts:MODALITIES (GYM_PLAN §10b.1).
const MODALITIES = new Set(['strength', 'stretch', 'dynamic', 'soft_tissue', 'cardio'])

describe('exercise-catalog.json', () => {
  const list = catalog as Entry[]

  it('has the full animation catalog', () => {
    expect(list.length).toBeGreaterThan(1_300)
  })

  it('every entry has a non-empty name, a slug, and valid tracks/modality values', () => {
    for (const e of list) {
      expect(typeof e.name).toBe('string')
      expect(e.name.length).toBeGreaterThan(0)
      expect(typeof e.slug).toBe('string')
      expect(e.slug.length).toBeGreaterThan(0)
      expect(TRACKS.has(e.tracks)).toBe(true)
      expect(MODALITIES.has(e.modality)).toBe(true)
      expect(typeof e.per_side).toBe('boolean')
    }
  })

  it('names are unique (the catalog seed upserts on name)', () => {
    expect(new Set(list.map((e) => e.name)).size).toBe(list.length)
  })

  it('carries one pinned GIF path for every exercise', () => {
    for (const e of list) {
      expect(e.images).toHaveLength(1)
      expect(e.images[0]).toMatch(/^videos\/\d{4}-[A-Za-z0-9]+\.gif$/)
    }
  })

  it('has normalized primary and secondary muscle metadata', () => {
    for (const e of list) {
      expect(typeof e.primary_muscle).toBe('string')
      expect(Array.isArray(e.secondary_muscles)).toBe(true)
      for (const m of e.secondary_muscles) expect(typeof m).toBe('string')
    }
  })

  it('carries the enriched metadata fields as arrays/strings', () => {
    for (const e of list) {
      expect(Array.isArray(e.instructions)).toBe(true)
      // equipment/force/mechanic/level are string|null (FEDB has nulls).
      for (const k of ['equipment', 'force', 'mechanic', 'level'] as const) {
        expect(e[k] === null || typeof e[k] === 'string').toBe(true)
      }
    }
  })

  it('stretches log as timed holds, not weight×reps', () => {
    // The source dataset files stretches under body-part categories (no
    // 'stretching' category at the pinned SHA), so the generator derives
    // tracks:'time' from \bstretch\b names — a regen that loses that lane
    // would silently put weight/reps inputs back on every stretch.
    const stretches = list.filter((e) => /\bstretch\b/i.test(e.name))
    expect(stretches.length).toBeGreaterThanOrEqual(50)
    for (const e of stretches) expect(e.tracks).toBe('time')
    // Word boundary: "outstretched" is a reps glute-bridge, not a stretch. The
    // assertion is that it is NOT on the timed lane; it reads 'reps' rather than
    // 'weight_reps' since bodyweight movements stopped defaulting to the weight
    // track (which could never hold a record).
    const bridge = list.find((e) => e.name === 'single leg bridge with outstretched leg')
    expect(bridge?.tracks).not.toBe('time')
    expect(bridge?.tracks).toBe('reps')
    // Curated static holds ride the same lane.
    const holds = ['l-sit on floor', 'weighted front plank', 'butterfly yoga pose']
    for (const name of holds) {
      expect(list.find((e) => e.name === name)?.tracks).toBe('time')
    }
  })

  it('derives the §10b.1 modality axis (mobility work ≠ strength credit)', () => {
    const by = (name: string) => list.find((e) => e.name === name)
    // Static stretches + yoga poses are 'stretch'.
    expect(by('hamstring stretch')?.modality).toBe('stretch')
    expect(by('butterfly yoga pose')?.modality).toBe('stretch')
    // Foam-roller tissue work is 'soft_tissue' — but a roller NAME alone is not
    // (roller-as-equipment core work stays strength).
    expect(by('roller back stretch')?.modality).toBe('soft_tissue')
    expect(by('roller body saw')?.modality).toBe('strength')
    // Movement drills are 'dynamic'.
    expect(by('world greatest stretch')?.modality).toBe('dynamic')
    // Isometric strength holds are STRENGTH (time-tracked, but they earn
    // recovery credit — planks are training, not mobility).
    expect(by('weighted front plank')?.modality).toBe('strength')
    expect(by('l-sit on floor')?.modality).toBe('strength')
    // per_side only ever appears on mobility modalities in the seed.
    for (const e of list) {
      if (e.per_side) expect(['stretch', 'dynamic', 'soft_tissue']).toContain(e.modality)
    }
  })
})
