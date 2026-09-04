# Spot

*Your agent spots you — it can change what's next, but it can't touch what you've already lifted.*

**A WebMCP-native workout tracker where a person and an AI agent manage the same live training session.**

Most AI fitness tools generate text about a workout. Here the workout itself is the shared artifact: the logger you tap through at the gym and the tools an agent calls both read and write one canonical, versioned session. The human logs sets. The agent restructures what's left, within the app's rules.

> Live demo: **https://spot.mootoo.co** — no login. Every visitor gets a private workspace seeded with a fictional athlete's six weeks of training. Open it in ChatGPT's built-in browser or in Chrome 149+ and the page's tools register automatically; the panel on `/` says whether they did, and what to open if they did not. (The earlier **gym.mootoo.co** redirects here — it was the host while this was being built.)

## Try this

With the app open in an agent-capable browser:

1. Start the suggested workout on **/gym** and complete a set by hand.
2. Tell the agent: *"My shoulder's bugging me and I've got 30 minutes. Keep what I've done, work around the shoulder, hit whatever's freshest."*
3. Complete another set yourself, then ask: *"What should I do next?"*
4. Ask: *"Before I go heavier on incline bench, am I actually progressing?"*

The completed sets never change. Replacement exercises come from the eligible pool only. The answer about progress cites the athlete's own history and the explicit progression rule.

## Why WebMCP

Without WebMCP the agent and the tracker are two disconnected things: the model remembers a conversation, the app holds the truth, and they drift within minutes. WebMCP lets the page register tools on `document.modelContext`, so the agent operates on exactly the session the user is looking at, in the user's own browser session, with no separate API credentials.

The tools are deliberately page-scoped and narrow. The intelligence stays in the app:

| The app decides | The agent decides |
|---|---|
| which exercises are eligible under active training constraints | what the user is asking for |
| what counts as a completed set (immutable by default) | which tools to call, in which order |
| readiness per muscle region, from training history | how to explain the result |
| the next progression target, from an explicit policy | when to ask before changing something |
| revision checks so a stale edit cannot clobber a fresh one | |

### Two kinds of tool, and who presses the button

WebMCP has a second half almost nobody uses: a `<form>` carrying `toolname` and
`tooldescription` *is* a tool. Chrome derives the schema from the controls
themselves, and there is no `registerTool` call anywhere.

What makes that worth having is not brevity — it is that Chrome fills the form
and then **waits for a human to submit it**. The tool call stays pending until
someone presses the button.

So this app draws a line down its tool surface:

- **Registered in code** — read, search, draft, restructure work not yet done.
  The agent may do these alone.
- **A form on the page** — `report_training_constraint`, where you assert a
  limit on your own body. The agent fills `shoulder_joint · limiting · left
  shoulder` into the fields; the call completes when *you* press Add.

