'use client'

/**
 * Write queue for the optimistic active-workout store (GYM_PLAN §2.4, P2a).
 *
 * The store mutates in-memory state INSTANTLY on every set edit and hands the
 * new canonical set rows for a touched exercise to this queue via `enqueue()`. A
 * ✓ tap NEVER awaits the network — this queue debounces the coalesced batch and
 * PUTs it in the background:
 *
 *   - COALESCE: per touched workout_exercise we keep the LATEST full set array
 *     (a later enqueue for the same exercise replaces the earlier one), plus an
 *     accumulating delete set. One PUT body carries every touched exercise +
 *     deleteClientSetIds.
 *   - DEBOUNCE ~800ms; `flush()` sends immediately (completeSet + window
 *     blur/visibilitychange-hidden call it).
 *   - RETRY forever while the workout is open, exponential backoff 1s→2s→4s→8s
 *     cap. navigator.onLine === false OR a fetch failure ⇒ syncState 'offline';
 *     a success clears it back to 'saved'/'pending'.
 *   - MIRROR: the unflushed queue is written to localStorage on every enqueue and
 *     flush attempt (key gym-queue-v1), cleared when the queue drains. On
 *     mount the store replays any mirrored queue for the current workout id then
 *     flushes. The mirror is crash-recovery for in-flight edits — never the
 *     workout source (the DB is).
 *
 * Timers + fetch are injected so tests drive them with fake timers and a mock
 * fetch (no real network, no real clock).
 */

import {
  QUEUE_MIRROR_KEY,
  type QueueMirror,
  type SetUpsertPayload,
  type SetsPutBody,
  type SetsPutResponse,
  type SyncState,
} from './active-types'

/** Debounce window before a coalesced batch auto-flushes. */
export const DEBOUNCE_MS = 800
/** Backoff schedule (ms) for failed flushes; last value is the cap. */
export const BACKOFF_MS = [1000, 2000, 4000, 8000] as const

/** Typed terminal response from the optimistic-revision routes. Unlike a
 * network failure this must never enter the blind retry loop: the pending local
 * rows first need rebasing over the new canonical workout generation. */
export class StaleWorkoutRevisionError extends Error {
  readonly code = 'stale_revision'

  constructor(message = 'Workout changed since it was loaded.') {
    super(message)
    this.name = 'StaleWorkoutRevisionError'
  }
}

/** Raised only by awaited terminal actions (Finish / structural edits) when the
 * optimistic queue could not prove every local value reached Postgres. */
export class WorkoutSyncPendingError extends Error {
  constructor(readonly syncState: SyncState) {
    super(syncState === 'offline'
      ? 'Workout changes are still saved locally. Reconnect before continuing.'
      : 'Workout changes are still being reconciled. Try again in a moment.')
    this.name = 'WorkoutSyncPendingError'
  }
}

export function isStaleWorkoutRevisionError(error: unknown): error is StaleWorkoutRevisionError {
  return error instanceof StaleWorkoutRevisionError ||
    (typeof error === 'object' && error != null && 'code' in error && error.code === 'stale_revision')
}

export interface PendingQueueSnapshot {
  dirtyByExercise: Record<string, SetUpsertPayload[]>
  baseByExercise: Record<string, SetUpsertPayload[]>
  exerciseIdByExercise: Record<string, string>
  deletes: string[]
}

export interface WriteQueueDeps {
  /** POST/PUT the batch. Resolves on 2xx; rejects on any non-ok / network error. */
  put: (body: SetsPutBody) => Promise<SetsPutResponse>
  /** Canonical active-workout generation at queue construction. The fallback
   * keeps a pre-revision crash mirror readable during the rollout. */
  initialRevision?: number
  /** Called with the server-canonical sets after a successful flush (store reconciles). */
  onAck?: (res: SetsPutResponse) => void
  /** A stale revision needs a canonical fetch/rebase, not a retry timer. */
  onConflict?: () => void | Promise<void>
  /** Called whenever the sync state changes (drives the pill). */
  onSyncStateChange?: (state: SyncState) => void
  /** navigator.onLine getter (injectable for tests). Defaults to real navigator. */
  isOnline?: () => boolean
  /** setTimeout / clearTimeout (injectable). Default to globals. */
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (h: ReturnType<typeof setTimeout>) => void
  /** localStorage-like store for the mirror (injectable; default globalThis.localStorage). */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
}

