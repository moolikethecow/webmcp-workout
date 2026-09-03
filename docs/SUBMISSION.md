# Devpost submission text (draft)

## Before you submit — the checklist

1. **Flip the repo public** (`gh repo edit moolikethecow/webmcp-workout --visibility public --accept-visibility-change-consequences`) and confirm the LICENSE (AGPL-3.0) shows on the GitHub landing page.
2. **Test in ChatGPT the right way:** desktop app, updated; a **Work or Codex** chat on **GPT-5.6 Sol or Terra**; open https://spot.mootoo.co in the built-in browser; the address bar's **Site tools** menu should list the tools. If the agent says it cannot attach to the tab while the page reads *Agent-ready*, the chat is on the wrong model or mode — not the page.
3. **Record the video** (< 3 min) from `docs/DEMO_SCRIPT.md`, upload to YouTube (unlisted is fine), paste the link.
4. **Paste the four sections below** into the Devpost form (why WebMCP / better UX / together / how implemented), plus the testing instructions.
5. Deadline: **Thu 2026-09-03 13:00 PT**.


**Project name:** Spot — a WebMCP-native training partner
**Tagline:** Your agent spots you. It changes what's next; it can't touch what you've already lifted.
**Live URL:** https://spot.mootoo.co (no login; every visitor gets a private seeded workspace). gym.mootoo.co still serves the same app as a fallback if anything about spot regresses before you submit.
**Repo:** https://github.com/moolikethecow/webmcp-workout (AGPL-3.0)

## Why this use case is a strong fit for WebMCP

A workout is a living document that changes every ninety seconds while you're in the middle of it. A chat model can't hold that state: it remembers what you said, not what you did. The tracker holds the truth, but it can't reason with you. WebMCP puts the agent inside the page that owns the truth. The tools register on `document.modelContext` from the page the user is actually looking at, run in the user's own browser session, and read and write the exact same versioned session the logger renders. No API keys, no sync, no drift.

## How it creates a better user experience

You train. You tap sets done. Then you say, out loud or typed, "my shoulder's bugging me and I've got 30 minutes, keep what I've done, work around the shoulder, hit whatever's freshest," and the remaining exercises on screen change while the sets you finished stay exactly as you logged them. The replacement movements weren't hallucinated: the app filtered the catalog by your stated constraint and your equipment, and the agent picked from that pool. Ask why the next incline-press session says 80 lb and the answer cites your last six sessions and the double-progression rule you're on.

## What people and agents can do together that was difficult or impossible before

- Restructure a workout mid-session without losing what's been done. Every write carries the session revision; a stale edit is rejected and the agent re-reads.
- Apply a training constraint once and have it enforced everywhere: search, drafts, live edits all pass through one eligibility function over precomputed biomechanical demand profiles.
- Pick today's work from per-muscle readiness that's derived from the athlete's actual history, not from generic fitness advice.
- Get progression answers that are auditable: explicit policy in, next target out.
- Say "I'm in a hotel gym, dumbbells and a smith machine only" and have the catalog narrow to the room you are standing in — a gym that has never been recorded is created from the description.
- Let an agent *stage* a claim about your body without being able to assert it. The training-constraint tool is a form: the agent fills it, the tool call stays pending, and it completes when you press Add.

The human is better at feeling how a set went and calling an audible. The agent is better at querying six weeks of history, reconciling constraints and readiness, and doing the arithmetic. Neither replaces the other; the page is where they meet.

## How WebMCP is implemented

We use both halves of the API, and the split between them is the design.