One form, two callers, one route, no parallel code path to drift. In a browser
without WebMCP it is an ordinary form. In a browser with WebMCP but no
declarative half — ChatGPT's — the same name is registered in code, fills the
same form, and still waits for your press. See
[docs/WEBMCP.md](docs/WEBMCP.md#the-form-that-is-a-tool).

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `get_training_context` | read | State summary and the collaboration rules. Call first. |
| `get_active_workout` | read | The exact live session: exercises, sets, completions, rest, revision. |
| `edit_active_workout` | write | Add, remove, replace, reorder, re-prescribe the *unfinished* part; revision-checked. |
| `log_active_sets` | write | Log actual performed sets with an explicit revision and measurements; never guesses from a target or prior session. |
| `search_exercises` | read | Catalog search filtered to exercises eligible under current constraints and equipment. |
| `get_muscle_readiness` | read | Per-region readiness derived from training history. |
| `get_training_constraints` / `set_training_constraint` | read / write | User-stated limitations that the eligibility engine enforces. Not a diagnosis. |
| `draft_workout` / `edit_workout_draft` / `start_workout` | write | Deterministic draft → collaborative edit → live session. |
| `get_exercise_progress` | read | Records, recent sessions, e1RM trend, and the applicable progression rule. |
| `get_training_plan` | read | The active plan's ordered days and which one is next. When a plan is running it decides the next session — readiness explains why, it does not choose. |
| `list_gyms` / `switch_gym` | read / write | Where you are training decides what equipment exists. Switching narrows the catalog; a gym you have never recorded can be created from a description of the room. |
| `report_training_constraint` | **form** | Declarative: the agent fills the fields, a person presses Add. Registered in code where the browser has no declarative API (ChatGPT), with the same wait. |
| `get_workout_history` | read | Completed sessions. |

Tools register per page (`/`, `/gym`, the History tab) and unregister on navigation. Every mutation re-reads canonical state and returns the new revision. Details: [docs/WEBMCP.md](docs/WEBMCP.md). Rules for agents: [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md).

## Training intelligence

- **Training constraints.** A constraint names a site and a severity. Every exercise in the catalog carries a precomputed biomechanical demand profile; one eligibility function decides, and search, drafts and live edits all go through it.
- **Muscle readiness.** Time since a region was trained, recent working-set volume and frequency, classified conservatively (fresh, ready, recovering, undertrained). No wearable data.
- **Progression.** Explicit, auditable policies (double progression, linear, RPE) produce the next target; the agent can explain a number instead of inventing one.
- **Live session invariants.** Completed sets are preserved unless explicitly correcting logged data; warm-ups are not working volume; only one active workout; every write carries a revision.

## Where this comes from

This is the open agent surface of **Stark**, a private personal AI system. The logger, the deterministic engine and their tests were extracted from it; the WebMCP layer, per-visitor workspaces and the demo athlete were built for the challenge. See [docs/PRIOR_WORK.md](docs/PRIOR_WORK.md) for the exact line.

The full system adds what this repo does not ship: wearable-fused readiness (sleep, HRV, recovery), memory across sessions, an adaptive planner, and coupling to nutrition, habits and the rest of a day. If you want that, [join the waitlist](https://waitlist.mootoo.co).

## Run it locally

```bash
pnpm install
pnpm db:up                      # Postgres 16 in Docker on :55433
cp .env.example .env.local
pnpm dev                        # http://localhost:3000
```

Every browser profile gets its own workspace (a Postgres schema) on first visit. Reset it from Settings.

## Where the tools are visible

| Client | What to do |
|---|---|
| **ChatGPT** | Desktop app (latest), a **Work or Codex** chat on **GPT-5.6 Sol or Terra**. Open the URL in the built-in browser and ask in the chat beside it. ChatGPT on the web, the Luna model, and Enterprise/Edu workspaces cannot see site tools. |
| **Chrome 149+** | Just open **https://spot.mootoo.co** — the origin carries a WebMCP origin-trial token, so `document.modelContext` is there on load. The form tool needs Chrome 152 or newer, where the declarative half of the API landed. For a local build enable `chrome://flags/#enable-webmcp-testing`; `chrome://flags/#devtools-webmcp-support` adds a DevTools panel that lists and invokes tools. |
| **Anything else** | Add `?webmcp=shim` for a console harness: `window.__webmcp.tools()` and `window.__webmcp.call(name, args)`. |

If an agent says it cannot attach to the tab while the page reads *Agent-ready*, the chat is not a Work/Codex session on Sol or Terra. The page is fine; switch the chat.

## Tests

```bash
pnpm typecheck && pnpm test && pnpm build
```

The suite covers the engine invariants (constraint exclusion, completed-set preservation, revision conflicts, warm-up accounting, progression targets, unit round-trips) and the WebMCP layer (registration, schemas, tool execution).

## License

AGPL-3.0. See [LICENSE](LICENSE). Copyright © 2026 Moo Olaniyan.

### Data and media

- **Exercise catalog** — names, muscle metadata and instructions come from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset) (MIT), vendored at a pinned commit as `seed/catalog.json`. The `injury_profile` on every row (the biomechanical demand profile the eligibility gate reads) was precomputed for this catalog and is licensed with the rest of the repository.
- **No third-party media.** That dataset's exercise GIFs are © Gym visual and are not redistributable without their own licence, so this app does not fetch or serve them. The rows still carry the file names; every exercise is drawn as a muscle-map figure instead.
