import type { NextRequest } from 'next/server'

import { WORKSPACE_COOKIE, WORKSPACE_HEADER, isWorkspaceId } from '@/lib/workspace/ids'

/**
 * Request authentication for the gym API routes.
 *
 * This app has no accounts: a visitor is identified by their workspace cookie,
 * which `src/middleware.ts` mints on first contact. The gate therefore asks the
 * only question that has an answer here — "is this request attributable to a
 * workspace?" — and leaves the 25 route files untouched.
 *
 * It is NOT a security boundary between visitors (a cookie is guessable only in
 * the sense that a UUID is). It is the seam that turns "no workspace" into a
 * clean 401 at the edge of the route layer instead of a `NoWorkspaceError`
 * surfacing as a 500 from somewhere deep in the db client.
 */
export function authenticateRequest(req: NextRequest): boolean {
  if (isWorkspaceId(req.headers.get(WORKSPACE_HEADER))) return true
  return isWorkspaceId(req.cookies.get(WORKSPACE_COOKIE)?.value)
}
