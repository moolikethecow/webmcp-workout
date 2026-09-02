/**
 * Long-term memory write queue.
 *
 * The memory system is not part of this repo, so these are inert: the gym
 * engine still describes what it would remember, and nothing consumes it.
 */
export type EnqueueRetainOptions = {
  bank?: string
  context?: { skill?: string; surface?: string }
  tags?: string[]
  surfaceInChat?: boolean
  documentId?: string
}

/** Queue a fact for long-term memory. No-op without a memory backend. */
export function enqueueRetain(_content: string, _options?: EnqueueRetainOptions): void {}

/** Drop a queued retain by document id. Returns how many were removed. */
export function dropQueuedRetain(_documentId: string): number {
  return 0
}
