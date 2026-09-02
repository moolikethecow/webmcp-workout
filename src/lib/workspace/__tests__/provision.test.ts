/**
 * Provisioning is the one thing in this subsystem that MUST NOT run twice.
 * The first page load of a new workspace fires a dozen parallel fetches, all
 * of which reach the db client before any schema exists — if each one ran the
 * DDL + the 1300-row catalog insert the first visit would take a minute and
 * deadlock on itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Row { [k: string]: unknown }

const state = vi.hoisted(() => ({
  /** Every statement the unscoped (public-schema) client has run. */
  sql: [] as string[],
  /** Rows the next SELECT should return, keyed by a substring of the query. */
  seeded: false,
  schemaExists: false,
}))

const mockUnscopedExecute = vi.hoisted(() =>
  vi.fn(async (query: { queryChunks?: unknown[] }) => {
    const text = JSON.stringify(query)
    state.sql.push(text)
    if (text.includes('seeded_at IS NOT NULL')) {
      return { rows: state.seeded ? [{ seeded: true }] : ([] as Row[]) }
    }
    if (text.includes('pg_namespace')) {
      return { rows: state.schemaExists ? [{ '?column?': 1 }] : ([] as Row[]) }
    }
    if (text.includes('created_at')) {
      return { rows: [{ created_at: '2026-09-01T00:00:00Z', seeded_at: '2026-09-01T00:00:01Z' }] }
    }
    return { rows: [] as Row[] }
  }),
)

const mockEnsureGym = vi.hoisted(() => vi.fn(async () => undefined))
const mockEnsureSettings = vi.hoisted(() => vi.fn(async () => undefined))
const mockSeed = vi.hoisted(() => vi.fn(async () => ({ seeded: true })))

vi.mock('@/lib/db/client', () => ({
  unscopedDb: () => ({ execute: mockUnscopedExecute }),
  workspaceDrizzle: vi.fn(() => ({ marker: 'ws-drizzle' })),
  closeWorkspacePool: vi.fn(async () => undefined),
}))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: mockEnsureGym }))
vi.mock('@/lib/db/ensure-app-settings', () => ({ ensureAppSettingsSchema: mockEnsureSettings }))
vi.mock('@/lib/workspace/seed', () => ({ seedWorkspace: mockSeed, resetWorkspace: vi.fn() }))

const { ensureProvisioned, forgetProvisioned, workspaceInfo } = await import('@/lib/workspace/provision')
const { getWorkspaceStore } = await import('@/lib/workspace/context')

const ID = 'aaaaaaaa-1111-4222-8333-444444444444'
const OTHER = 'bbbbbbbb-1111-4222-8333-444444444444'

beforeEach(() => {
  state.sql.length = 0
  state.seeded = false
  state.schemaExists = false
  forgetProvisioned(ID)
  forgetProvisioned(OTHER)
  mockUnscopedExecute.mockClear()
  mockEnsureGym.mockClear()
  mockEnsureSettings.mockClear()
  mockSeed.mockClear()
})

describe('ensureProvisioned', () => {
  it('creates the schema, migrates and seeds exactly once under concurrency', async () => {
    await Promise.all(Array.from({ length: 12 }, () => ensureProvisioned(ID)))

    expect(mockEnsureGym).toHaveBeenCalledTimes(1)
    expect(mockEnsureSettings).toHaveBeenCalledTimes(1)
    expect(mockSeed).toHaveBeenCalledTimes(1)
    expect(state.sql.filter((s) => s.includes('CREATE SCHEMA'))).toHaveLength(1)
    expect(state.sql.some((s) => s.includes('ws_aaaaaaaa111142228333444444444444'))).toBe(true)
  })

  it('does no DB work at all on subsequent calls in the same process', async () => {
    await ensureProvisioned(ID)
    const after = mockUnscopedExecute.mock.calls.length
    await ensureProvisioned(ID)
    await ensureProvisioned(ID)
    // Only the throttled last_seen_at heartbeat may fire, and not within 10min.
    expect(mockUnscopedExecute.mock.calls.length).toBe(after)
  })

  it('runs the DDL and the seed inside the provisioning async context', async () => {
    let seen: { id: string; provisioning: boolean } | undefined
    mockEnsureGym.mockImplementationOnce(async () => {
      seen = getWorkspaceStore()
    })
    await ensureProvisioned(ID)
    // Without provisioning:true the DDL's own db.execute would re-enter
    // ensureProvisioned and await the promise it is itself inside of.
    expect(seen).toEqual({ id: ID, provisioning: true })
  })

  it('skips the work when the registry says seeded AND the schema is still there', async () => {
    state.seeded = true
    state.schemaExists = true
    await ensureProvisioned(ID)
    expect(mockEnsureGym).not.toHaveBeenCalled()
    expect(mockSeed).not.toHaveBeenCalled()
  })

  it('re-provisions when the registry says seeded but the schema was dropped', async () => {
    state.seeded = true
    state.schemaExists = false
    await ensureProvisioned(ID)
    expect(mockSeed).toHaveBeenCalledTimes(1)
  })

  it('retries on the next call after a failure instead of caching the rejection', async () => {
    mockSeed.mockRejectedValueOnce(new Error('catalog insert blew up'))
    await expect(ensureProvisioned(ID)).rejects.toThrow('catalog insert blew up')
    await expect(ensureProvisioned(ID)).resolves.toBeUndefined()
    expect(mockSeed).toHaveBeenCalledTimes(2)
  })

  it('provisions each workspace independently', async () => {
    await Promise.all([ensureProvisioned(ID), ensureProvisioned(OTHER)])
    expect(mockSeed).toHaveBeenCalledTimes(2)
    expect(state.sql.filter((s) => s.includes('CREATE SCHEMA'))).toHaveLength(2)
  })

  it('refuses a non-uuid id rather than building a schema name from it', async () => {
    await expect(ensureProvisioned('public')).rejects.toThrow(/invalid id/)
  })
})

describe('workspaceInfo', () => {
  it('returns the registry row', async () => {
    await expect(workspaceInfo(ID)).resolves.toEqual({
      id: ID,
      createdAt: '2026-09-01T00:00:00Z',
      seededAt: '2026-09-01T00:00:01Z',
    })
  })
})
