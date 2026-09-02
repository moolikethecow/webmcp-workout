# Devpost submission text (draft)

**Project name:** Workout — a WebMCP-native training partner
**Tagline:** The human logs the sets. The agent reshapes what's left. Same live workout, same rules.
**Live URL:** https://gym.mootoo.co (no login; every visitor gets a private seeded workspace)
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

The human is better at feeling how a set went and calling an audible. The agent is better at querying six weeks of history, reconciling constraints and readiness, and doing the arithmetic. Neither replaces the other; the page is where they meet.

## How WebMCP is implemented

Twelve page-scoped tools (`get_training_context`, `get_active_workout`, `edit_active_workout`, `search_exercises`, `get_muscle_readiness`, `get_training_constraints`, `set_training_constraint`, `draft_workout`, `edit_workout_draft`, `start_workout`, `get_exercise_progress`, `get_workout_history`) are registered with `document.modelContext.registerTool` by a React hook on mount and unregistered through an `AbortController` on navigation. Each `execute` performs a same-origin `fetch` to the app's own API routes, which call the same library functions the UI uses, then invalidates the page's data so the logger refetches. Mutations pass `expected_revision` and return the new revision. Read tools carry `readOnlyHint`. Descriptions carry the invariants (completed sets preserved, warm-ups are not working volume, substitutions must come from the eligible pool, constraints are hard limits, no diagnosis). `get_training_context` returns the collaboration rules so an agent has a one-call orientation. Every visitor gets an isolated Postgres schema seeded with a fictional athlete, so judges can mutate freely.

## Testing instructions

Open https://gym.mootoo.co in ChatGPT's in-app browser, or in Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled. No login. Start the suggested workout on **/gym**, complete a set by hand, then try:

1. "My shoulder's bugging me and I've got 30 minutes. Keep what I've done, work around the shoulder, hit whatever's freshest."
2. Complete another set yourself, then: "What should I do next?"
3. "Before I go heavier on incline bench, am I actually progressing?"

Reset the workspace from Settings at any time.

## Prior work

The logger and the deterministic engine were extracted from a private personal system before the submission period; everything WebMCP, the isolated workspaces and the demo athlete were built during it. See `docs/PRIOR_WORK.md` and the commit timestamps.
