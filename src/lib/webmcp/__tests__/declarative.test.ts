import { describe, expect, it, vi } from 'vitest'

import { handleAgentSubmit, isAgentInvoked } from '../declarative'

/**
 * The declarative contract has one asymmetry worth pinning down: `respondWith`
 * exists only for an agent-invoked submit, and calling `preventDefault` without
 * it on such a submit is the one thing Chrome treats as a programming error.
 * Everything here is about not getting that backwards in either direction.
 */

/** A submit event as the two callers produce it. A browser without WebMCP has
 *  neither member — that is the third case, not a variant of the second. */
function submitEvent(
  extras: { agentInvoked?: boolean; respondWith?: (result: string | Promise<string>) => void } = {},
): SubmitEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    preventDefault: vi.fn(),
    ...extras,
  } as unknown as SubmitEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

describe('isAgentInvoked', () => {
  it('is false when the browser has no WebMCP at all', () => {
    expect(isAgentInvoked(submitEvent())).toBe(false)
  })

  it('is false for a person pressing the button in a WebMCP browser', () => {
    expect(isAgentInvoked(submitEvent({ agentInvoked: false, respondWith: vi.fn() }))).toBe(false)
  })

  it('is true only for a submit Chrome raised for a tool call', () => {
    expect(isAgentInvoked(submitEvent({ agentInvoked: true, respondWith: vi.fn() }))).toBe(true)
  })
})

describe('handleAgentSubmit', () => {
  it('hands the agent the sentence the work resolved to', async () => {
    const respondWith = vi.fn()
    const event = submitEvent({ agentInvoked: true, respondWith })

    handleAgentSubmit(event, async () => 'Recorded: left shoulder — limiting.')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(respondWith).toHaveBeenCalledTimes(1)
    await expect(respondWith.mock.calls[0]![0]).resolves.toBe('Recorded: left shoulder — limiting.')
  })

  it('turns a rejection into an Error line rather than a rejected tool call', async () => {
    const respondWith = vi.fn()

    handleAgentSubmit(submitEvent({ agentInvoked: true, respondWith }), async () => {
      throw new Error('region must be a canonical injury site')
    })

    await expect(respondWith.mock.calls[0]![0]).resolves.toBe(
      'Error: region must be a canonical injury site',
    )
  })

  it('survives work that throws before it ever returns a promise', async () => {
    const respondWith = vi.fn()

    expect(() =>
      handleAgentSubmit(submitEvent({ agentInvoked: true, respondWith }), () => {
        throw new Error('form was not mounted')
      }),
    ).not.toThrow()

    await expect(respondWith.mock.calls[0]![0]).resolves.toBe('Error: form was not mounted')
  })

  it('responds synchronously, before the work has settled', () => {
    const respondWith = vi.fn()
    let finish: (value: string) => void = () => {}

    handleAgentSubmit(
      submitEvent({ agentInvoked: true, respondWith }),
      () => new Promise<string>((resolve) => { finish = resolve }),
    )

    // respondWith must be called in the same task as the submit handler, not
    // after an await — the API drops a late response on the floor.
    expect(respondWith).toHaveBeenCalledTimes(1)
    finish('done')
  })

  it('still does the work when a person presses the button', async () => {
    const respondWith = vi.fn()
    const run = vi.fn(async () => 'saved')

    handleAgentSubmit(submitEvent({ agentInvoked: false, respondWith }), run)

    expect(run).toHaveBeenCalledTimes(1)
    expect(respondWith).not.toHaveBeenCalled()
  })

  it('does not blow up on a human submit whose work fails', async () => {
    const rejection = Promise.reject(new Error('offline'))
    handleAgentSubmit(submitEvent(), () => rejection)
    await expect(rejection.catch((e) => e.message)).resolves.toBe('offline')
  })

  it('never calls respondWith in a browser that does not have it', () => {
    const event = submitEvent({ agentInvoked: true })
    expect(() => handleAgentSubmit(event, async () => 'x')).not.toThrow()
    expect(event.preventDefault).toHaveBeenCalled()
  })
})