export class WriteQueue {
  private readonly workoutId: string
  private readonly deps: Required<Omit<WriteQueueDeps, 'initialRevision' | 'onAck' | 'onConflict' | 'onSyncStateChange' | 'storage'>> & {
    onAck?: WriteQueueDeps['onAck']
    onConflict?: WriteQueueDeps['onConflict']
    onSyncStateChange?: WriteQueueDeps['onSyncStateChange']
    storage: WriteQueueDeps['storage']
  }

  /** Coalesced pending edits: latest full set array per workout_exercise id. */
  private dirty = new Map<string, SetUpsertPayload[]>()
  /** Canonical rows the pending local array was first edited from. This lets a
   * conflict rebase carry only actual local deltas over the server's newer model. */
  private base = new Map<string, SetUpsertPayload[]>()
  private exerciseIds = new Map<string, string>()
  /** Accumulated deletes (clientSetIds). */
  private deletes = new Set<string>()

  private debounceHandle: ReturnType<typeof setTimeout> | null = null
  private retryHandle: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private attempt = 0
  private syncState: SyncState = 'saved'
  private revision: number
  private conflicted = false
  private closed = false

  constructor(workoutId: string, deps: WriteQueueDeps) {
    this.workoutId = workoutId
    this.revision = normalizeRevision(deps.initialRevision ?? 0)
    const g = globalThis as unknown as {
      setTimeout: typeof setTimeout
      clearTimeout: typeof clearTimeout
      navigator?: { onLine?: boolean }
      localStorage?: Storage
    }
    this.deps = {
      put: deps.put,
      onAck: deps.onAck,
      onConflict: deps.onConflict,
      onSyncStateChange: deps.onSyncStateChange,
      isOnline: deps.isOnline ?? (() => g.navigator?.onLine ?? true),
      setTimeout: deps.setTimeout ?? ((fn, ms) => g.setTimeout(fn, ms)),
      clearTimeout: deps.clearTimeout ?? ((h) => g.clearTimeout(h)),
      storage: deps.storage !== undefined ? deps.storage : (g.localStorage ?? null),
    }
  }

  /** The current sync-pill state. */
  getSyncState(): SyncState {
    return this.syncState
  }

  /** Generation the next pending batch will compare-and-swap against. */
  getRevision(): number {
    return this.revision
  }

  hasConflict(): boolean {
    return this.conflicted
  }

  /** Number of exercises with pending edits (drives "N pending"). */
  pendingCount(): number {
    return this.dirty.size + (this.deletes.size > 0 ? 1 : 0)
  }

  /** True when nothing is pending and nothing is in flight. */
  isIdle(): boolean {
    return this.dirty.size === 0 && this.deletes.size === 0 && !this.inFlight && !this.conflicted
  }

  /** Copy the latest unsaved user intent for canonical rebase/recovery. */
  pendingSnapshot(): PendingQueueSnapshot {
    return {
      dirtyByExercise: Object.fromEntries(
        [...this.dirty].map(([id, sets]) => [id, sets.map((set) => ({ ...set }))]),
      ),
      baseByExercise: Object.fromEntries(
        [...this.base].map(([id, sets]) => [id, sets.map((set) => ({ ...set }))]),
      ),
      exerciseIdByExercise: Object.fromEntries(this.exerciseIds),
      deletes: [...this.deletes],
    }
  }

  /** Replace the stale pending payload with a canonical-rebased payload and
   * resume at that canonical generation. The caller explicitly flushes after it
   * has installed the same rebased rows into the visible store. */
  replacePendingAtRevision(revision: number, snapshot: PendingQueueSnapshot): void {
    this.clearDebounce()
    this.clearRetry()
    this.revision = normalizeRevision(revision)
    this.dirty = new Map(
      Object.entries(snapshot.dirtyByExercise).map(([id, sets]) => [
        id,
        sets.map((set) => ({ ...set })),
      ]),
    )
    this.base = new Map(
      Object.entries(snapshot.baseByExercise).map(([id, sets]) => [
        id,
        sets.map((set) => ({ ...set })),
      ]),
    )
    this.exerciseIds = new Map(Object.entries(snapshot.exerciseIdByExercise))
    this.deletes = new Set(snapshot.deletes)
    this.conflicted = false
    this.attempt = 0
    this.writeMirror()
    this.setState(this.deriveState())
  }

  /** Adopt a newer canonical generation after an awaited structural response. */
  adoptRevision(revision: number): void {
    this.revision = normalizeRevision(revision)
  }

