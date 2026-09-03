'use client'

/**
 * AgentPanel — section 05 of the dashboard: is an agent connected, how to
 * connect one, what it can call, and what to say to it.
 *
 * This is the page's answer to the question a judge asks first — "is WebMCP
 * actually doing anything here?" — and to the one a person asks when it is
 * not: "why not, and what do I open instead?" Both answers have to be exact.
 * The failure this exists to prevent: someone opens the app in a chat client
 * that has no bridge to the page, the page says "tools ready", the agent says
 * it cannot attach, and nobody can tell whose fault it is.
 *
 * Everything shown is derived from the registration that actually happened
 * (`useGymWebMCP`) and the tool list the page registers (`toolsForPage`), so
 * the panel cannot describe a surface the browser does not have.
 */
import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'

import { HCard, MonoLabel } from '@/components/health/primitives'
import type { GymWebMcpStatus } from '@/lib/webmcp'
import { DECLARATIVE_FALLBACKS, toolsForPage, type GymPage } from '@/lib/webmcp'
import { DEMO_PROMPT_GUIDE } from '@/lib/webmcp/demo-prompts'

/** The name of the dashboard's form tool. It is a `<form>`, not a registered
 *  tool, so it is added to the roster by hand. */
const FORM_TOOL = 'report_training_constraint'

export interface ConnectStep {
  client: string
  steps: string
}

/** Exact, because a near-miss here costs a judge their whole session. */
export const CONNECT_STEPS: ConnectStep[] = [
  {
    client: 'ChatGPT',
    steps:
      'Desktop app (latest), in Work or Codex. Open this page in the built-in browser and ask in the chat beside it. ' +
      'Use GPT-5.6 Sol or Terra — Luna has site tools switched off. ChatGPT on the web, and Enterprise or Edu workspaces, cannot see site tools.',
  },
  {
    client: 'Chrome',
    steps:
      'Chrome 149 or newer: just open this page. The origin carries a WebMCP origin-trial token, so no flag is needed. ' +
      'For the DevTools panel that lists and invokes tools, enable chrome://flags/#devtools-webmcp-support.',
  },
  {
    client: 'Anything else',
    steps:
      'Add ?webmcp=shim to the URL for a console harness: window.__webmcp.tools() lists the registered tools and ' +
      'window.__webmcp.call(name, args) runs one exactly as an agent would.',
  },
]

export const ATTACH_HINT =
  'If an agent says it cannot attach to this tab while this panel reads agent-ready, the chat is not a Work or Codex ' +
  'session on Sol or Terra — the page is fine; switch the chat.'

export default function AgentPanel({ status, page = 'dashboard' }: { status: GymWebMcpStatus; page?: GymPage }) {
  const [showTools, setShowTools] = useState(false)
  const [showConnect, setShowConnect] = useState(false)

  const roster = buildRoster(page, status)
  const live = status.checked && status.supported
  const count = live ? status.registered.length + (status.fallbacks.includes(FORM_TOOL) ? 0 : 1) : roster.length

  return (
    <HCard pad={16}>
      {/* ── status ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span
          aria-hidden
          style={{
            ...dot,
            marginTop: 5,
            background: !status.checked ? 'var(--border)' : status.supported ? 'var(--success)' : 'var(--warning)',
            boxShadow: live ? '0 0 0 3px oklch(0.72 0.14 165 / 0.25)' : 'none',
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={statusLine} role="status">
            {!status.checked
              ? 'Checking this browser for WebMCP…'
              : status.supported
                ? `Agent-ready — ${count} tools live on this page.`
                : 'No WebMCP in this browser.'}
          </p>
          <p style={note}>
            {!status.checked
              ? ''
              : status.supported
                ? 'Any agent driving this browser can call them. Every change it makes is narrated in the strip at the top.'
                : 'The app works normally, but an agent cannot see its tools from here. Open it where one can:'}
          </p>
          {live && status.fallbacks.includes(FORM_TOOL) ? (
            <p style={{ ...note, marginTop: 6 }}>
              This browser has no declarative form API, so <code style={code}>{FORM_TOOL}</code> is registered in
              code instead. It still only fills the form — you press Add.
            </p>
          ) : null}
        </div>
      </div>

      {/* ── connect ── */}
      {status.checked && !status.supported ? (
        <ConnectList />
      ) : (
        <Disclosure open={showConnect} onToggle={() => setShowConnect((v) => !v)} label="How to connect an agent">
          <ConnectList />
        </Disclosure>
      )}

      {/* ── prompts ── */}
      <div style={{ marginTop: 14 }}>
        <MonoLabel>Say this</MonoLabel>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 4 }}>
          {DEMO_PROMPT_GUIDE.map((prompt, index) => (
            <PromptRow key={prompt.text} prompt={prompt} first={index === 0} />
          ))}
        </div>
      </div>

      {/* ── roster ── */}
      <Disclosure
        open={showTools}
        onToggle={() => setShowTools((v) => !v)}
        label={`${live ? 'The' : 'What an agent would get:'} ${roster.length} tools on this page`}
      >
        <ul style={list} aria-label="Registered tools">
          {roster.map((tool) => (
            <li key={tool.name} style={toolRow}>
              <code style={{ ...code, minWidth: 0 }}>{tool.name}</code>
              <span style={{ ...badge, ...(BADGE[tool.kind] ?? {}) }}>{tool.kind}</span>
              <span style={toolBlurb}>{tool.blurb}</span>
            </li>
          ))}
        </ul>
      </Disclosure>
    </HCard>
  )
}

