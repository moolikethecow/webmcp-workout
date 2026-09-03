import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ConstraintForm from '../ConstraintForm'
import type { AgentSubmitEvent } from '@/lib/webmcp/declarative'

/**
 * The form has two callers and must be indistinguishable to the server. These
 * tests cover the human path (which is all most browsers will ever do) and the
 * agent path (where the same submit has to hand a sentence back).
 */

const originalFetch = global.fetch

function okFetch() {
  return vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ injury: { id: 'i1' } }) }) as unknown as Response)
}

beforeEach(() => {
  vi.stubGlobal('fetch', okFetch())
})
afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

/** Fire a submit carrying the two members Chrome adds for a tool call. */
async function submitAsAgent(form: HTMLFormElement): Promise<string> {
  let answer!: Promise<string>
  await act(async () => {
    answer = new Promise((resolve) => {
      const event = new Event('submit', { bubbles: true, cancelable: true }) as AgentSubmitEvent
      Object.defineProperty(event, 'agentInvoked', { value: true })
      Object.defineProperty(event, 'respondWith', {
        value: (result: string | Promise<string>) => void Promise.resolve(result).then(resolve),
      })
      form.dispatchEvent(event)
    })
    await answer
  })
  return answer
}

describe('ConstraintForm', () => {
  it('publishes itself as a tool whose description says a person must confirm', () => {
    const { container } = render(<ConstraintForm onAdded={vi.fn()} />)
    const form = container.querySelector('form')!

    expect(form.getAttribute('toolname')).toBe('report_training_constraint')
    expect(form.getAttribute('tooldescription')).toMatch(/does not save anything on its own/i)
    expect(form.getAttribute('tooldescription')).toMatch(/does not diagnose/i)
  })

  it('gives Chrome enough to derive a schema: required selects, named controls', () => {
    const { container } = render(<ConstraintForm onAdded={vi.fn()} />)

    const region = container.querySelector('select[name="region"]')!
    const severity = container.querySelector('select[name="severity"]')!
    expect(region.hasAttribute('required')).toBe(true)
    expect(severity.hasAttribute('required')).toBe(true)
    // Every control carries a title: Chrome raises a DevTools issue without one.
    for (const control of container.querySelectorAll('select, input')) {
      expect(control.getAttribute('title')).toBeTruthy()
    }
  })

  it('posts what a person filled in and refreshes the page', async () => {
    const onAdded = vi.fn()
    const { container } = render(<ConstraintForm onAdded={onAdded} />)
    const user = userEvent.setup()

    await user.selectOptions(container.querySelector('select[name="region"]')!, 'shoulder_joint')
    await user.selectOptions(container.querySelector('select[name="severity"]')!, 'limiting')
    await user.type(container.querySelector('input[name="label"]')!, 'left shoulder')
    await user.click(screen.getByRole('button', { name: /add constraint/i }))

    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('/api/gym/injuries')
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      region: 'shoulder_joint',
      severity: 'limiting',
      label: 'left shoulder',
    })
  })

  it('answers an agent-invoked submit with what the constraint now excludes', async () => {
    const { container } = render(<ConstraintForm onAdded={vi.fn()} />)
    const form = container.querySelector('form')!

    // Chrome fills the controls; the page never sees that step.
    ;(form.querySelector('select[name="region"]') as HTMLSelectElement).value = 'shoulder_joint'
    ;(form.querySelector('select[name="severity"]') as HTMLSelectElement).value = 'out'

    await expect(submitAsAgent(form)).resolves.toMatch(
      /Recorded: Shoulder joint — out\. Movements that load Shoulder joint are now excluded/,
    )
  })

  it('does not claim a nagging constraint excluded anything', async () => {
    const { container } = render(<ConstraintForm onAdded={vi.fn()} />)
    const form = container.querySelector('form')!
    ;(form.querySelector('select[name="region"]') as HTMLSelectElement).value = 'knees'
    ;(form.querySelector('select[name="severity"]') as HTMLSelectElement).value = 'nagging'

    const answer = await submitAsAgent(form)
    expect(answer).toMatch(/Nothing is excluded by this/)
    expect(answer).not.toMatch(/are now excluded/)
  })

  it('reports the server’s own refusal back to the agent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'region must be a canonical injury site' }) }) as unknown as Response),
    )
    const { container } = render(<ConstraintForm onAdded={vi.fn()} />)
    const form = container.querySelector('form')!
    ;(form.querySelector('select[name="region"]') as HTMLSelectElement).value = 'shoulder_joint'
    ;(form.querySelector('select[name="severity"]') as HTMLSelectElement).value = 'out'

    await expect(submitAsAgent(form)).resolves.toBe('Error: region must be a canonical injury site')
    expect(await screen.findByRole('alert')).toHaveTextContent('region must be a canonical injury site')
  })
})
