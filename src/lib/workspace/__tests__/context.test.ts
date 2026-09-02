/**
 * Resolution order. The override has to win over the request, because the
 * provisioner, the sweeper and every script run INSIDE a request in dev
 * (Next's dev server keeps one async context) and must not be dragged back to
 * the browsing visitor's schema.
 */
import { describe, expect, it, vi } from 'vitest'

const mockHeaders = vi.hoisted(() => vi.fn())
const mockCookies = vi.hoisted(() => vi.fn())
vi.mock('next/headers', () => ({ headers: mockHeaders, cookies: mockCookies }))

import {
  NoWorkspaceError,
  currentWorkspaceId,
  currentWorkspaceKey,
  getWorkspaceStore,
  runProvisioning,
  runWithWorkspace,
  schemaNameFor,
} from '@/lib/workspace/context'

const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const B = 'bbbbbbbb-cccc-4ddd-9eee-ffffffffffff'

function withRequest(opts: { header?: string; cookie?: string }) {
  mockHeaders.mockResolvedValue({ get: () => opts.header ?? null })
  mockCookies.mockResolvedValue({ get: () => (opts.cookie ? { value: opts.cookie } : undefined) })
}

describe('currentWorkspaceId', () => {
  it('prefers the AsyncLocalStorage override over the request', async () => {
    withRequest({ header: B, cookie: B })
    await runWithWorkspace(A, async () => {
      expect(await currentWorkspaceId()).toBe(A)
    })
  })

  it('reads the middleware header before the cookie', async () => {
    withRequest({ header: A, cookie: B })
    expect(await currentWorkspaceId()).toBe(A)
  })

  it('falls back to the cookie when the header is absent or malformed', async () => {
    withRequest({ header: 'nope', cookie: B })
    expect(await currentWorkspaceId()).toBe(B)
  })

  it('throws NoWorkspaceError when nothing identifies the caller', async () => {
    withRequest({})
    await expect(currentWorkspaceId()).rejects.toBeInstanceOf(NoWorkspaceError)
  })

  it('survives next/headers throwing outside a request scope', async () => {
    mockHeaders.mockRejectedValue(new Error('called outside a request scope'))
    mockCookies.mockRejectedValue(new Error('called outside a request scope'))
    await expect(currentWorkspaceId()).rejects.toBeInstanceOf(NoWorkspaceError)
    // …and the DDL memo key degrades to a sentinel rather than exploding.
    expect(await currentWorkspaceKey()).toBe('__none__')
  })

  it('exposes the provisioning flag only inside runProvisioning', async () => {
    withRequest({})
    await runWithWorkspace(A, async () => {
      expect(getWorkspaceStore()).toEqual({ id: A, provisioning: false })
    })
    await runProvisioning(A, async () => {
      expect(getWorkspaceStore()).toEqual({ id: A, provisioning: true })
    })
    expect(getWorkspaceStore()).toBeUndefined()
  })

  it('refuses to enter an override for a non-uuid id', () => {
    expect(() => runWithWorkspace('public', async () => undefined)).toThrow(/invalid id/)
  })
})

describe('schemaNameFor', () => {
  it('is ws_ + the 32 hex digits, lower-cased', () => {
    expect(schemaNameFor(A)).toBe('ws_aaaaaaaabbbb4ccc8dddeeeeeeeeeeee')
    expect(schemaNameFor(A.toUpperCase())).toBe('ws_aaaaaaaabbbb4ccc8dddeeeeeeeeeeee')
    expect(schemaNameFor(A).length).toBe(35)
  })

  it('refuses anything that is not a v4 uuid (it becomes an identifier)', () => {
    expect(() => schemaNameFor('public"; DROP SCHEMA public; --')).toThrow(/refusing/)
  })
})
