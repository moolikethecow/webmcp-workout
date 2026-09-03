/**
 * @vitest-environment jsdom
 *
 * staged-form — a registered tool that ends in a person pressing a button.
 * The contract: fill on screen, wait for the form's own submit, hand back the
 * handler's sentence; and if nobody presses in time, say so without losing
 * what is on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  STAGED_ATTRIBUTE,
  STAGED_EVENT,
  clearStagedForm,
  fillForm,
  isStaged,
  settleStagedForm,
  stageForm,
} from '../staged-form'

function form(): HTMLFormElement {
  document.body.innerHTML = `
    <form>
      <select name="region"><option value="">—</option><option value="knees">Knees</option></select>
      <select name="severity"><option value="">—</option><option value="limiting">Limiting</option></select>
      <input name="label" type="text" />
      <input name="agree" type="checkbox" />
      <button type="submit">Add</button>
    </form>`
  return document.querySelector('form')!
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('fillForm', () => {
  it('sets named controls and reports which ones it filled', () => {
    const el = form()
    const changed: string[] = []
    el.addEventListener('change', (event) => changed.push((event.target as HTMLInputElement).name))

    const filled = fillForm(el, { region: 'knees', severity: 'limiting', label: 'left knee', agree: 'true', nope: 'x' })

    expect(filled).toEqual(['region', 'severity', 'label', 'agree'])
    expect((el.elements.namedItem('region') as HTMLSelectElement).value).toBe('knees')
    expect((el.elements.namedItem('label') as HTMLInputElement).value).toBe('left knee')
    expect((el.elements.namedItem('agree') as HTMLInputElement).checked).toBe(true)
    expect(changed).toEqual(['region', 'severity', 'label', 'agree'])
  })

  it('leaves a select alone when the value is not one of its options', () => {
    const el = form()
    expect(fillForm(el, { region: 'elbow_of_doom' })).toEqual([])
    expect((el.elements.namedItem('region') as HTMLSelectElement).value).toBe('')
  })
})

describe('stageForm → settleStagedForm', () => {
  it('marks the form, then resolves with the submit handler’s sentence', async () => {
    const el = form()
    const events: boolean[] = []
    el.addEventListener(STAGED_EVENT, (event) => events.push((event as CustomEvent<{ staged: boolean }>).detail.staged))

    const outcome = stageForm(el, { region: 'knees', severity: 'limiting' })
    expect(isStaged(el)).toBe(true)
    expect(el.getAttribute(STAGED_ATTRIBUTE)).toBe('true')

    // A person presses Add: the handler settles the stage with its own text.
    expect(settleStagedForm(el, Promise.resolve('Recorded: Knees — limiting.'))).toBe(true)
    await expect(outcome).resolves.toEqual({ status: 'submitted', result: 'Recorded: Knees — limiting.' })
    expect(isStaged(el)).toBe(false)
    expect(events).toEqual([true, false])
  })

  it('turns a rejected handler into an Error line, never a rejection', async () => {
    const el = form()
    const outcome = stageForm(el, { region: 'knees' })
    settleStagedForm(el, Promise.reject(new Error('region must be a canonical site')))
    await expect(outcome).resolves.toEqual({
      status: 'submitted',
      result: 'Error: region must be a canonical site',
    })
  })

  it('reports awaiting_confirmation when nobody presses in time — and stays staged', async () => {
    const el = form()
    const outcome = stageForm(el, { region: 'knees' }, { timeoutMs: 5_000 })
    vi.advanceTimersByTime(5_000)
    await expect(outcome).resolves.toEqual({ status: 'awaiting_confirmation' })
    // The values and the marker are still on screen for the eventual press.
    expect(isStaged(el)).toBe(true)
    expect((el.elements.namedItem('region') as HTMLSelectElement).value).toBe('knees')
    // …and that press still settles cleanly, with nothing left waiting.
    expect(settleStagedForm(el, Promise.resolve('Recorded.'))).toBe(true)
    expect(isStaged(el)).toBe(false)
  })

  it('a second stage supersedes the first', async () => {
    const el = form()
    const first = stageForm(el, { region: 'knees' })
    const second = stageForm(el, { label: 'left knee' })
    await expect(first).resolves.toEqual({ status: 'awaiting_confirmation' })
    settleStagedForm(el, Promise.resolve('Recorded.'))
    await expect(second).resolves.toEqual({ status: 'submitted', result: 'Recorded.' })
  })

  it('resolves awaiting_confirmation when the caller aborts', async () => {
    const el = form()
    const controller = new AbortController()
    const outcome = stageForm(el, { region: 'knees' }, { signal: controller.signal })
    controller.abort()
    await expect(outcome).resolves.toEqual({ status: 'awaiting_confirmation' })
  })

  it('settle is a no-op on a form nothing staged', () => {
    const el = form()
    expect(settleStagedForm(el, Promise.resolve('x'))).toBe(false)
  })

  it('clearStagedForm drops the stage without a submit', async () => {
    const el = form()
    const outcome = stageForm(el, { region: 'knees' })
    clearStagedForm(el)
    await expect(outcome).resolves.toEqual({ status: 'awaiting_confirmation' })
    expect(isStaged(el)).toBe(false)
  })
})
