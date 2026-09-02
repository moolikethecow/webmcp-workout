/**
 * @vitest-environment jsdom
 *
 * registerTools — the two states a browser can be in, and the guarantee that one
 * bad tool cannot take the rest down.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getModelContext, registerTools } from '../register'
import type { WebMcpTool } from '../types'

function tool(name: string): WebMcpTool {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async execute() {
      return { content: [{ type: 'text', text: '{}' }] }
    },
  }
}

function withModelContext(registerTool: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(document, 'modelContext', {
    value: { registerTool },
    configurable: true,
    writable: true,
  })
}

function withoutModelContext(): void {
  Object.defineProperty(document, 'modelContext', { value: undefined, configurable: true, writable: true })
  Object.defineProperty(navigator, 'modelContext', { value: undefined, configurable: true, writable: true })
}

beforeEach(() => {
  withoutModelContext()
  vi.restoreAllMocks()
})

describe('registerTools', () => {
  it('registers every tool when the API is present, passing the abort signal', async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    withModelContext(registerTool)
    const controller = new AbortController()

    const result = await registerTools([tool('a'), tool('b'), tool('c')], controller.signal)

    expect(result.supported).toBe(true)
    expect(result.registered).toEqual(['a', 'b', 'c'])
    expect(result.failed).toEqual([])
    expect(registerTool).toHaveBeenCalledTimes(3)
    expect(registerTool.mock.calls[0]![1]).toEqual({ signal: controller.signal })
  })

  it('no-ops when the browser has no WebMCP support', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const result = await registerTools([tool('a')], new AbortController().signal)

    expect(result).toEqual({ registered: [], failed: [], supported: false })
    // The absence notice is informational and printed at most once per session.
    expect(info.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('keeps registering after one tool throws', async () => {
    const registerTool = vi.fn(async (candidate: WebMcpTool) => {
      if (candidate.name === 'bad') throw new Error('invalid schema')
    })
    withModelContext(registerTool as unknown as ReturnType<typeof vi.fn>)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await registerTools([tool('a'), tool('bad'), tool('c')], new AbortController().signal)

    expect(result.registered).toEqual(['a', 'c'])
    expect(result.failed).toEqual([{ name: 'bad', error: 'invalid schema' }])
  })

  it('stops early when the signal is already aborted', async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    withModelContext(registerTool)
    const controller = new AbortController()
    controller.abort()

    const result = await registerTools([tool('a')], controller.signal)
    expect(result.registered).toEqual([])
    expect(registerTool).not.toHaveBeenCalled()
  })
})

describe('getModelContext', () => {
  it('prefers document.modelContext over the deprecated navigator surface', () => {
    const fromDocument = { registerTool: vi.fn() }
    const fromNavigator = { registerTool: vi.fn() }
    withModelContext(fromDocument.registerTool)
    Object.defineProperty(navigator, 'modelContext', { value: fromNavigator, configurable: true })
    expect(getModelContext()).not.toBe(fromNavigator)
  })

  it('falls back to navigator.modelContext', () => {
    const fromNavigator = { registerTool: vi.fn() }
    Object.defineProperty(navigator, 'modelContext', { value: fromNavigator, configurable: true })
    expect(getModelContext()).toBe(fromNavigator)
  })
})
