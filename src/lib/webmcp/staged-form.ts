/**
 * staged-form.ts — a registered tool that ends in a person pressing a button.
 *
 * Chrome's declarative API gives the constraint form its defining property for
 * free: an agent fills the controls, and the call stays pending until a human
 * submits. ChatGPT's built-in browser does not implement that half of WebMCP
 * (see docs/WEBMCP.md, "ChatGPT's browser"), so there a form is invisible to
 * the agent and the human-in-the-loop story would simply not exist.
 *
 * This module is the same contract, rebuilt on top of `registerTool`:
 *
 *   1. a registered tool calls `stageForm(form, values)` — the controls are
 *      filled on screen and the form is marked as agent-staged
 *   2. a person presses the form's own submit button — nothing else can
 *   3. the submit handler calls `settleStagedForm(form, result)` and the
 *      pending promise from step 1 resolves with the handler's own sentence
 *
 * The one thing it cannot promise that Chrome can is an indefinite wait: an
 * agent host may time a tool call out. So `stageForm` takes a deadline, and
 * when it passes the call resolves with `awaiting_confirmation` — the values
 * are still on screen, still staged, and the person's eventual press still
 * records the constraint through the ordinary submit path.
 *
 * Nothing here is specific to the constraint form. Any `<form>` whose submit
 * handler calls `settleStagedForm` can be driven this way.
 */

export const STAGED_ATTRIBUTE = 'data-agent-staged'
/** Dispatched on the form when it is staged or cleared, so React can react. */
export const STAGED_EVENT = 'agent-staged'

export type StageOutcome =
  | { status: 'submitted'; result: string }
  | { status: 'awaiting_confirmation' }

interface Pending {
  resolve: (outcome: StageOutcome) => void
}

const pending = new WeakMap<HTMLFormElement, Pending>()

/**
 * Put `values` into the form's named controls, the way a person would have.
 * Returns the names that matched a control; unknown keys are ignored rather
 * than failing the call. Controls receive `input` and `change` events so
 * listeners (React included) see the new values.
 */
export function fillForm(form: HTMLFormElement, values: Record<string, string>): string[] {
  const filled: string[] = []
  for (const [name, value] of Object.entries(values)) {
    const control = form.elements.namedItem(name)
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) {
      continue
    }
    if (control instanceof HTMLSelectElement) {
      const option = [...control.options].find((candidate) => candidate.value === value)
      if (!option) continue
      control.value = value
    } else if (control.type === 'checkbox' || control.type === 'radio') {
      ;(control as HTMLInputElement).checked = value === 'true' || value === 'on'
    } else {
      control.value = value
    }
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
    filled.push(name)
  }
  return filled
}

/** True while an agent's fill is waiting for a person to submit this form. */
export function isStaged(form: HTMLFormElement): boolean {
  return form.hasAttribute(STAGED_ATTRIBUTE)
}

function mark(form: HTMLFormElement, staged: boolean): void {
  if (staged) form.setAttribute(STAGED_ATTRIBUTE, 'true')
  else form.removeAttribute(STAGED_ATTRIBUTE)
  form.dispatchEvent(new CustomEvent(STAGED_EVENT, { detail: { staged } }))
}

/**
 * Fill the form and wait for a person to submit it, up to `timeoutMs`.
 *
 * A second stage on the same form replaces the first: the earlier caller is
 * told it is still awaiting confirmation, and the newer values are what the
 * person sees. The staged marker outlives the timeout on purpose — the form
 * stays highlighted until someone submits or clears it.
 */
export function stageForm(
  form: HTMLFormElement,
  values: Record<string, string>,
  { timeoutMs = 20_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<StageOutcome> {
  fillForm(form, values)
  pending.get(form)?.resolve({ status: 'awaiting_confirmation' })
  mark(form, true)
  form.scrollIntoView?.({ behavior: 'smooth', block: 'center' })

  return new Promise<StageOutcome>((resolve) => {
    let done = false
    const finish = (outcome: StageOutcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (pending.get(form)?.resolve === finish) pending.delete(form)
      resolve(outcome)
    }
    const onAbort = () => finish({ status: 'awaiting_confirmation' })
    const timer = setTimeout(() => finish({ status: 'awaiting_confirmation' }), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(form, { resolve: finish })
  })
}

/**
 * Called from the form's own submit handler with the sentence the work
 * resolves to. Resolves the pending stage, if any, and clears the marker.
 * Returns true when a stage was waiting — the handler uses that to treat the
 * submit as agent-originated (no reset, an entry in the agent feed).
 */
export function settleStagedForm(form: HTMLFormElement, result: Promise<string>): boolean {
  const waiting = pending.get(form)
  const wasStaged = isStaged(form)
  if (wasStaged) mark(form, false)
  if (!waiting) return wasStaged
  void result.then(
    (text) => waiting.resolve({ status: 'submitted', result: text }),
    (err) =>
      waiting.resolve({
        status: 'submitted',
        result: `Error: ${err instanceof Error ? err.message : String(err)}`,
      }),
  )
  return true
}

/** Drop a stage without submitting (a person cleared the form). */
export function clearStagedForm(form: HTMLFormElement): void {
  pending.get(form)?.resolve({ status: 'awaiting_confirmation' })
  pending.delete(form)
  if (isStaged(form)) mark(form, false)
}
