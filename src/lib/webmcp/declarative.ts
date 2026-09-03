/**
 * declarative.ts — the form half of WebMCP.
 *
 * A `<form>` carrying `toolname` and `tooldescription` *is* a tool. Chrome
 * derives the input schema from the controls themselves — `required` becomes
 * JSON Schema `required`, a `<select>` becomes an enum with the option labels
 * as titles, `type="number"` a number, a checkbox a boolean — and there is no
 * `registerTool` call anywhere. The markup the person uses is the tool.
 *
 * What makes this worth having next to the imperative tools is not brevity.
 * It is *who presses the button*. Chrome fills the controls and then stops:
 * the pending call does not resolve until the form is actually submitted. So
 * an agent can put "left shoulder · limiting" into the constraint form, but
 * the person holding the barbell is the one who commits it — and there is no
 * second code path for them to disagree about, because it is one form.
 *
 * That gives the app a line it can draw honestly:
 *
 *   imperative tools   what an agent may do alone — read, search, draft, edit
 *                      the *prescription* for work not yet done
 *   declarative forms  what needs a hand on the button — asserting something
 *                      about your own body
 *
 * The contract, which Chrome states in its own error message when you get it
 * wrong ("it called preventDefault() on the 'submit' event, without also
 * calling respondWith() with the tool result"):
 *
 *   1. agent calls the tool     → Chrome fills the controls; the call pends
 *   2. a human submits the form → the page's own submit handler runs
 *   3. handler calls respondWith(Promise<string>) → the agent's call resolves
 *
 * `event.agentInvoked` separates the two ways a submit can arrive. Both do
 * exactly the same work; only the agent-invoked one has somewhere to send a
 * result. A browser without WebMCP has neither member, `agentInvoked` is
 * undefined, and the form is an ordinary form — which is the whole reason to
 * build the feature this way round.
 */

/** A `submit` event in a browser that implements the form half of WebMCP. */
export interface AgentSubmitEvent extends SubmitEvent {
  /** True when Chrome filled this form for a tool call rather than a person. */
  readonly agentInvoked?: boolean
  /** Hand the tool result back to the caller. Must be called synchronously
   *  from the submit handler, before any await. */
  readonly respondWith?: (result: string | Promise<string>) => void
}

/** Did this submit come from an agent tool call? False in any other browser. */
export function isAgentInvoked(event: SubmitEvent): boolean {
  return (event as AgentSubmitEvent).agentInvoked === true
}

/**
 * Wire one form to both callers.
 *
 * `run` does the actual work and resolves to the sentence the agent should
 * read. It is invoked synchronously so `respondWith` can be called in the same
 * task, as the API requires. It owns its own UI feedback: the returned string
 * is for the agent, and a human pressing the button sees whatever `run` puts
 * on screen.
 *
 * A rejection becomes an `Error:` line rather than a rejected tool call, for
 * the same reason the imperative tools never throw — an agent can read text
 * and retry, but gets nothing from a rejected promise.
 */
export function handleAgentSubmit(event: SubmitEvent, run: () => Promise<string>): void {
  event.preventDefault()

  let result: Promise<string>
  try {
    result = run()
  } catch (err) {
    result = Promise.reject(err)
  }

  const agentEvent = event as AgentSubmitEvent
  if (agentEvent.agentInvoked === true && typeof agentEvent.respondWith === 'function') {
    agentEvent.respondWith(
      result.catch((err) => `Error: ${err instanceof Error ? err.message : String(err)}`),
    )
    return
  }

  // A human pressed the button: nothing is waiting on the text, and `run` has
  // already shown them whatever went wrong.
  void result.catch(() => {})
}

/**
 * `toolname` / `tooldescription` are real HTML attributes to Chrome but unknown
 * to React's JSX types, so declare them once here rather than casting at every
 * form.
 */
declare module 'react' {
  interface FormHTMLAttributes<T> extends AriaAttributes, DOMAttributes<T> {
    /** Publishes this form as a WebMCP tool under this name. */
    toolname?: string
    /** The description an agent reads when choosing the tool. */
    tooldescription?: string
  }
}