  /** True when this exercise has queued edits the server hasn't seen yet — the
   *  store's ack-reconciliation must NOT overwrite local state for it (the echo
   *  predates the pending edit). */
  hasPendingFor(workoutExerciseId: string): boolean {
    return this.dirty.has(workoutExerciseId)
  }

  /**
   * Enqueue the LATEST full set array for a touched exercise (coalescing: replaces
   * any earlier pending array for the same exercise). Starts/resets the debounce.
   */
  enqueue(
    workoutExerciseId: string,
    sets: SetUpsertPayload[],
    baseSets?: SetUpsertPayload[],
    exerciseId?: string,
  ): void {
    if (this.closed) return
    if (!this.dirty.has(workoutExerciseId) && baseSets) {
      this.base.set(workoutExerciseId, baseSets.map((set) => ({ ...set })))
    }
    if (exerciseId) this.exerciseIds.set(workoutExerciseId, exerciseId)
    this.dirty.set(workoutExerciseId, sets)
    this.writeMirror()
    this.setState(this.deriveState())
    if (!this.conflicted) this.scheduleDebounce()
  }

  /** Enqueue a set deletion (accumulates; also drops any pending edit for it). */
  enqueueDelete(clientSetId: string): void {
    if (this.closed) return
    this.deletes.add(clientSetId)
    // Drop the deleted set from any pending exercise array so we don't re-upsert it.
    for (const [weId, sets] of this.dirty) {
      const next = sets.filter((s) => s.clientSetId !== clientSetId)
      if (next.length !== sets.length) this.dirty.set(weId, next)
    }
    this.writeMirror()
    this.setState(this.deriveState())
    if (!this.conflicted) this.scheduleDebounce()
  }

  /**
   * Replay a mirrored queue (crash recovery) for this workout. Merges the mirror's
   * dirty/deletes into the live queue and schedules a flush. Ignores a mirror for
   * a different workout id.
   */
  replayMirror(mirror: QueueMirror | null, flush = true): void {
    if (!mirror || mirror.workoutId !== this.workoutId) return
    for (const [weId, sets] of Object.entries(mirror.dirtyByExercise)) {
      this.dirty.set(weId, sets)
      const base = mirror.baseByExercise?.[weId]
      if (base) this.base.set(weId, base)
      const exerciseId = mirror.exerciseIdByExercise?.[weId]
      if (exerciseId) this.exerciseIds.set(weId, exerciseId)
    }
    for (const id of mirror.deletes) this.deletes.add(id)
    if (this.dirty.size > 0 || this.deletes.size > 0) {
      this.setState(this.deriveState())
      if (flush) void this.flush()
    }
  }

  /** Immediately flush the coalesced batch (✓ tap, window blur/hidden). No-op when idle. */
  async flush(): Promise<void> {
    if (this.closed) return
    this.clearDebounce()
    if (this.conflicted) return
    if (this.inFlight) return this.inFlight
    if (this.dirty.size === 0 && this.deletes.size === 0) {
      this.setState('saved')
      return
    }
    const flight = this.drain()
    this.inFlight = flight
    try {
      await flight
    } finally {
      if (this.inFlight === flight) this.inFlight = null
    }
  }

  /** Flush and fail closed unless the queue is fully acknowledged. Background
   * autosave uses `flush`; actions that would delete the mirror use this. */
  async flushOrThrow(): Promise<void> {
    await this.flush()
    if (!this.isIdle()) throw new WorkoutSyncPendingError(this.syncState)
  }

  /**
   * Close the queue (workout finished/discarded/unmounted). Cancels timers; stops
   * retrying. Callers finish() should await a final flush BEFORE close().
   */
  close(): void {
    this.closed = true
    this.clearDebounce()
    this.clearRetry()
  }

