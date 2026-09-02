/**
 * Per-visitor workspace cookie.
 *
 * The app has no accounts. A visitor IS their `ws` cookie: it selects the
 * Postgres schema every query runs against (see `@/lib/db/client`). This
 * middleware is the only place one is minted.
 *
 * Two things happen on a first visit, and both matter:
 *
 *  1. `Set-Cookie` on the response — so the NEXT request identifies itself.
 *  2. `x-workspace-id` on the forwarded REQUEST headers — so THIS request can
 *     already resolve a workspace. Without it the very first page load (and
 *     the fetches it fires) would have no workspace at all and 400.
 *
 * Runs on the Edge runtime: no `pg`, no `node:async_hooks`, no `next/headers`.
 * It imports only `./lib/workspace/ids`, which is deliberately dependency-free.
 */
import { NextResponse, type NextRequest } from 'next/server'

import {
  WORKSPACE_COOKIE,
  WORKSPACE_COOKIE_MAX_AGE,
  WORKSPACE_HEADER,
  isWorkspaceId,
} from './lib/workspace/ids'

export function middleware(req: NextRequest): NextResponse {
  const existing = req.cookies.get(WORKSPACE_COOKIE)?.value
  const valid = isWorkspaceId(existing)
  // A malformed cookie (truncated, hand-edited, from an older scheme) is
  // REPLACED rather than trusted — it would otherwise become a schema name.
  const id = valid ? existing : crypto.randomUUID()

  const headers = new Headers(req.headers)
  headers.set(WORKSPACE_HEADER, id)
  const res = NextResponse.next({ request: { headers } })

  if (!valid) {
    res.cookies.set({
      name: WORKSPACE_COOKIE,
      value: id,
      httpOnly: true,
      // Local dev is plain http; a Secure cookie there would never be stored.
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: WORKSPACE_COOKIE_MAX_AGE,
    })
  }

  return res
}

export const config = {
  // Everything except the immutable build output and the favicon — API routes
  // included, since they are what actually read the workspace.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
