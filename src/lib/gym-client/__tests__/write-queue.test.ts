/**
 * @vitest-environment jsdom
 *
 * WriteQueue unit tests (GYM_PLAN §2.4). Pure logic with fake timers + a mock
 * `put`. Covers: coalescing per exercise, debounce auto-flush, immediate flush,
 * retry/backoff on failure, offline transition (navigator.onLine + fetch fail),
 * and the localStorage-mirror replay round-trip.
 *
 * Repo scar (localStorage CI flake): the mirror key is reset in beforeEach via an
 * optional-call so a persisting store never leaks across cases.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  BACKOFF_MS,
  StaleWorkoutRevisionError,
  WriteQueue,
  readQueueMirror,
} from '../write-queue'
import { QUEUE_MIRROR_KEY, type SetUpsertPayload, type SetsPutResponse } from '../active-types'

// Map-backed localStorage (jsdom's is partial under the forks pool).
const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    get length() {
      return mem.size
    },
  },
})

function set(clientSetId: string, workoutExerciseId: string, over: Partial<SetUpsertPayload> = {}): SetUpsertPayload {
  return { clientSetId, workoutExerciseId, setNumber: 1, weight: 100, reps: 5, completed: false, ...over }
}

const OK: SetsPutResponse = { byExercise: {}, revision: 1 }

beforeEach(() => {
  vi.useFakeTimers()
  // Reset the mirror key defensively (CI localStorage-flake pattern).
  globalThis.localStorage?.setItem?.(QUEUE_MIRROR_KEY, '')
  globalThis.localStorage?.removeItem?.(QUEUE_MIRROR_KEY)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('WriteQueue coalescing + debounce', () => {
  it('coalesces multiple enqueues of the same exercise into ONE put after the debounce', async () => {
    const put = vi
      .fn<(body: { sets: SetUpsertPayload[]; deleteClientSetIds: string[]; expectedRevision: number }) => Promise<SetsPutResponse>>()
      .mockResolvedValue(OK)
    const q = new WriteQueue('w1', { put, isOnline: () => true })

    q.enqueue('ex1', [set('s1', 'ex1', { weight: 100 })])
    q.enqueue('ex1', [set('s1', 'ex1', { weight: 105 })])
    q.enqueue('ex1', [set('s1', 'ex1', { weight: 110 })])
    expect(put).not.toHaveBeenCalled() // nothing sent until debounce fires

    await vi.advanceTimersByTimeAsync(800)
    expect(put).toHaveBeenCalledTimes(1)
    // Only the LATEST value is sent (coalesced).
    expect(put.mock.calls[0]![0].sets).toEqual([expect.objectContaining({ clientSetId: 's1', weight: 110 })])
  })

  it('sends one body carrying every touched exercise + accumulated deletes', async () => {
    const put = vi.fn().mockResolvedValue(OK)
    const q = new WriteQueue('w1', { put, isOnline: () => true })
    q.enqueue('ex1', [set('s1', 'ex1')])
    q.enqueue('ex2', [set('s2', 'ex2')])
    q.enqueueDelete('s3')
    await vi.advanceTimersByTimeAsync(800)
    expect(put).toHaveBeenCalledTimes(1)
    const body = put.mock.calls[0]![0]
    expect(body.sets.map((s: SetUpsertPayload) => s.clientSetId).sort()).toEqual(['s1', 's2'])
    expect(body.deleteClientSetIds).toEqual(['s3'])
  })
})

describe('WriteQueue flush-on-complete', () => {
  it('flush() sends immediately without waiting the debounce', async () => {
    const put = vi.fn().mockResolvedValue(OK)
    const q = new WriteQueue('w1', { put, isOnline: () => true })
    q.enqueue('ex1', [set('s1', 'ex1', { completed: true })])
    await q.flush()
    expect(put).toHaveBeenCalledTimes(1) // no timer advance needed
  })

  it('drains to saved after a successful flush + clears the mirror', async () => {
    const states: string[] = []
    const put = vi.fn().mockResolvedValue(OK)
    const q = new WriteQueue('w1', { put, isOnline: () => true, onSyncStateChange: (s) => states.push(s) })
    q.enqueue('ex1', [set('s1', 'ex1')])
    expect(q.getSyncState()).toBe('pending')
    expect(readQueueMirror()).not.toBeNull() // mirror written on enqueue
    await q.flush()
    expect(q.getSyncState()).toBe('saved')
    expect(readQueueMirror()).toBeNull() // cleared when drained
    expect(states).toContain('pending')
    expect(states).toContain('saved')
  })

  it('sends the loaded revision and advances it from each canonical ack', async () => {
    const put = vi
      .fn()
      .mockResolvedValueOnce({ byExercise: {}, revision: 8 })
      .mockResolvedValueOnce({ byExercise: {}, revision: 9 })
    const q = new WriteQueue('w1', { put, initialRevision: 7, isOnline: () => true })

    q.enqueue('ex1', [set('s1', 'ex1')])
    await q.flush()
    q.enqueue('ex1', [set('s1', 'ex1', { weight: 105 })])
    await q.flush()

    expect(put.mock.calls.map(([body]) => body.expectedRevision)).toEqual([7, 8])
    expect(q.getRevision()).toBe(9)
  })

  it('awaits a canonical rebase after a stale revision, then retries once at the new revision', async () => {
    const put = vi
      .fn()
      .mockRejectedValueOnce(new StaleWorkoutRevisionError())
      .mockResolvedValueOnce({ byExercise: {}, revision: 12 })
    let q!: WriteQueue
    const onConflict = vi.fn(async () => {
      q.replacePendingAtRevision(11, q.pendingSnapshot())
    })
    q = new WriteQueue('w1', {
      put,
      initialRevision: 10,
      isOnline: () => true,
      onConflict,
    })
    q.enqueue('ex1', [set('s1', 'ex1', { weight: 225 })])

    await q.flush()

    expect(onConflict).toHaveBeenCalledTimes(1)
    expect(put.mock.calls.map(([body]) => body.expectedRevision)).toEqual([10, 11])
    expect(q.getSyncState()).toBe('saved')
    expect(q.getRevision()).toBe(12)
  })

  it('fails a terminal flush closed while offline and keeps the crash mirror', async () => {
    const q = new WriteQueue('w1', {
      put: vi.fn(),
      initialRevision: 3,
      isOnline: () => false,
    })
    q.enqueue('ex1', [set('s1', 'ex1', { completed: true })])

    await expect(q.flushOrThrow()).rejects.toThrow('saved locally')
    expect(q.pendingCount()).toBeGreaterThan(0)
    expect(readQueueMirror()).toMatchObject({ workoutId: 'w1', revision: 3 })
  })
})

describe('WriteQueue retry + backoff + offline', () => {
  it('goes offline on fetch failure and retries with exponential backoff', async () => {
    const put = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(OK)
    const states: string[] = []
    const q = new WriteQueue('w1', { put, isOnline: () => true, onSyncStateChange: (s) => states.push(s) })

    q.enqueue('ex1', [set('s1', 'ex1')])
    await vi.advanceTimersByTimeAsync(800) // debounce fires → attempt 1 fails
    expect(q.getSyncState()).toBe('offline')

    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]) // retry 1 (1s) → fails
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[1]) // retry 2 (2s) → succeeds
    expect(put).toHaveBeenCalledTimes(3)
    expect(q.getSyncState()).toBe('saved')
    expect(states).toContain('offline')
  })

  it('short-circuits to offline (no fetch) when navigator is offline', async () => {
    let online = false
    const put = vi.fn().mockResolvedValue(OK)
    const q = new WriteQueue('w1', { put, isOnline: () => online })
    q.enqueue('ex1', [set('s1', 'ex1')])
    await vi.advanceTimersByTimeAsync(800)
    expect(put).not.toHaveBeenCalled() // never burned a doomed fetch
    expect(q.getSyncState()).toBe('offline')

    // Reconnect → a retry flushes.
    online = true
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
    expect(put).toHaveBeenCalledTimes(1)
    expect(q.getSyncState()).toBe('saved')
  })
})

describe('WriteQueue mirror replay (crash recovery)', () => {
  it('replays a mirrored queue for the same workout id and flushes it', async () => {
    // Simulate a prior crash: the mirror holds one dirty exercise + a delete.
    const mirror = {
      workoutId: 'w1',
      dirtyByExercise: { ex1: [set('s1', 'ex1', { weight: 225 })] },
      deletes: ['s9'],
    }
    globalThis.localStorage!.setItem(QUEUE_MIRROR_KEY, JSON.stringify(mirror))

    const put = vi.fn().mockResolvedValue(OK)
    const q = new WriteQueue('w1', { put, isOnline: () => true })
    q.replayMirror(readQueueMirror())
    await vi.advanceTimersByTimeAsync(0) // the replay flush is immediate
    expect(put).toHaveBeenCalledTimes(1)
    const body = put.mock.calls[0]![0]
    expect(body.sets).toEqual([expect.objectContaining({ clientSetId: 's1', weight: 225 })])
    expect(body.deleteClientSetIds).toEqual(['s9'])
  })

  it('ignores a mirror for a different workout id', async () => {
    const put = vi.fn().mockResolvedValue(OK)
    const q = new WriteQueue('w1', { put, isOnline: () => true })
    q.replayMirror({ workoutId: 'OTHER', dirtyByExercise: { ex: [set('s', 'ex')] }, deletes: [] })
    await vi.advanceTimersByTimeAsync(800)
    expect(put).not.toHaveBeenCalled()
  })
})
