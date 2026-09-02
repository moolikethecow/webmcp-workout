'use client'

/**
 * Client fetch layer for the AI-coach plan surfaces (GYM_PLAN §2.6-2.7, §6, P3).
 * Typed fetchers for /api/gym/plan (proposal draft/tune/shuffle + start/dismiss)
 * and /api/gym/exercises/alternatives (the swap sheet).
 *
 * Mirrors lib/gym-client/fetch.ts + train/templates-fetch.ts conventions: plain
 * `fetch`, throw-on-non-ok, no SWR/React-Query dependency. The proposal endpoints
 * are user-initiated (a button press), so these are imperative promises — not
 * cached hooks (a GET-on-mount hook lives in the component that needs it).
 *
 * The wire types re-export the server's Proposal shape verbatim (lib/gym/plan.ts)
 * so the seam can never drift.
 */
import type {
  Proposal,
  ProposalExercise,
  ProposalPayload,
} from '@/lib/gym/plan'
import type { ActiveWorkout } from './active-types'
import type { AlternativesResponse, AlternativeRow } from '@/app/api/gym/exercises/alternatives/shape'

export type { Proposal, ProposalExercise, ProposalPayload }
export type { AlternativesResponse, AlternativeRow }

// ── GET the today proposal (never runs the LLM server-side) ──────────────────

/** GET /api/gym/plan → { proposal | null }. Throws on a non-ok response. */
export async function fetchTodayProposal(): Promise<Proposal | null> {
  const res = await fetch('/api/gym/plan')
  if (!res.ok) throw new Error(`GET /api/gym/plan → ${res.status}`)
  const payload = (await res.json()) as { proposal: Proposal | null }
  return payload.proposal ?? null
}

// ── POST generate (draft / tune / shuffle) ───────────────────────────────────

export interface GeneratePlanBody {
  mode: 'draft' | 'tune' | 'shuffle'
  /** tune: the template to anchor to. */
  templateId?: string
  /** shuffle: the prior proposal to resample away from. */
  proposalId?: string
  /** draft: free-text focus ("push day", "legs but easy on knees"). */
  focus?: string
}

/** POST a generate request (the LLM coach runs server-side). Returns the persisted
 *  proposal. Throws on a non-ok response. */
export async function generatePlan(body: GeneratePlanBody): Promise<Proposal> {
  const res = await fetch('/api/gym/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST /api/gym/plan (${body.mode}) → ${res.status}`)
  const payload = (await res.json()) as { proposal: Proposal }
  return payload.proposal
}

/** Draft a fresh workout (optionally focused). */
export function draftPlan(focus?: string): Promise<Proposal> {
  return generatePlan({ mode: 'draft', focus: focus?.trim() || undefined })
}

/** Tune a template into today's proposal (the "Tune for today ✦" seam). */
export function tunePlan(templateId: string): Promise<Proposal> {
  return generatePlan({ mode: 'tune', templateId })
}

/** Shuffle an existing proposal (resample away from its current exercises). */
export function shufflePlan(proposalId: string): Promise<Proposal> {
  return generatePlan({ mode: 'shuffle', proposalId })
}

// ── POST actions (start / dismiss) ───────────────────────────────────────────

/**
 * Start a proposal → the server materializes an ActiveWorkout and returns it.
 * A 409 means an active workout already exists (the caller should probe/resume);
 * we surface it as a typed result rather than a throw so the UI can branch.
 */
export interface StartProposalResult {
  workout?: ActiveWorkout
  /** Present on 409 — an active workout already exists with this id. */
  conflictActiveWorkoutId?: string
}

export async function startProposal(proposalId: string): Promise<StartProposalResult> {
  const res = await fetch('/api/gym/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start', proposalId }),
  })
  if (res.status === 409) {
    const body = (await res.json()) as { activeWorkoutId: string }
    return { conflictActiveWorkoutId: body.activeWorkoutId }
  }
  if (!res.ok) throw new Error(`POST /api/gym/plan (start) → ${res.status}`)
  return { workout: (await res.json()) as ActiveWorkout }
}

/** Dismiss a proposal (status → 'dismissed'). Throws on a non-ok response. */
export async function dismissProposal(proposalId: string): Promise<void> {
  const res = await fetch('/api/gym/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dismiss', proposalId }),
  })
  if (!res.ok) throw new Error(`POST /api/gym/plan (dismiss) → ${res.status}`)
}

// ── GET swap-sheet alternatives (deterministic; NO LLM) ──────────────────────

/** GET the deterministic same-muscle alternatives for an exercise (swap sheet). */
export async function fetchAlternatives(
  exerciseId: string,
  n?: number,
): Promise<AlternativesResponse> {
  const p = new URLSearchParams({ exerciseId })
  if (n != null) p.set('n', String(n))
  const res = await fetch(`/api/gym/exercises/alternatives?${p.toString()}`)
  if (!res.ok) throw new Error(`GET /api/gym/exercises/alternatives → ${res.status}`)
  return (await res.json()) as AlternativesResponse
}
