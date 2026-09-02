/**
 * GET /api/gym/exercise-image/<path> — lazy proxy-cache for exercise media.
 * No build-time fetch, no repo commit: the first view fetches it from
 * raw.githubusercontent at a pinned commit, writes it through to an ephemeral
 * disk cache, and serves it with a
 * one-year immutable Cache-Control so the browser never asks twice.
 *
 * Path is hard-validated against the supported two-segment JPG/GIF forms before
 * any fetch, so no traversal is possible. Upstream 404 → 404 (negatively cached
 * in-process to stop refetch
 * storms); upstream/network error → 502.
 *
 * Auth: the standard `authenticateRequest`. This route is reachable from
 * `<img>` tags because same-origin sub-resource requests carry the workspace
 * cookie automatically — an `<img src>` can't set an Authorization header, so
 * the cookie path is the one that has to carry here.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'

import { upstreamUrl, validateImagePath } from './validate'

/** Ephemeral write-through cache dir (re-warms per container life). */
const CACHE_DIR = path.join(os.tmpdir(), 'gym-exercise-images')

/** On-disk cache key — flat (slug + frame joined), so the validated,
 *  traversal-free name maps to a single file with no nested dirs. */
function cacheFileFor(slug: string, file: string): string {
  return path.join(CACHE_DIR, `${slug}__${file}`)
}

// Negative cache: upstream 404s are permanent for a pinned path, so remember them
// in-process to avoid hammering GitHub on repeat misses.
const missing = new Set<string>()

function imageHeaders(contentType: 'image/gif' | 'image/jpeg') {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
  } as const
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!authenticateRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { path: segments } = await params
  const valid = validateImagePath(segments)
  if (!valid) {
    return new Response(JSON.stringify({ error: 'Bad image path' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const { slug, file } = valid
  const key = `${slug}/${file}`

  if (missing.has(key)) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 1. Serve from disk when present.
  const cachePath = cacheFileFor(slug, file)
  try {
    const cached = await fs.readFile(cachePath)
    return new Response(new Uint8Array(cached), { status: 200, headers: imageHeaders(valid.contentType) })
  } catch {
    // Miss — fall through to fetch.
  }

  // 2. Fetch upstream at the pinned SHA.
  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl(valid))
  } catch {
    return new Response(JSON.stringify({ error: 'Upstream fetch failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (upstream.status === 404) {
    missing.add(key)
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (!upstream.ok) {
    return new Response(JSON.stringify({ error: 'Upstream error' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const bytes = new Uint8Array(await upstream.arrayBuffer())

  // 3. Write through to disk (best-effort; a concurrent duplicate write is
  //    harmless — the bytes are identical). Never fail the response on a cache
  //    write error.
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true })
    await fs.writeFile(cachePath, bytes)
  } catch {
    /* cache write failed — still serve the fetched bytes */
  }

  return new Response(bytes, { status: 200, headers: imageHeaders(valid.contentType) })
}
