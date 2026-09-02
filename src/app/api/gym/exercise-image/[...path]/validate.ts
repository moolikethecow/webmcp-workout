/**
 * Pure path-validation + URL helpers for the exercise-image proxy, extracted
 * out of route.ts because a Next.js route file may only export the HTTP-method
 * handlers (GET/POST/…) plus reserved config fields — an extra named export
 * fails the build ("… is not a valid Route export field"). Living here keeps
 * them importable by both the route and the unit test.
 */

/** The pinned exercises-dataset commit every catalog GIF is served from. */
const EXERCISE_DATASET_SHA = '118e4bd6b14da6df0e36605d7169b65db18389a4'

/** Legacy FEDB catalog slug shape (e.g. `3_4_Sit-Up`). */
const SLUG_RE = /^[A-Za-z0-9_-]+$/
/** Frame file: exactly `0.jpg` or `1.jpg`. */
const FRAME_RE = /^[01]\.jpg$/
/** Pinned exercises-dataset GIF filename (`0001-2gPfomN.gif`). */
const GIF_RE = /^\d{4}-[A-Za-z0-9]+\.gif$/

export interface ValidatedImagePath {
  slug: string
  file: string
  contentType: 'image/gif' | 'image/jpeg'
}

/**
 * Validate the `[...path]` catch-all segments, returning the validated
 * { slug, file } or null. Rejects anything that isn't exactly
 * either the legacy `<slug>/<0|1>.jpg` or the pinned dataset
 * `videos/<four-digit-id>-<media-id>.gif`. Both forms reject traversal,
 * absolute paths, extra segments, and odd extensions.
 */
export function validateImagePath(segments: string[]): ValidatedImagePath | null {
  if (!Array.isArray(segments) || segments.length !== 2) return null
  const [slug, file] = segments
  if (typeof slug !== 'string' || typeof file !== 'string') return null
  if (slug === 'videos' && GIF_RE.test(file)) return { slug, file, contentType: 'image/gif' }
  if (!SLUG_RE.test(slug) || !FRAME_RE.test(file)) return null
  return { slug, file, contentType: 'image/jpeg' }
}

/** Build the pinned raw.githubusercontent URL for a validated image/GIF path. */
export function upstreamUrl(path: ValidatedImagePath): string {
  if (path.contentType === 'image/gif') {
    return `https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/${EXERCISE_DATASET_SHA}/${path.slug}/${path.file}`
  }
  return `https://raw.githubusercontent.com/yuhonas/free-exercise-db/b0eed061e1c832b3ed815fbaa4b45b3cdc14df49/exercises/${path.slug}/${path.file}`
}
