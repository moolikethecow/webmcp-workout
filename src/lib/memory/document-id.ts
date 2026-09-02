/**
 * Stable, source-derived memory `document_id`s.
 *
 * The id is an idempotency key: a repeat write with the SAME id replaces that
 * document, while a missing/random id mints a new one every time.
 */

/**
 * A completed workout, keyed by the `workouts` row id so the one retain per
 * finished session upserts on a retry instead of minting a second memory.
 */
export function workoutRetainDocumentId(workoutId: string): string {
  return `workout-${workoutId}`
}