// ── pieces ──────────────────────────────────────────────────────────────────

function ConnectList() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
      {CONNECT_STEPS.map((entry, index) => (
        <div key={entry.client} style={{ ...connectRow, borderTop: index === 0 ? 'none' : connectRow.borderTop }}>
          <span style={connectClient}>{entry.client}</span>
          <span style={connectSteps}>{entry.steps}</span>
        </div>
      ))}
      <p style={{ ...note, marginTop: 8 }}>{ATTACH_HINT}</p>
    </div>
  )
}

function Disclosure({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean
  onToggle: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <button type="button" onClick={onToggle} aria-expanded={open} style={disclosure}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
      </button>
      {open ? children : null}
    </div>
  )
}

function PromptRow({ prompt, first }: { prompt: (typeof DEMO_PROMPT_GUIDE)[number]; first: boolean }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div style={{ ...promptRow, borderTop: first ? 'none' : promptRow.borderTop }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={promptText}>“{prompt.text}”</p>
        <p style={promptMeta}>
          <span style={{ color: 'var(--accent)' }}>on {prompt.where}</span> · {prompt.shows}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          void copyText(prompt.text).then((ok) => setCopied(ok))
        }}
        aria-label={copied ? 'Copied' : `Copy prompt: ${prompt.text}`}
        title="Copy"
        style={copyButton}
      >
        {copied ? <Check size={13} color="var(--success)" /> : <Copy size={13} />}
      </button>
    </div>
  )
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

// ── roster ──────────────────────────────────────────────────────────────────

export type ToolKind = 'read' | 'write' | 'form'

export interface RosterEntry {
  name: string
  kind: ToolKind
  blurb: string
}

/** First sentence of a description, without the "Start here." throat-clearing. */
export function blurbOf(description: string): string {
  const cleaned = description.replace(/^Start here\.\s*/, '')
  const match = /^(.+?[.!?])(\s|$)/.exec(cleaned)
  return (match ? match[1]! : cleaned).trim()
}

/**
 * The tools this page offers, as the panel lists them. The form tool is
 * appended by hand because no code registers it; when the browser registered
 * the code-defined stand-in instead, it is listed once under the same name.
 */
export function buildRoster(page: GymPage, status: GymWebMcpStatus): RosterEntry[] {
  const entries: RosterEntry[] = toolsForPage(page).map((tool) => ({
    name: tool.name,
    kind: tool.annotations?.readOnlyHint === true ? 'read' : 'write',
    blurb: blurbOf(tool.description),
  }))
  if (page === 'dashboard') {
    const fallback = DECLARATIVE_FALLBACKS.find((tool) => tool.name === FORM_TOOL)
    entries.push({
      name: FORM_TOOL,
      kind: 'form',
      blurb: status.fallbacks.includes(FORM_TOOL)
        ? 'Fills the constraint form on this page and waits for you to press Add.'
        : fallback
          ? 'A form, not code: the agent fills the fields, and the call completes when you press Add.'
          : 'A form, not code.',
    })
  }
  return entries
}

// ── styles ──────────────────────────────────────────────────────────────────
const dot: React.CSSProperties = { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 }
const statusLine: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 16.5,
  lineHeight: 1.3,
  color: 'var(--fg)',
  margin: 0,
}
const note: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  color: 'var(--fg-subtle)',
  margin: '4px 0 0',
}
const code: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg)',
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 5,
  padding: '1px 5px',
  whiteSpace: 'nowrap',
}
const connectRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '92px minmax(0, 1fr)',
  gap: 10,
  padding: '8px 0',
  borderTop: '1px solid var(--border-muted)',
}
const connectClient: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--fg)',
  paddingTop: 2,
}
const connectSteps: React.CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--fg-muted)' }
const disclosure: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
}
const promptRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '9px 0',
  borderTop: '1px solid var(--border-muted)',
}
const promptText: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13.5,
  lineHeight: 1.5,
  color: 'var(--fg-muted)',
  margin: 0,
}
const promptMeta: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  lineHeight: 1.5,
  color: 'var(--fg-subtle)',
  margin: '3px 0 0',
}
const copyButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  borderRadius: 7,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  flexShrink: 0,
}
const list: React.CSSProperties = { listStyle: 'none', margin: '6px 0 0', padding: 0 }
const toolRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto auto minmax(0, 1fr)',
  alignItems: 'baseline',
  gap: 8,
  padding: '6px 0',
  borderTop: '1px solid var(--border-muted)',
}
const toolBlurb: React.CSSProperties = { fontSize: 11.5, lineHeight: 1.45, color: 'var(--fg-subtle)' }
const badge: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  padding: '1px 5px',
  borderRadius: 4,
  border: '1px solid var(--border-muted)',
  color: 'var(--fg-subtle)',
}
const BADGE: Record<ToolKind, React.CSSProperties> = {
  read: { color: 'var(--info)', borderColor: 'oklch(0.70 0.13 230 / 0.35)' },
  write: { color: 'var(--warning)', borderColor: 'oklch(0.78 0.14 75 / 0.35)' },
  form: { color: 'var(--accent)', borderColor: 'var(--accent-muted)' },
}
