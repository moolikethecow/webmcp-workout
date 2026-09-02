/**
 * Test helper: flatten a drizzle `sql` template (as handed to `db.execute`) back
 * into its raw SQL text so a test can assert on the query's shape without a live
 * DB. Recurses through nested SQL fragments (e.g. `sql.join(...)`, embedded
 * `sql\`\`\``), so a filter added deep inside a composed query is still visible.
 *
 * Used by the §3b filter-sweep regressions (GYM_PLAN §3b): every workout-
 * aggregating query must carry `w.status = 'completed'`, and the cheapest way to
 * prove that against the codebase's mock-`db.execute` test style is to inspect the
 * SQL text the function would have run.
 */

/** A minimal structural view of a drizzle SQL object's chunks. */
interface SqlLike {
  queryChunks?: unknown[]
}

/** True when `v` looks like a drizzle StringChunk ({ value: string[] }). */
function isStringChunk(v: unknown): v is { value: string[] } {
  return (
    typeof v === 'object' &&
    v !== null &&
    'value' in v &&
    Array.isArray((v as { value: unknown }).value)
  )
}

/** True when `v` looks like a nested SQL object ({ queryChunks: unknown[] }). */
function isSqlLike(v: unknown): v is SqlLike {
  return (
    typeof v === 'object' &&
    v !== null &&
    'queryChunks' in v &&
    Array.isArray((v as SqlLike).queryChunks)
  )
}

/** Recursively collect the static text of one chunk into `parts`. */
function walk(chunk: unknown, parts: string[]): void {
  if (chunk == null) return
  if (typeof chunk === 'string') {
    parts.push(chunk)
    return
  }
  if (Array.isArray(chunk)) {
    for (const c of chunk) walk(c, parts)
    return
  }
  if (isStringChunk(chunk)) {
    parts.push(chunk.value.join(''))
    return
  }
  if (isSqlLike(chunk)) {
    for (const c of chunk.queryChunks!) walk(c, parts)
    return
  }
  // Parameter placeholders (bound values) carry no static text — skip them.
}

/** Flatten one `sql` template (or raw string) to its static SQL text. */
export function sqlText(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (isSqlLike(arg)) {
    const parts: string[] = []
    for (const c of arg.queryChunks!) walk(c, parts)
    return parts.join(' ')
  }
  return String(arg)
}

/** Every SQL statement a mocked `db.execute` was called with, as text. */
export function firedSql(calls: Array<unknown[]>): string[] {
  return calls.map((call) => sqlText(call[0]))
}

/**
 * Normalize whitespace so a status-filter regex matches regardless of how the
 * source formats the clause (newlines/indentation collapse to single spaces).
 */
export function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ')
}

/** The bound parameter VALUES of one `sql` template, in order. `sqlText` skips
 *  these (they carry no static text), so assertions about what a statement
 *  actually writes — not just its shape — read them here. */
export function sqlParams(arg: unknown): unknown[] {
  const out: unknown[] = []
  const visit = (chunk: unknown, top: boolean): void => {
    if (isSqlLike(chunk)) {
      for (const c of chunk.queryChunks!) visit(c, false)
      return
    }
    if (top) return
    // Static text arrives as StringChunk; everything else in the chunk list is an
    // interpolated value (drizzle keeps primitives raw, including null).
    if (isStringChunk(chunk)) return
    if (Array.isArray(chunk)) {
      for (const c of chunk) visit(c, false)
      return
    }
    out.push(chunk)
  }
  visit(arg, true)
  return out
}

/** The §3b invariant, as a regex: a completed-status filter on the workouts row. */
export const STATUS_COMPLETED_RE = /w(?:orkouts?)?\.status\s*=\s*'completed'|status\s*=\s*'completed'/
