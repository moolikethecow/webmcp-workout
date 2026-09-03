/**
 * Every `/api/...` path the client fetches must have a route behind it.
 *
 * This repository was created by extracting a section out of a larger app, and
 * the failure mode that produces is silent: a component comes across with its
 * `fetch('/api/health/muscle-map')` intact, the route it calls does not, and
 * nothing fails until someone opens the tab and reads "Couldn't load the muscle
 * map". Type-checking cannot see it — a URL is a string — and unit tests mock
 * `fetch`, so they cannot see it either. It shipped twice: the Body tab's map,
 * and a settings control that 404ed on every open.
 *
 * So this test walks the client source for literal API paths and resolves each
 * one against `src/app/api/**`, dynamic segments included. It is a structural
 * check, not a behavioural one: it proves a handler exists at that path, which
 * is exactly the thing the extraction can drop.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'src')
const API_ROOT = join(SRC, 'app', 'api')

/** Where client code lives. `src/app` is excluded: the route files themselves
 *  live there, and a route calling another route is a server concern. */
const CLIENT_DIRS = [join(SRC, 'components'), join(SRC, 'lib')]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full)) {
      out.push(full)
    }
  }
  return out
}

/** Every route path `src/app/api` serves, as segment arrays. A `[id]` segment
 *  matches anything; a `[...path]` segment matches the rest. */
function routePatterns(): string[][] {
  const found: string[][] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) visit(full)
      else if (entry === 'route.ts' || entry === 'route.tsx') {
        const rel = relative(API_ROOT, dir)
        found.push(rel === '' ? [] : rel.split('/'))
      }
    }
  }
  visit(API_ROOT)
  return found
}

function matches(pattern: string[], actual: string[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i]!
    if (seg.startsWith('[...')) return true // catch-all swallows the remainder
    if (i >= actual.length) return false
    if (seg.startsWith('[')) continue // dynamic segment matches any one value
    if (seg !== actual[i]) return false
  }
  return pattern.length === actual.length
}

/** Pull `/api/...` paths out of `fetch(...)` calls, dropping query strings and
 *  collapsing `${...}` interpolations to a single dynamic segment. */
function apiPathsIn(source: string): string[] {
  const out: string[] = []
  for (const match of source.matchAll(/fetch\(\s*[`'"](\/api\/[^`'"]*)/g)) {
    const raw = match[1]!
    const path = raw.split('?')[0]!.replace(/\$\{[^}]*\}/g, ':param').replace(/\/+$/, '')
    out.push(path)
  }
  return out
}

describe('client API paths resolve to a route', () => {
  const patterns = routePatterns()
  const files = CLIENT_DIRS.flatMap((dir) => walk(dir))

  const calls = files.flatMap((file) =>
    [...new Set(apiPathsIn(readFileSync(file, 'utf8')))].map((path) => ({
      file: relative(process.cwd(), file),
      path,
    })),
  )

  it('finds the client fetches at all (guards the scanner itself)', () => {
    // If the scan silently matched nothing, every assertion below would pass
    // vacuously — which is the one way this test could lie.
    expect(calls.length).toBeGreaterThan(10)
    expect(patterns.length).toBeGreaterThan(10)
    expect(calls.map((c) => c.path)).toContain('/api/health/muscle-map')
  })

  it.each(calls.map((c) => [c.path, c.file] as const))('%s (%s) has a route', (path, file) => {
    const segments = path.replace(/^\/api\//, '').split('/')
    const hit = patterns.some((pattern) => matches(pattern, segments))
    expect(hit, `${file} fetches ${path}, but no route.ts serves it`).toBe(true)
  })
})
