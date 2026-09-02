# The WebMCP layer

This app exposes its own capabilities to whatever agent is driving the browser.
No server, no API key, no separate deployment: the page registers a set of tools
on `document.modelContext`, and an agent in the same tab can call them. It acts
as the person who opened the page, through the same HTTP routes the UI itself
uses.

That last part is the design. There is one writer for the workout, one revision
counter, one eligibility gate. The agent is not a parallel path into the data —
it is another client of the same one.

---

## How it works

### 1. Registration is per page, and lives as long as the page

`useGymWebMCP(page)` runs one effect: create an `AbortController`, register that
page's tools with its signal, abort on unmount. Aborting is what unregisters, so
there is no teardown list to fall out of sync with the registration list.

```ts
// src/lib/webmcp/use-gym-webmcp.ts
useEffect(() => {
  const controller = new AbortController()
  void registerTools(toolsForPage(page), controller.signal)
  return () => controller.abort()
}, [page])
```

`registerTools` feature-detects `document.modelContext ?? navigator.modelContext`
(the former is canonical; the latter is an older Chromium preview surface). When
neither exists — which is most browsers today — it logs one informational line
and returns `{ supported: false }`. The app is unaffected. Each tool is
registered inside its own `try`/`catch`, so one malformed schema cannot take the
other eleven down with it.

**Callbacks never close over React state.** A tool registered on first render
would otherwise hand an agent a snapshot of whatever the UI was showing at mount.
Every `execute` fetches canonical state instead.

### 2. Every tool is a same-origin fetch

`agentFetch` is the only transport: same origin, `credentials: 'same-origin'`,
and it never throws — a network failure comes back as a value, because a tool
that rejects gives an agent nothing to work with, while a tool that returns
`Error: …` gives it something to read and retry against.

Success is always one text block of JSON:

```ts
{ content: [{ type: 'text', text: JSON.stringify(payload) }] }
```

Failure is always one text block starting with `Error:`, carrying the server's
own message and body.

### 3. Revision safety

`workouts.revision` is bumped by every write. The flow for any live edit is:

1. `get_active_workout` → returns the workout **and its `revision`**.
2. `edit_active_workout` with `expected_revision` set to that number.
3. The server re-reads canonical state, compares, and either applies the ops or
   answers **409 `stale_revision`** with the current workout in the body.

A `stale_revision` means a human logged a set while the agent was thinking. That
is not a bug — it is the entire point of a shared artifact, and the tool
description tells the agent to re-read and retry rather than force the write.

Ops apply in order, each against freshly re-read state, and each is accepted or
rejected independently. The response lists `applied[]` and `rejected[]` so a
partially-successful batch is legible rather than ambiguous.

### 4. Refresh, and saying so

After any successful mutation a tool calls `afterMutation`, which does two
things:

- `invalidateResources(['gym'])` — bumps the app's data-sync version, so the
  open page refetches canonical state and the change appears without a reload.
- `recordAgentEvent(tool, summary)` — appends to a 20-entry zustand store
  (`src/lib/webmcp/agent-events.ts`) that the UI renders as an "Updated by
  agent" feed.

Correctness and legibility are separate problems. The first makes the numbers
right; the second means the person holding the barbell can see *why* the set in
front of them changed.

---

## The tools

| Tool | Read-only | Route | Registered on |
|---|---|---|---|
| `get_training_context` | ✓ | `GET /api/gym/agent/context` | all |
| `get_active_workout` | ✓ | `GET /api/gym/workouts/active` | all |
| `search_exercises` | ✓ | `GET /api/gym/exercises?eligible=1` | all |
| `get_muscle_readiness` | ✓ | `GET /api/gym/agent/readiness` | all |
| `get_training_constraints` | ✓ | `GET /api/gym/injuries?active=1` | all |
| `get_exercise_progress` | ✓ | `GET /api/gym/agent/progress?exercise=` | all |
| `get_workout_history` | ✓ | `GET /api/gym/history` | all |
| `set_training_constraint` | | `POST /api/gym/injuries`, `PATCH /api/gym/injuries/[id]` | all |
| `draft_workout` | | `POST /api/gym/plan` | gym, dashboard |
| `start_workout` | | `POST /api/gym/plan` (from a draft) or `POST /api/gym/workouts` | gym, dashboard |
| `edit_workout_draft` | | `POST /api/gym/agent/draft/edit` | gym |
| `edit_active_workout` | | `POST /api/gym/workouts/active/edit` | gym |

