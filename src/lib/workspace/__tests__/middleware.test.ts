/**
 * The workspace cookie is minted in exactly one place. These cover the two
 * behaviours everything else assumes: a first visit gets a cookie AND an
 * `x-workspace-id` on its own forwarded request, and a returning visit is left
 * completely alone (no rotation — rotating would orphan their schema).
 */
import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'

import { middleware } from '@/middleware'
import { WORKSPACE_COOKIE, WORKSPACE_HEADER, isWorkspaceId } from '@/lib/workspace/ids'

function request(cookie?: string): NextRequest {
  const req = new NextRequest('http://localhost/gym')
  if (cookie !== undefined) req.cookies.set(WORKSPACE_COOKIE, cookie)
  return req
}

/** The header the middleware asks Next to forward on the SAME request. */
function forwardedWorkspace(res: Response): string | null {
  return res.headers.get('x-middleware-request-' + WORKSPACE_HEADER)
}

describe('middleware — workspace cookie', () => {
  it('mints a v4 uuid when there is no cookie, and forwards it on this request', () => {
    const res = middleware(request())

    const set = res.cookies.get(WORKSPACE_COOKIE)
    expect(set).toBeDefined()
    expect(isWorkspaceId(set?.value)).toBe(true)
    expect(set?.httpOnly).toBe(true)
    expect(set?.sameSite).toBe('lax')
    expect(set?.path).toBe('/')
    expect(set?.maxAge).toBe(180 * 24 * 60 * 60)

    // The first request must already be attributable, not wait for the echo.
    expect(forwardedWorkspace(res)).toBe(set?.value)
  })

  it('preserves a valid cookie and sets no new one', () => {
    const existing = '11111111-2222-4333-8444-555555555555'
    const res = middleware(request(existing))

    expect(res.cookies.get(WORKSPACE_COOKIE)).toBeUndefined()
    expect(forwardedWorkspace(res)).toBe(existing)
  })

  it.each([
    ['empty', ''],
    ['not a uuid', 'hello'],
    ['uuid v1 (wrong version nibble)', '11111111-2222-1333-8444-555555555555'],
    ['truncated', '11111111-2222-4333-8444-5555555555'],
    ['sql-ish', "'; DROP SCHEMA public; --"],
  ])('replaces an invalid cookie (%s)', (_label, bad) => {
    const res = middleware(request(bad))
    const set = res.cookies.get(WORKSPACE_COOKIE)
    expect(isWorkspaceId(set?.value)).toBe(true)
    expect(set?.value).not.toBe(bad)
  })

  it('does not mark the cookie Secure outside production (dev is plain http)', () => {
    const res = middleware(request())
    expect(res.cookies.get(WORKSPACE_COOKIE)?.secure).toBe(process.env.NODE_ENV === 'production')
  })
})