  /** Clear the localStorage mirror (called after a fully-drained flush / discard). */
  clearMirror(): void {
    try {
      this.deps.storage?.removeItem(QUEUE_MIRROR_KEY)
    } catch {
      /* storage unavailable — ignore */
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private scheduleDebounce(): void {
    this.clearDebounce()
    this.debounceHandle = this.deps.setTimeout(() => {
      this.debounceHandle = null
      void this.flush()
    }, DEBOUNCE_MS)
  }

  private clearDebounce(): void {
    if (this.debounceHandle != null) {
      this.deps.clearTimeout(this.debounceHandle)
      this.debounceHandle = null
    }
  }

  /** Drain successive snapshots. Edits queued during one flight remain in the
   * map and are sent immediately against the acknowledged next revision. */
  private async drain(): Promise<void> {
    while (!this.closed && !this.conflicted && (this.dirty.size > 0 || this.deletes.size > 0)) {
      if (!this.deps.isOnline()) {
        this.setState('offline')
        this.scheduleRetry()
        return
      }

      const sending = new Map(this.dirty)
      const deleting = new Set(this.deletes)
      try {
        const res = await this.deps.put({
          sets: [...sending.values()].flat(),
          deleteClientSetIds: [...deleting],
          expectedRevision: this.revision,
        })
        this.attempt = 0
        this.revision = normalizeRevision(res.revision)

        // Remove exactly what was acknowledged. Any enqueue that arrived during
        // the flight replaced the array identity and remains pending.
        for (const [weId, snapshot] of sending) {
          if (this.dirty.get(weId) === snapshot) {
            this.dirty.delete(weId)
            this.base.delete(weId)
            this.exerciseIds.delete(weId)
          } else {
            // A newer local edit landed while this request was in flight. The
            // acknowledged rows are now its canonical base; older local changes
            // must not be replayed over a later agent edit.
            this.base.set(
              weId,
              snapshot.map((set) => ({ ...set })),
            )
          }
        }
        for (const id of deleting) this.deletes.delete(id)

        this.deps.onAck?.(res)
        this.writeMirror()
      } catch (error) {
        if (isStaleWorkoutRevisionError(error)) {
          this.conflicted = true
          this.setState('conflict')
          this.writeMirror()
          try {
            await this.deps.onConflict?.()
          } catch {
            // A canonical read can fail transiently too. Keep the mirror and
            // retry the whole stale-read/rebase path with normal backoff.
            this.conflicted = false
            this.setState('offline')
            this.scheduleRetry()
            return
          }
          // Recovery installs a canonical revision and rebased pending snapshot.
          // Continue the same awaited drain so a structural action or Finish can
          // never overtake the user's unsaved logger values.
          if (!this.conflicted) continue
          return
        }
        this.setState('offline')
        this.scheduleRetry()
        return
      }
    }

    if (!this.closed && !this.conflicted) {
      this.setState('saved')
      this.clearMirror()
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryHandle != null) return
    const ms = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!
    this.attempt++
    this.retryHandle = this.deps.setTimeout(() => {
      this.retryHandle = null
      void this.flush()
    }, ms)
  }

  private clearRetry(): void {
    if (this.retryHandle == null) return
    this.deps.clearTimeout(this.retryHandle)
    this.retryHandle = null
  }

  private deriveState(): SyncState {
    if (this.conflicted) return 'conflict'
    if (!this.deps.isOnline()) return 'offline'
    if (this.syncState === 'offline') return 'offline' // stay offline until a success clears it
    return this.dirty.size === 0 && this.deletes.size === 0 ? 'saved' : 'pending'
  }

  private setState(next: SyncState): void {
    if (next === this.syncState) return
    this.syncState = next
    this.deps.onSyncStateChange?.(next)
  }

  /** Persist the unflushed queue to localStorage (crash recovery). */
  private writeMirror(): void {
    if (!this.deps.storage) return
    try {
      if (this.dirty.size === 0 && this.deletes.size === 0) {
        this.deps.storage.removeItem(QUEUE_MIRROR_KEY)
        return
      }
      const mirror: QueueMirror = {
        workoutId: this.workoutId,
        revision: this.revision,
        dirtyByExercise: Object.fromEntries(this.dirty),
        baseByExercise: Object.fromEntries(this.base),
        exerciseIdByExercise: Object.fromEntries(this.exerciseIds),
        deletes: [...this.deletes],
      }
      this.deps.storage.setItem(QUEUE_MIRROR_KEY, JSON.stringify(mirror))
    } catch {
      /* storage full / unavailable — the DB is still the source of truth */
    }
  }
}

function normalizeRevision(value: number): number {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

/** Read + parse the localStorage mirror (or null). Static so the store can peek pre-construction. */
export function readQueueMirror(
  storage?: Pick<Storage, 'getItem'> | null,
): QueueMirror | null {
  const g = globalThis as unknown as { localStorage?: Storage }
  const store = storage !== undefined ? storage : (g.localStorage ?? null)
  if (!store) return null
  try {
    const raw = store.getItem(QUEUE_MIRROR_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as QueueMirror
    if (!parsed || typeof parsed.workoutId !== 'string') return null
    return parsed
  } catch {
    return null
  }
}