Page sets are defined in `src/lib/webmcp/tools/index.ts`. A tool list is a
prompt: offering `edit_active_workout` on the history page would invite an agent
to try it where it makes no sense, so it is not offered there.

### Vocabulary

Publicly these are **training constraints**, never "injuries", and
**readiness**, never "recovery". The API routes are still `/api/gym/injuries`
for historical reasons; the agent-facing surface is not. `set_training_constraint`
carries the non-medical disclaimer in its description, where it travels with the
tool into whatever client surfaces it.

### Eligibility is not optional

`search_exercises` always sends `eligible=1`. The route loads active constraints,
parses each row's exercise demand profile and runs
`exerciseAllowedWithInjuries` — the same single gate the drafting engine and the
live editor use. An agent cannot route around it by declining to pass a flag,
and `edit_active_workout` re-checks on the server anyway, so a name obtained
some other way is still refused.

---

## Testing it

### Chrome

1. Chrome 149+, open `chrome://flags/#enable-webmcp-testing`, enable it, restart.
2. Load the app and open the **WebMCP panel in DevTools**. It lists every
   registered tool with its schema, and lets you invoke one with JSON arguments
   and see the raw result — the fastest way to check a schema change or debug a
   tool that an agent says it cannot find.
3. If the panel shows nothing: check the console for the
   `[webmcp] document.modelContext is not available` line (flag not on), then
   confirm the page mounts a component calling `useGymWebMCP`.

Quick console check without DevTools panels:

```js
await document.modelContext.getTools()   // names, descriptions, schemas
```

### ChatGPT's browser

WebMCP is on there already. Open the deployed app in it, start a workout, and
ask for something that requires a tool — "add face pulls after the bench press"
or "my left shoulder is bad today, swap the overhead press". The tools register
on page load; there is nothing to install.

Good things to demonstrate, because they show the shared-artifact property
rather than just a working tool call:

- Log a set in the app *between* the agent's read and its write, and watch it
  come back with `stale_revision`, re-read and retry.
- Ask it to cut an exercise to two sets after you have already completed three —
  it refuses rather than deleting logged work.
- Add a training constraint mid-session and then ask for a substitution; the
  excluded movement is not in `search_exercises` results at all.

### Automated

```
pnpm vitest run src/lib/webmcp
```

covers registration (present / absent / one bad tool / already aborted) and
every tool's schema: draft-07 object, `required ⊆ properties`, typed properties,
correct `readOnlyHint`, and the vocabulary rule.

---

## Adding a tool

1. New file in `src/lib/webmcp/tools/`, exporting a `WebMcpTool`.
2. Hand-written JSON Schema draft-07 for `inputSchema` — no generator. The
   schema is documentation an agent reads, so the descriptions matter as much as
   the types.
3. The description states **when to use it** and **its invariants**. Assume it
   is the only thing the agent will read.
4. `annotations: { readOnlyHint: true }` for reads.
5. Mutations end with `afterMutation(name, summary)`.
6. Add it to `ALL_TOOLS` and to the right page sets in `tools/index.ts`, and
   update the table above.

## Files

```
src/lib/webmcp/
  types.ts            minimal WebMCP types (see the note in-file on @mcp-b/webmcp-types)
  register.ts         feature detection + per-tool registration
  fetch.ts            same-origin transport that never throws
  agent-events.ts     20-entry "Updated by agent" feed
  use-gym-webmcp.ts   the React hook
  tools/              one file per tool + shared result helpers
  index.ts            public surface
```
