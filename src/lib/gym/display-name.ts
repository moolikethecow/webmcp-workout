/** Known multi-letter acronyms that must render in full caps regardless of
 *  source casing (e.g. an "ez barbell curl" catalog seed or a naive single-
 *  letter title-caser that only produced "Ez"). Add here, not by hand-editing
 *  individual rows. */
const ACRONYMS = ['EZ', 'RDL', 'MAG']

/**
 * Exercise names come from Strong (usually title-cased), the animation catalog
 * (lower-case), and free-form custom input — landing in the DB inconsistently
 * cased. This is the one canonical title-caser: used both to normalize the
 * stored `name` (write time / one-time backfill) and, defensively, at render.
 *
 * Word starts are whitespace/slash/paren/hyphen boundaries — NOT apostrophes,
 * so a possessive like "dancer's" doesn't get its trailing letter capitalized
 * ("Dancer'S"). A letter already wrongly capitalized right after an apostrophe
 * (bad data from before this fix) is corrected back down. Known acronyms are
 * then forced to full caps regardless of source casing.
 */
export function displayExerciseName(name: string): string {
  const capitalized = name
    .trim()
    .replace(/(^|[\s/(-])([a-z])/g, (_m, sep: string, letter: string) => sep + letter.toUpperCase())
    .replace(/([A-Za-z]')([A-Z])/g, (_m, pre: string, letter: string) => pre + letter.toLowerCase())
  return capitalized.replace(/\b[A-Za-z]+\b/g, (word) => {
    const acronym = ACRONYMS.find((a) => a.toLowerCase() === word.toLowerCase())
    return acronym ?? word
  })
}

/**
 * Planner-authored workout names occasionally arrive entirely lower-case even
 * though user-authored names may intentionally contain mixed casing or acronyms.
 * Normalize only the clearly generated all-lowercase case at the persistence
 * boundary; never rewrite a deliberately cased name such as "Push/Pull A".
 */
export function normalizeGeneratedWorkoutName(name: string): string {
  const trimmed = name.trim()
  const letters = trimmed.replace(/[^A-Za-z]/g, '')
  if (!letters || letters !== letters.toLowerCase()) return trimmed
  return trimmed.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}
