/**
 * agent-events.ts — a short, visible record of what the agent just did.
 *
 * When an agent edits the workout you are standing in the middle of, the app
 * has to say so. `invalidateResources(['gym'])` makes the data correct; this
 * store makes the change *legible* — a five-line feed the Train tab renders as
 * "Updated by agent", so a set that changes under your hands has an explanation
 * attached to it.
 *
 * Deliberately tiny: last 20 events, in memory, no persistence. It is a
 * transcript of this session, not a log.
 */
import { create } from 'zustand'

export interface AgentEvent {
  /** Epoch ms. */
  at: number
  /** Tool name, e.g. `edit_active_workout`. */
  tool: string
  /** One human sentence: what changed. */
  summary: string
}

const MAX_EVENTS = 20

interface AgentEventState {
  events: AgentEvent[]
  push: (event: Omit<AgentEvent, 'at'> & { at?: number }) => void
  clear: () => void
}

export const useAgentEventStore = create<AgentEventState>((set) => ({
  events: [],
  push: (event) =>
    set((state) => ({
      events: [{ at: event.at ?? Date.now(), tool: event.tool, summary: event.summary }, ...state.events].slice(
        0,
        MAX_EVENTS,
      ),
    })),
  clear: () => set({ events: [] }),
}))

/** Record an agent action. Callable from outside React (tool `execute` bodies). */
export function recordAgentEvent(tool: string, summary: string): void {
  useAgentEventStore.getState().push({ tool, summary })
}

/** Read the feed outside React (tests, debugging). */
export function agentEvents(): AgentEvent[] {
  return useAgentEventStore.getState().events
}