**Sixteen page-scoped tools** (`get_training_context`, `get_active_workout`, `edit_active_workout`, `log_active_sets`, `search_exercises`, `get_muscle_readiness`, `get_training_constraints`, `set_training_constraint`, `draft_workout`, `edit_workout_draft`, `start_workout`, `get_exercise_progress`, `get_workout_history`, `get_training_plan`, `list_gyms`, `switch_gym`) are registered with `document.modelContext.registerTool` by a React hook on mount and unregistered through an `AbortController` on navigation. Each `execute` performs a same-origin `fetch` to the app's own API routes, which call the same library functions the UI uses, then invalidates the page's data so the logger refetches. Mutations pass `expected_revision` and return the new revision. Read tools carry `readOnlyHint`. Descriptions carry the invariants (completed sets preserved, warm-ups are not working volume, substitutions must come from the eligible pool, constraints are hard limits, no diagnosis). `get_training_context` returns the collaboration rules so an agent has a one-call orientation. The tool list is page-scoped because a tool list is a prompt: `edit_active_workout` and `log_active_sets` are not offered where there is no live session.

**One declarative tool, registered by markup.** `report_training_constraint` is a `<form>` on the dashboard carrying `toolname` and `tooldescription`. There is no `registerTool` call: Chrome reads the controls and derives the schema from them — `required` becomes JSON Schema `required`, a `<select>` becomes an enum carrying its option labels, and so on. We chose a form here for what it does to the timing. Chrome fills the fields and then waits: the tool call does not resolve until the form is actually submitted, so an agent can put `shoulder_joint · limiting · left shoulder` on screen but a person commits it. `SubmitEvent` exposes `agentInvoked` and `respondWith()`, so one handler serves both callers and hands the result back to whichever one was an agent.

ChatGPT's built-in browser implements a subset of WebMCP with no declarative API, so the form is not a site tool there. Rather than lose the beat in the client judges use, the page treats the form as the definition and the declarative API as one way to publish it: where the browser has not published the form (no `getTools`, or the name absent from it), the same `report_training_constraint` is registered in code, and its `execute` fills the same form and waits for the person's press. Chrome's indefinite wait is the one thing `registerTool` cannot reproduce, so after twenty seconds the call resolves with `awaiting_confirmation` and the values stay on screen for the press. One name, one form, one submit handler, three callers.

That gives the app an honest line: **what the agent may do alone is registered in code; what needs a hand on the button is a form.** Reading, searching, drafting and re-prescribing work not yet done are the first kind. Asserting a limit on your own body is the second. And because it is a real form, a browser with no WebMCP gets an ordinary constraint editor — the feature degrades into plain HTML.

Every visitor gets an isolated Postgres schema seeded with a fictional athlete, so judges can mutate freely.

## Testing instructions

**ChatGPT:** desktop app (latest), in a **Work or Codex** chat on **GPT-5.6 Sol or Terra** (Luna has site tools switched off; ChatGPT on the web and Enterprise/Edu workspaces cannot see them). Open https://spot.mootoo.co in the built-in browser; the address bar's **Site tools** menu lists the page's tools. **Chrome 149+:** just open the URL — the origin carries a WebMCP origin-trial token, so no flag is required. (`chrome://flags/#enable-webmcp-testing` for a local build; `chrome://flags/#devtools-webmcp-support` adds the DevTools panel.) No login. The panel on **/** says whether this browser can see the tools and, if not, what to open instead. Start the suggested workout on **/gym**, complete a set by hand, then try:

1. "My shoulder's bugging me and I've got 30 minutes. Keep what I've done, work around the shoulder, hit whatever's freshest."
2. Complete another set yourself, then: "What should I do next?"
3. "Before I go heavier on incline bench, am I actually progressing?"
4. On **/** — "my left shoulder is bad today, note it as limiting." Watch the constraint form fill in and stop (in ChatGPT it is highlighted *Filled in by your agent*). Nothing is recorded until you press Add; then search and drafts exclude overhead pressing.
5. "I'm in a hotel gym this week — dumbbells and a smith machine, that's it." The catalog narrows to what is in the room, and the reply says by how much.

Reset the workspace from Settings at any time.

## Prior work

The logger and the deterministic engine were extracted from a private personal system before the submission period; everything WebMCP, the isolated workspaces and the demo athlete were built during it. See `docs/PRIOR_WORK.md` and the commit timestamps.
