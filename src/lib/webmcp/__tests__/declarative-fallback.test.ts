/**
 * @vitest-environment jsdom
 *
 * The declarative fallback: `report_training_constraint` is a `<form>` in
 * Chrome and a registered tool everywhere else, and never both on one page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerDeclarativeFallbacks } from '../register'
import { CONFIRMATION_WINDOW_MS, FORM_SELECTOR, reportTrainingConstraint } from '../tools/report-training-constraint'
import { DECLARATIVE_FALLBACKS, declarativeFallbacksForPage, toolsForPage } from '../tools'
import { settleStagedForm } from '../staged-form'
import type { WebMcpTool } from '../types'

function tool(name: string): WebMcpTool {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { content: [{ type: 'text', text: '{}' }] }
    },
  }
}

function withModelContext(value: unknown): void {
  Object.defineProperty(document, 'modelContext', { value, configurable: true, writable: true })
}

beforeEach(() => {
  vi.useFakeTimers()
  withModelContext(undefined)
  Object.defineProperty(navigator, 'modelContext', { value: undefined, configurable: true, writable: true })
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('registerDeclarativeFallbacks', () => {
  it('registers the stand-in when the browser has no getTools (ChatGPT’s shape)', async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    withModelContext({ registerTool })

    const result = await registerDeclarativeFallbacks([tool('report_training_constraint')], new AbortController().signal)

    expect(result.registered).toEqual(['report_training_constraint'])
    expect(registerTool).toHaveBeenCalledTimes(1)
  })

  it('does nothing when getTools already lists the form-derived tool (Chrome)', async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    const getTools = vi.fn().mockResolvedValue([{ name: 'get_training_context' }, { name: 'report_training_constraint' }])
    withModelContext({ registerTool, getTools })

    const pending = registerDeclarativeFallbacks([tool('report_training_constraint')], new AbortController().signal)
    await vi.runAllTimersAsync()
    const result = await pending

    expect(result).toEqual({ registered: [], failed: [], supported: true })
    expect(registerTool).not.toHaveBeenCalled()
  })

  it('registers when getTools exists but never published the form', async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    const getTools = vi.fn().mockResolvedValue([{ name: 'get_training_context' }])
    withModelContext({ registerTool, getTools })

    const pending = registerDeclarativeFallbacks([tool('report_training_constraint')], new AbortController().signal)
    await vi.runAllTimersAsync()
    expect((await pending).registered).toEqual(['report_training_constraint'])
  })

  it('survives a duplicate-name rejection as a per-tool failure', async () => {
    const registerTool = vi.fn().mockRejectedValue(new Error('already registered'))
    withModelContext({ registerTool })

    const result = await registerDeclarativeFallbacks([tool('report_training_constraint')], new AbortController().signal)
    expect(result.registered).toEqual([])
    expect(result.failed).toEqual([{ name: 'report_training_constraint', error: 'already registered' }])
  })

  it('is unsupported without any model context', async () => {
    const result = await registerDeclarativeFallbacks([tool('x')], new AbortController().signal)
    expect(result.supported).toBe(false)
  })
})

describe('the fallback tool set', () => {
  it('is only the constraint form, offered only where the form is', () => {
    expect(DECLARATIVE_FALLBACKS.map((t) => t.name)).toEqual(['report_training_constraint'])
    expect(declarativeFallbacksForPage('dashboard')).toEqual(DECLARATIVE_FALLBACKS)
    expect(declarativeFallbacksForPage('gym')).toEqual([])
    expect(declarativeFallbacksForPage('history')).toEqual([])
    // Never in a page set: it must not be registered where the form is native.
    for (const page of ['gym', 'dashboard', 'history'] as const) {
      expect(toolsForPage(page).map((t) => t.name)).not.toContain('report_training_constraint')
    }
  })
})

describe('report_training_constraint (code-defined)', () => {
  function mountForm(): HTMLFormElement {
    document.body.innerHTML = `
      <form toolname="report_training_constraint">
        <select name="region"><option value="">—</option><option value="shoulder_joint">Shoulder joint</option><option value="knees">Knees</option></select>
        <select name="severity"><option value="">—</option><option value="nagging">n</option><option value="limiting">l</option><option value="out">o</option></select>
        <input name="label" type="text" /><input name="note" type="text" />
      </form>`
    return document.querySelector<HTMLFormElement>(FORM_SELECTOR)!
  }

  it('tells the agent where the form is when it is not on this page', async () => {
    const result = await reportTrainingConstraint.execute({ region: 'knees', severity: 'limiting' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/dashboard at \//)
    expect(result.content[0]!.text).toMatch(/set_training_constraint/)
  })

  it('fills the form with canonicalised values and returns the person’s confirmation', async () => {
    const form = mountForm()
    const call = reportTrainingConstraint.execute({ region: 'shoulder', severity: 'limiting', label: 'left shoulder' })
    await Promise.resolve()

    expect((form.elements.namedItem('region') as HTMLSelectElement).value).toBe('shoulder_joint')
    expect((form.elements.namedItem('severity') as HTMLSelectElement).value).toBe('limiting')
    expect((form.elements.namedItem('label') as HTMLInputElement).value).toBe('left shoulder')
    expect(form.hasAttribute('data-agent-staged')).toBe(true)

    settleStagedForm(form, Promise.resolve('Recorded: left shoulder — limiting. Movements that load Shoulder joint are now excluded.'))
    const result = await call
    const payload = JSON.parse(result.content[0]!.text) as { status: string; result: string; staged: { region: string } }
    expect(payload.status).toBe('recorded')
    expect(payload.staged.region).toBe('shoulder_joint')
    expect(payload.result).toMatch(/now excluded/)
  })

  it('returns awaiting_confirmation when nobody presses Add within the window', async () => {
    mountForm()
    const call = reportTrainingConstraint.execute({ region: 'knees', severity: 'out' })
    await vi.advanceTimersByTimeAsync(CONFIRMATION_WINDOW_MS)
    const payload = JSON.parse((await call).content[0]!.text) as { status: string; message: string }
    expect(payload.status).toBe('awaiting_confirmation')
    expect(payload.message).toMatch(/Nothing is recorded yet/)
    expect(payload.message).toMatch(/Knees · out/)
  })

  it('refuses a region that is not a canonical site', async () => {
    mountForm()
    const result = await reportTrainingConstraint.execute({ region: 'soul', severity: 'out' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/region must be one of/)
  })

  it('surfaces the handler’s error as a tool error', async () => {
    const form = mountForm()
    const call = reportTrainingConstraint.execute({ region: 'knees', severity: 'out' })
    await Promise.resolve()
    settleStagedForm(form, Promise.resolve('Error: region must be a canonical injury site'))
    const result = await call
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe('Error: region must be a canonical injury site')
  })
})
