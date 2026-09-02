'use client'

/**
 * AgentActivity — the strip that says what the agent just did.
 *
 * An agent editing the workout in front of you is only acceptable if the app
 * narrates it. This is that narration: the last change, in the agent's own
 * words, with an expandable list of the last ten, plus an honest statement of
 * whether this browser can even register tools.
 *
 * It is silent by default. With no events and no `showStatus`, it renders
 * nothing at all — a gym screen should not carry a permanent banner about a
 * capability that has not been used.
 */
import { useEffect, useState } from 'react'

import { useAgentEventStore, type AgentEvent } from '@/lib/webmcp/agent-events'

const VISIBLE_EVENTS = 10

/** "2s ago" / "4m ago" / "3h ago" — terse, never a date. */
export function agoLabel(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

/** One terse line per event, matching the feed's own wording. */
function line(event: AgentEvent, now: number): string {
  return `Agent: ${event.summary} · ${agoLabel(event.at, now)}`
}

export default function AgentActivity({ showStatus = false }: { showStatus?: boolean }) {
  const events = useAgentEventStore((state) => state.events)
  const registration = useAgentEventStore((state) => state.registration)
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Only tick while there is something whose age is on screen.
  useEffect(() => {
    if (events.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [events.length])

  if (events.length === 0 && !showStatus) return null

  const latest = events[0]
  const status = !registration.checked
    ? 'WebMCP: checking…'
    : registration.supported
      ? `WebMCP: ${registration.registered.length} tools registered`
      : 'WebMCP: not available in this browser'

  return (
    <div
      aria-label="Agent activity"
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid var(--border-muted)',
        borderBottom: '1px solid var(--border-muted)',
        padding: '7px 0',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ ...dot, background: latest ? 'var(--accent)' : 'var(--border)' }} aria-hidden />
        <span style={{ ...text, flex: 1, minWidth: 0 }}>
          {latest ? line(latest, now) : 'No agent activity yet.'}
        </span>
        <span style={mono}>{status}</span>
        {events.length > 1 && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            style={toggle}
          >
            {expanded ? 'Hide' : `${Math.min(events.length, VISIBLE_EVENTS)} recent`}
          </button>
        )}
      </div>

      {expanded && events.length > 1 && (
        <ul style={list}>
          {events.slice(0, VISIBLE_EVENTS).map((event) => (
            <li key={`${event.at}-${event.tool}-${event.summary}`} style={item}>
              {line(event, now)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── styles ──────────────────────────────────────────────────────────────────
const dot: React.CSSProperties = { width: 5, height: 5, borderRadius: '50%', flexShrink: 0 }
const text: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const mono: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
}
const toggle: React.CSSProperties = {
  ...mono,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'var(--accent)',
}
const list: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
}
const item: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--fg-subtle)',
  padding: '5px 0 5px 15px',
  borderTop: '1px solid var(--border-muted)',
}
