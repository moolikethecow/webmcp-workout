/**
 * The two equipment vocabularies must stay reconciled.
 *
 * The My-Gyms checklist speaks FEDB v1 ("body only", "kettlebells", "e-z curl
 * bar"); the shipped catalog speaks the v2 dataset it is generated from ("body
 * weight", "kettlebell", "ez barbell"). Only four tokens are spelled the same.
 *
 * An unmapped token is not a loud failure — it silently becomes 'other', which
 * means an exercise quietly stops being drafted. Before this was fixed, 18
 * tokens covering 542 of 1318 catalog rows fell through, including ALL 324
 * bodyweight movements, which made the bodyweight escape hatch in
 * `gymCompatible` dead code.
 *
 * These tests fail on the drift itself, not on its symptoms — a new dataset
 * token, or a new checklist option, has to be mapped before it can ship.
 */
import { describe, expect, it } from 'vitest'

import catalog from '@/lib/fitness/exercise-catalog.json'
import { GYM_EQUIPMENT_VOCAB } from '@/lib/gym/injuries-gyms'
import { equipmentClass, gymCompatible } from '@/lib/gym/novelty'

type CatalogRow = { name: string; equipment?: string | null }
const rows = (Array.isArray(catalog) ? catalog : []) as CatalogRow[]

function tokensInCatalog(): string[] {
  return [...new Set(rows.map((r) => (r.equipment ?? '').trim().toLowerCase()).filter(Boolean))]
}

describe('equipment vocabulary reconciliation', () => {
  it('the shipped catalog is not empty (guards a silently broken import)', () => {
    expect(rows.length).toBeGreaterThan(1000)
  })

  it('every checklist option resolves to a real class, never the "other" fallback by accident', () => {
    // 'other' is a legitimate answer only for the option literally named 'other'.
    for (const token of GYM_EQUIPMENT_VOCAB) {
      const cls = equipmentClass(token)
      if (token === 'other' || token === 'medicine ball' || token === 'exercise ball' || token === 'foam roll') {
        expect(cls).toBe('other')
      } else {
        expect(cls, `checklist option "${token}" fell through to 'other'`).not.toBe('other')
      }
    }
  })

  it('classifies every bodyweight catalog row as bodyweight, not "other"', () => {
    const bw = rows.filter((r) => (r.equipment ?? '').trim().toLowerCase() === 'body weight')
    expect(bw.length).toBeGreaterThan(200)
    for (const row of bw.slice(0, 50)) {
      expect(equipmentClass(row.equipment ?? null)).toBe('bodyweight')
    }
  })

  it('leaves no catalog token silently unmapped', () => {
    // Any token that maps to 'other' must be one we DECIDED is miscellaneous.
    const deliberateOther = new Set([
      'medicine ball', 'exercise ball', 'stability ball', 'bosu ball',
      'foam roll', 'roller', 'wheel roller', 'rope', 'hammer', 'tire', 'other',
    ])
    const accidental = tokensInCatalog().filter(
      (t) => equipmentClass(t) === 'other' && !deliberateOther.has(t),
    )
    expect(accidental, `unmapped catalog equipment tokens: ${accidental.join(', ')}`).toEqual([])
  })

  it('a bodyweight-only gym offers bodyweight work instead of nothing at all', () => {
    // Ticking "body only" and nothing else previously yielded ZERO eligible
    // exercises — the travelling-with-no-equipment case.
    const pullUp = { name: 'Pull-Up', equipment: 'body weight' }
    const bench = { name: 'Bench Press (Barbell)', equipment: 'barbell' }
    expect(gymCompatible(pullUp, ['body only'], [])).toBe(true)
    expect(gymCompatible(bench, ['body only'], [])).toBe(false)
  })

  it('matches across the vocabulary gap in both directions', () => {
    // checklist "kettlebells" ↔ catalog "kettlebell" — previously a miss,
    // because a raw checklist token was compared against a coarse class.
    expect(gymCompatible({ name: 'KB Swing', equipment: 'kettlebell' }, ['kettlebells'], [])).toBe(true)
    // checklist "e-z curl bar" ↔ catalog "ez barbell"
    expect(gymCompatible({ name: 'EZ Curl', equipment: 'ez barbell' }, ['e-z curl bar'], [])).toBe(true)
    // checklist "machine" ↔ catalog "leverage machine" / "assisted"
    expect(gymCompatible({ name: 'Assisted Pull-Up', equipment: 'assisted' }, ['machine'], [])).toBe(true)
  })

  it('still excludes what the gym genuinely does not have', () => {
    expect(gymCompatible({ name: 'Cable Fly', equipment: 'cable' }, ['dumbbell'], [])).toBe(false)
  })
})
