/**
 * ONE normalization for exercise names, shared by creation, lookup and the
 * template resolver.
 *
 * ── The split-brain this exists to end (#1871) ─────────────────────────────
 * `manage_exercise action:"create"` reported `created:false, "already existed"`
 * for names that `manage_exercise get` and the template resolver then could not
 * find — confirmed live on "Bodyweight Squat" and "Stairmaster". Three paths
 * asked three different questions:
 *
 *   - create   → `onConflictDoNothing({target: exercises.name})`, i.e. the
 *                UNIQUE index: CASE-SENSITIVE, and blind to `archived_at`.
 *   - lookup   → `lower(name) = ? AND archived_at IS NULL`.
 *   - template → the same lookup.
 *
 * So the two axes disagreed independently. On the archived axis, creating a
 * previously-archived movement hit the unique index, wrote nothing, un-archived
 * nothing, and handed back a row that every other path treats as absent. On the
 * case axis, the unique index would happily accept "bodyweight squat" alongside
 * "Bodyweight Squat" — which is exactly how the duplicate rows this catalog has
 * already had to be merged got created in the first place.
 *
 * Everything that resolves a name by text now goes through here.
 */
import { sql, type SQL } from 'drizzle-orm'

/**
 * The comparison key for an exercise name: trimmed, case-folded, and with
 * runs of hyphens/underscores/whitespace flattened to single spaces.
 *
 * Punctuation is folded because "pull-up", "Pull Up" and "pull up" are one
 * movement to a human and three distinct strings to Postgres. Plurals are
 * deliberately NOT folded here — `findDuplicateExercises` folds them to
 * *report* collisions for review, but silently resolving "Rows" to "Row" at
 * lookup time would route logged sets onto a row nobody named.
 */
export function normalizeExerciseName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_\s]+/g, ' ')
}

/**
 * SQL for the same normalization, so a query can compare against the stored
 * column without loading the catalog into memory.
 *
 * Kept beside the TS version on purpose: if one changes and the other does not,
 * the split-brain is back. `exercise-name.test.ts` asserts they agree.
 */
export function normalizedNameSql(column: SQL | string = 'e.name'): SQL {
  const col = typeof column === 'string' ? sql.raw(column) : column
  return sql`regexp_replace(lower(trim(${col})), '[-_[:space:]]+', ' ', 'g')`
}
