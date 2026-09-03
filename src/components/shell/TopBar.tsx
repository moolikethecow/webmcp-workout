'use client'

/**
 * TopBar — the one navigation element the app has.
 *
 * Two destinations (Today at `/`, Gym at `/gym`) and a truthful pill about the
 * agent surface, read from the same store the dashboard's panel reads. It
 * exists because before it there was no way from the logger back to the
 * dashboard except the browser's back button — and the dashboard is where an
 * agent's work is explained.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { BRAND } from '@/lib/brand'
import { useAgentEventStore } from '@/lib/webmcp/agent-events'

const LINKS = [
  { href: '/', label: 'Today' },
  { href: '/gym', label: 'Gym' },
] as const

export default function TopBar() {
  const pathname = usePathname() ?? '/'
  const registration = useAgentEventStore((state) => state.registration)

  const pill = !registration.checked
    ? { text: 'Agent: checking…', tone: 'var(--fg-subtle)' }
    : registration.supported
      ? { text: `Agent-ready · ${registration.registered.length} tools`, tone: 'var(--success)' }
      : { text: 'Agent: not connected', tone: 'var(--fg-subtle)' }

  return (
    <header style={bar}>
      <div style={inner}>
        <Link href="/" style={wordmark} aria-label={`${BRAND.name} home`}>
          <span style={mark} aria-hidden>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="5" width="2.2" height="6" rx="0.8" fill="currentColor" />
              <rect x="12.8" y="5" width="2.2" height="6" rx="0.8" fill="currentColor" />
              <rect x="3.6" y="3.5" width="2.2" height="9" rx="0.8" fill="currentColor" />
              <rect x="10.2" y="3.5" width="2.2" height="9" rx="0.8" fill="currentColor" />
              <rect x="5.8" y="7.1" width="4.4" height="1.8" rx="0.6" fill="currentColor" />
            </svg>
          </span>
          <span style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 16, color: 'var(--fg)' }}>
            {BRAND.name}
          </span>
          <span style={tag}>WebMCP</span>
        </Link>

        <nav aria-label="Primary" style={{ display: 'flex', gap: 2 }}>
          {LINKS.map((link) => {
            const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href)
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                style={{
                  ...navLink,
                  color: active ? 'var(--fg)' : 'var(--fg-subtle)',
                  background: active ? 'var(--bg-elevated)' : 'transparent',
                  borderColor: active ? 'var(--border-muted)' : 'transparent',
                }}
              >
                {link.label}
              </Link>
            )
          })}
        </nav>

        <Link href="/#agent" style={{ ...pillStyle, color: pill.tone }} aria-label="Agent status">
          <span
            aria-hidden
            style={{ width: 6, height: 6, borderRadius: '50%', background: pill.tone, flexShrink: 0 }}
          />
          <span className="topbar-pill-text">{pill.text}</span>
        </Link>
      </div>
      <style>{`
        @media (max-width: 520px) { .topbar-pill-text { display: none; } }
      `}</style>
    </header>
  )
}

// ── styles ──────────────────────────────────────────────────────────────────
const bar: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 30,
  background: 'color-mix(in oklab, var(--bg) 82%, transparent)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  borderBottom: '1px solid var(--border-muted)',
}
const inner: React.CSSProperties = {
  maxWidth: 1040,
  margin: '0 auto',
  padding: '0 36px',
  height: 48,
  display: 'flex',
  alignItems: 'center',
  gap: 18,
}
const wordmark: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  textDecoration: 'none',
  marginRight: 6,
}
const mark: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  borderRadius: 7,
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
}
const tag: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  border: '1px solid var(--border-muted)',
  borderRadius: 4,
  padding: '1px 5px',
}
const navLink: React.CSSProperties = {
  fontSize: 12.5,
  textDecoration: 'none',
  padding: '5px 10px',
  borderRadius: 7,
  border: '1px solid transparent',
}
const pillStyle: React.CSSProperties = {
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
}
