# Prior work vs. new work

This project was extracted from **Stark**, a private personal AI system, on 2026-09-01. The WebMCP Challenge rules require pre-existing projects to document what existed before the submission period (opened 2026-08-25) and what was added during it. This file is that record; the commit history is the evidence.

## Prior work (before 2026-08-25) — the extraction commit

The first commit in this repository (`chore: extract gym engine and UI from Stark`) contains code that existed in the private system before the submission period:

- the workout logger and gym UI (`src/components/gym/**`, `src/components/health/**`)
- the deterministic training engine (`src/lib/gym/**`, `src/lib/fitness/**`, `src/lib/units/**`, `src/lib/gym-client/**`)
- the gym HTTP routes it already had (`src/app/api/gym/**`, except the paths listed below)
- the exercise catalog (`src/lib/fitness/exercise-catalog.json`, vendored from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset), MIT — see the README's *Data and media* section for the media terms)
- the tests that came with the above

Parts of the private system were deliberately **not** extracted (its adaptive planner, its memory and coaching layers, wearable-fused recovery, and the derivation pipeline for exercise constraint profiles). Where the copied code referenced them, thin shims at the same import paths replace them.

## New work (2026-09-01 onward) — every commit after the extraction

Everything that makes this a WebMCP application was written during the submission period:

- `src/lib/webmcp/**` — tool registration on `document.modelContext`, page-scoped tool sets, same-origin execution, revision-safe mutations, agent activity feed
- `src/lib/gym/agent-edit.ts` and `src/app/api/gym/workouts/active/edit` — the live-workout edit surface the agent uses
- `src/app/api/gym/agent/**` — training context, muscle readiness, exercise progress
- `src/lib/gym/readiness-source.ts` — the readiness interface and its history-based implementation
- eligibility filtering on exercise search
- `src/lib/workspace/**` and `src/lib/db/client.ts` — per-visitor isolated workspaces (one Postgres schema each), provisioning, reset
- `seed/**` — the fictional athlete and the precomputed exercise constraint profiles
- the dashboard page, branding, deployment files, and all documentation in `docs/`

Use `git log --format='%h %ad %s' --date=iso` to see the timestamps. The private repository's history for the extracted files predates the submission period and can be shown to the judges on request.
