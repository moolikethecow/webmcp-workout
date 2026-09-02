/**
 * The per-workspace pool cache. Two properties the isolation depends on:
 * every pool pins its own `search_path` on connect (an unpinned connection
 * reads `public` and sees nothing / the wrong thing), and the LRU actually
 * CLOSES what it evicts (a leaked pool holds 3 Postgres backends forever).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

class FakePool extends EventEmitter {
  static instances: FakePool[] = []
  ended = false
  readonly config: unknown
  constructor(config: unknown) {
    super()
    this.config = config
    FakePool.instances.push(this)
  }
  async end(): Promise<void> {
    this.ended = true
  }
}

vi.mock('pg', () => ({ Pool: FakePool }))
// drizzle would reject our fake client; the cache only ever hands back what
// this returns, so identity-wrapping is enough.
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: (pool: unknown) => ({ pool }),
}))

const { workspaceDrizzle, closeWorkspacePool } = await import('@/lib/db/client')

/** Deterministic distinct v4 uuids: `n` in the last block. */
function wsId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

afterEach(() => {
  FakePool.instances.length = 0
})

describe('poolFor / workspaceDrizzle', () => {
  it('creates one pool per workspace and reuses it', () => {
    const first = workspaceDrizzle(wsId(1))
    const again = workspaceDrizzle(wsId(1))
    expect(again).toBe(first)
    expect(workspaceDrizzle(wsId(2))).not.toBe(first)
  })

  it('pins search_path on every new connection, quoted and schema-scoped', async () => {
    workspaceDrizzle(wsId(3))
    const pool = FakePool.instances.at(-1)!
    const client = { query: vi.fn().mockResolvedValue(undefined) }
    pool.emit('connect', client)
    expect(client.query).toHaveBeenCalledWith(
      'SET search_path TO "ws_00000000000040008000000000000003", public',
    )
  })

  it('creates each pool with a small max so 40 workspaces stay affordable', () => {
    workspaceDrizzle(wsId(4))
    const config = FakePool.instances.at(-1)!.config as { max: number; idleTimeoutMillis: number }
    expect(config.max).toBe(3)
    expect(config.idleTimeoutMillis).toBe(30_000)
  })

  it('evicts the least-recently-used pool past 40 and ENDS it', async () => {
    // Fill well past the cap, touching wsId(100) partway so it is not oldest.
    for (let i = 100; i < 145; i += 1) {
      workspaceDrizzle(wsId(i))
      if (i === 120) workspaceDrizzle(wsId(100))
    }
    await new Promise((r) => setImmediate(r))

    const ended = FakePool.instances.filter((p) => p.ended)
    expect(ended.length).toBeGreaterThan(0)
    // wsId(100) was re-touched, so it must have survived the sweep.
    const before = FakePool.instances.length
    workspaceDrizzle(wsId(100))
    expect(FakePool.instances.length).toBe(before)
  })

  it('closeWorkspacePool ends the pool and forgets it', async () => {
    const id = wsId(200)
    workspaceDrizzle(id)
    const pool = FakePool.instances.at(-1)!
    await closeWorkspacePool(id)
    expect(pool.ended).toBe(true)

    const before = FakePool.instances.length
    workspaceDrizzle(id)
    expect(FakePool.instances.length).toBe(before + 1)
  })

  it('is a no-op for an unknown id', async () => {
    await expect(closeWorkspacePool(wsId(999))).resolves.toBeUndefined()
  })
})
