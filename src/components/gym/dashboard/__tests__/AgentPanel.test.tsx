import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import AgentPanel, { ATTACH_HINT, blurbOf, buildRoster } from '../AgentPanel'
import { DEMO_PROMPTS, MORE_PROMPTS } from '@/lib/webmcp/demo-prompts'
import type { GymWebMcpStatus } from '@/lib/webmcp'

const none: GymWebMcpStatus = { checked: true, supported: false, registered: [], fallbacks: [] }
const chrome: GymWebMcpStatus = {
  checked: true,
  supported: true,
  registered: ['get_training_context', 'draft_workout'],
  fallbacks: [],
}
const chatgpt: GymWebMcpStatus = {
  checked: true,
  supported: true,
  registered: ['get_training_context', 'draft_workout', 'report_training_constraint'],
  fallbacks: ['report_training_constraint'],
}

describe('AgentPanel', () => {
  it('without WebMCP: says so, and lists the exact clients that have it', () => {
    render(<AgentPanel status={none} />)
    expect(screen.getByRole('status')).toHaveTextContent('No WebMCP in this browser.')
    expect(screen.getAllByText(/Work or Codex/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Sol or Terra/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Luna has site tools switched off/)).toBeInTheDocument()
    expect(screen.getByText(/Chrome 149 or newer/)).toBeInTheDocument()
    expect(screen.getByText(ATTACH_HINT)).toBeInTheDocument()
  })

  it('with WebMCP: counts the tools and folds the connect steps away', async () => {
    render(<AgentPanel status={chrome} />)
    expect(screen.getByRole('status')).toHaveTextContent('Agent-ready — 3 tools live on this page.')
    expect(screen.queryByText(ATTACH_HINT)).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /how to connect an agent/i }))
    expect(screen.getByText(ATTACH_HINT)).toBeInTheDocument()
  })

  it('names the form stand-in when the browser needed one', () => {
    render(<AgentPanel status={chatgpt} />)
    expect(screen.getByRole('status')).toHaveTextContent('Agent-ready — 3 tools live on this page.')
    expect(screen.getByText(/registered in\s+code instead/)).toBeInTheDocument()
  })

  it('shows every demo prompt verbatim with a copy button', () => {
    render(<AgentPanel status={none} />)
    for (const prompt of [...DEMO_PROMPTS, ...MORE_PROMPTS]) {
      expect(screen.getByText(`“${prompt}”`)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: `Copy prompt: ${prompt}` })).toBeInTheDocument()
    }
  })

  it('copies a prompt to the clipboard', async () => {
    // user-event installs its own clipboard; read it back rather than spying.
    const user = userEvent.setup()
    render(<AgentPanel status={none} />)
    await user.click(screen.getByRole('button', { name: `Copy prompt: ${DEMO_PROMPTS[1]}` }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    await expect(navigator.clipboard.readText()).resolves.toBe(DEMO_PROMPTS[1])
  })

  it('lists the roster on demand, form tool included exactly once', async () => {
    render(<AgentPanel status={chatgpt} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /tools on this page/i }))
    const items = screen.getAllByRole('listitem')
    const names = items.map((item) => item.querySelector('code')!.textContent)
    expect(names.filter((n) => n === 'report_training_constraint')).toHaveLength(1)
    expect(names).toContain('get_training_context')
    expect(names).toContain('draft_workout')
    expect(names).not.toContain('edit_active_workout')
  })
})

describe('buildRoster / blurbOf', () => {
  it('derives kind from readOnlyHint and appends the form on the dashboard only', () => {
    const dashboard = buildRoster('dashboard', none)
    expect(dashboard.find((t) => t.name === 'get_training_context')?.kind).toBe('read')
    expect(dashboard.find((t) => t.name === 'draft_workout')?.kind).toBe('write')
    expect(dashboard.find((t) => t.name === 'report_training_constraint')?.kind).toBe('form')
    expect(buildRoster('gym', none).some((t) => t.name === 'report_training_constraint')).toBe(false)
  })

  it('takes the first sentence and drops the "Start here." preamble', () => {
    expect(blurbOf('Start here. Returns what this app can do, and more. Second sentence.')).toBe(
      'Returns what this app can do, and more.',
    )
    expect(blurbOf('No punctuation at all')).toBe('No punctuation at all')
  })
})
