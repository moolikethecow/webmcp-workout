/**
 * agent-events.ts — a short, visible record of what the agent just did.
 *
 * When an agent edits the workout you are standing in the middle of, the app
 * has to say so. `invalidateResources(['gym'])` makes the data correct; this
 * store makes the change *legible* — a five-line feed the Train tab renders as
 * "Updated by agent", so a set that changes under your hands has an explanation
 * attached to it.
 *
 * Three slices, all in memory and all deliberately tiny:
 *
 *   events        the last 20 actions, newest first. A transcript of this
 *                 session, not a log.
 *   touched       exercise name → when an agent last changed it, so the row in
 *                 front of you can pulse for a moment instead of silently
 *                 becoming a different number.
 *   registration  what `registerTools` actually managed to do in this browser,
 *                 set by `useGymWebMCP`. The UI reports it verbatim: a browser
 *                 without WebMCP must be told it has no WebMCP, not shown a
 *                 count of zero tools.
 */
import { create } from 'zustand'

export interface AgentEvent {
  /** Epoch ms. */
  at: number
  /** Tool name, e.g. `edit_active_workout`. */
  tool: string
  /** One human sentence: what changed. */
  summary: string
  /** Exercise names this event changed, lowercased. `['*']` = the whole
   *  workout (a session that was just started). Empty when nothing specific. */
  exercises: string[]
}

/** What `registerTools` reported for the currently mounted page. */
export interface AgentRegistration {
  /** False until the first registration attempt has resolved. */
  checked: boolean
  /** Whether this browser exposes a model context at all. */
  supported: boolean
  /** Tool names successfully registered for the mounted page. */
  registered: string[]
}

/** Every exercise in the workout changed (used when a session is started). */
export const ALL_EXERCISES = '*'

/** How long a changed row stays highlighted. */
export const AGENT_PULSE_MS = 1500

const MAX_EVENTS = 20

/** Names are matched case-insensitively; the store keeps the folded form. */
function fold(name: string): string {
  return name.trim().toLowerCase()
}

interface AgentEventState {
  events: AgentEvent[]
  /** Folded exercise name → epoch ms of the agent's last change to it. */
  touched: Record<string, number>
  registration: AgentRegistration
  push: (event: Omit<AgentEvent, 'at' | 'exercises'> & { at?: number; exercises?: string[] }) => void
  setRegistration: (registration: AgentRegistration) => void
  clear: () => void
}

const EMPTY_REGISTRATION: AgentRegistration = { checked: false, supported: false, registered: [] }

export const useAgentEventStore = create<AgentEventState>((set) => ({
  events: [],
  touched: {},
  registration: EMPTY_REGISTRATION,
  push: (event) =>
    set((state) => {
      const at = event.at ?? Date.now()
      const exercises = (event.exercises ?? []).map(fold).filter(Boolean)
      const touched = exercises.length > 0 ? { ...state.touched } : state.touched
      for (const name of exercises) touched[name] = at
      return {
        events: [{ at, tool: event.tool, summary: event.summary, exercises }, ...state.events].slice(
          0,
          MAX_EVENTS,
        ),
        touched,
      }
    }),
  setRegistration: (registration) => set({ registration }),
  clear: () => set({ events: [], touched: {}, registration: EMPTY_REGISTRATION }),
}))

/** Record an agent action. Callable from outside React (tool `execute` bodies). */
export function recordAgentEvent(tool: string, summary: string, exercises?: string[]): void {
  useAgentEventStore.getState().push({ tool, summary, exercises })
}

/** Read the feed outside React (tests, debugging). */
export function agentEvents(): AgentEvent[] {
  return useAgentEventStore.getState().events
}

/**
 * When the agent last changed `name`, or null. `ALL_EXERCISES` wins when it is
 * more recent — starting a session replaces every row at once.
 */
export function agentTouchedAt(
  touched: Record<string, number>,
  name: string,
): number | null {
  const own = touched[fold(name)]
  const all = touched[ALL_EXERCISES]
  const at = Math.max(own ?? 0, all ?? 0)
  return at > 0 ? at : null
}

/** True while `name` is inside the pulse window. Pure over the store + a clock. */
export function agentTouchedRecently(
  name: string,
  now: number = Date.now(),
  windowMs: number = AGENT_PULSE_MS,
): boolean {
  const at = agentTouchedAt(useAgentEventStore.getState().touched, name)
  return at != null && now - at < windowMs
}
