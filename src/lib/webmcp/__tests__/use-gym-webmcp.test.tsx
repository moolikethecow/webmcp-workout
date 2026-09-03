/**
 * @vitest-environment jsdom
 *
 * The hook publishes one truth about what is live on the page, and the three
 * browsers it can meet produce three different answers for the form tool.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentEventStore } from '../agent-events'
import { useGymWebMCP } from '../use-gym-webmcp'

function withModelContext(value: unknown): void {
  Object.defineProperty(document, 'modelContext', { value, configurable: true, writable: true })
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useAgentEventStore.getState().clear()
})
afterEach(() => {
  withModelContext(undefined)
  vi.restoreAllMocks()
})

describe('useGymWebMCP on the dashboard', () => {
  it('Chrome: the form is published natively, counted as live, not a fallback', async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    const getTools = vi.fn().mockResolvedValue([{ name: 'report_training_constraint' }])
    withModelContext({ registerTool, getTools })

    const { result } = renderHook(() => useGymWebMCP('dashboard'))
    await waitFor(() => expect(result.current.registered).toContain('report_training_constraint'))

    expect(result.current.fallbacks).toEqual([])
    expect(result.current.registered).toHaveLength(14)
    expect(registerTool.mock.calls.map((c) => (c[0] as { name: string }).name)).not.toContain(
      'report_training_constraint',
    )
    // The store the top bar reads agrees with the hook.
    expect(useAgentEventStore.getState().registration.registered).toHaveLength(14)
  })

  it('ChatGPT: no getTools, so the stand-in is registered and reported as a fallback', async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    withModelContext({ registerTool })

    const { result } = renderHook(() => useGymWebMCP('dashboard'))
    await waitFor(() => expect(result.current.fallbacks).toEqual(['report_training_constraint']))

    expect(result.current.registered).toHaveLength(14)
    expect(registerTool.mock.calls.map((c) => (c[0] as { name: string }).name)).toContain(
      'report_training_constraint',
    )
  })

  it('no WebMCP: unsupported, nothing registered, no fallback attempted', async () => {
    const { result } = renderHook(() => useGymWebMCP('dashboard'))
    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current).toEqual({ checked: true, supported: false, registered: [], fallbacks: [] })
  })

  it('the gym page never asks for the form stand-in', async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    withModelContext({ registerTool })

    const { result } = renderHook(() => useGymWebMCP('gym'))
    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.registered).toHaveLength(15)
    expect(result.current.registered).not.toContain('report_training_constraint')
  })

  it('unmount aborts the registration signal and clears the published state', async () => {
    const signals: AbortSignal[] = []
    const registerTool = vi.fn(async (_tool: unknown, options: { signal: AbortSignal }) => {
      signals.push(options.signal)
    })
    withModelContext({ registerTool })
    const { result, unmount } = renderHook(() => useGymWebMCP('history'))
    await waitFor(() => expect(result.current.checked).toBe(true))

    unmount()
    expect(signals[0]!.aborted).toBe(true)
    expect(useAgentEventStore.getState().registration.checked).toBe(false)
  })
})
