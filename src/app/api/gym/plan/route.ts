import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import {
  dismissProposal,
  generatePlan,
  getTodayProposal,
  ProposalWriteConflictError,
  proposalToWorkoutStart,
  type PlanMode,
} from '@/lib/gym/plan'
import { getGymWeightUnit } from '@/lib/gym/unit-preferences'

/**
 * /api/gym/plan — the AI coach's draft surface (GYM_PLAN §6, P3).
 *
 *   GET  → { proposal: getTodayProposal() | null }
 *          NEVER runs the LLM — reads the latest 'proposed' row for today +
 *          recomputes the context hash for a `stale` flag.
 *
 *   POST { mode: 'draft' | 'tune' | 'shuffle', templateId?, proposalId?, focus? }
 *        → { proposal }              (200; runs the coach engine + validation gate)
 *        → 409 proposal_conflict     when a shuffle's source draft changed
 *   POST { action: 'dismiss', proposalId }
 *        → { ok: true }              (200) / 404 when not 'proposed'
 *   POST { action: 'start', proposalId }
 *        → ActiveWorkout             (200)
 *        → 409 { activeWorkoutId }   when one is already active
 *        → 404                       when the proposal isn't startable
 *
 * Authed + ensureGymSchema() like the other gym routes. The LLM only ever runs on a
 * POST with a `mode` (user-initiated draft/tune/shuffle) — GET is deterministic.
 */

const VALID_MODES = new Set<PlanMode>(['draft', 'tune', 'shuffle'])

export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    await ensureGymSchema()
    const proposal = await getTodayProposal()
    const weightUnit = await getGymWeightUnit()
    return NextResponse.json({ proposal: proposal ? { ...proposal, weightUnit } : null })
  } catch (err) {
    console.error('[gym/plan] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to load proposal' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const b = body as {
    action?: unknown
    mode?: unknown
    templateId?: unknown
    proposalId?: unknown
    focus?: unknown
  }

  try {
    await ensureGymSchema()

    // ── action routes (dismiss / start) ────────────────────────────────────
    if (b.action === 'dismiss') {
      const proposalId = typeof b.proposalId === 'string' ? b.proposalId : ''
      if (!proposalId) {
        return NextResponse.json({ error: 'proposalId is required' }, { status: 400 })
      }
      const ok = await dismissProposal(proposalId)
      if (!ok) return NextResponse.json({ error: 'Proposal not found or already used' }, { status: 404 })
      return NextResponse.json({ ok: true })
    }

    if (b.action === 'start') {
      const proposalId = typeof b.proposalId === 'string' ? b.proposalId : ''
      if (!proposalId) {
        return NextResponse.json({ error: 'proposalId is required' }, { status: 400 })
      }
      const result = await proposalToWorkoutStart(proposalId)
      if (result.conflictActiveWorkoutId) {
        return NextResponse.json({ activeWorkoutId: result.conflictActiveWorkoutId }, { status: 409 })
      }
      if (result.notStartable || !result.workout) {
        return NextResponse.json({ error: 'Proposal not found or not startable' }, { status: 404 })
      }
      return NextResponse.json(result.workout)
    }

    // ── generate (draft / tune / shuffle) ──────────────────────────────────
    const mode = b.mode as PlanMode
    if (typeof mode !== 'string' || !VALID_MODES.has(mode)) {
      return NextResponse.json(
        { error: "mode must be 'draft' | 'tune' | 'shuffle' (or pass action:'dismiss'|'start')" },
        { status: 400 },
      )
    }
    const templateId = typeof b.templateId === 'string' ? b.templateId : undefined
    const proposalId = typeof b.proposalId === 'string' ? b.proposalId : undefined
    const focus = typeof b.focus === 'string' ? b.focus : undefined

    if (mode === 'tune' && !templateId) {
      return NextResponse.json({ error: 'templateId is required when mode=tune' }, { status: 400 })
    }
    if (mode === 'shuffle' && !proposalId) {
      return NextResponse.json({ error: 'proposalId is required when mode=shuffle' }, { status: 400 })
    }

    const proposal = await generatePlan({ mode, templateId, proposalId, focus })
    const weightUnit = await getGymWeightUnit()
    return NextResponse.json({ proposal: { ...proposal, weightUnit } })
  } catch (err) {
    if (err instanceof ProposalWriteConflictError) {
      return NextResponse.json(
        {
          error: 'The workout proposal changed while it was being shuffled. Re-read the current draft.',
          code: 'proposal_conflict',
          proposalId: err.proposalId,
        },
        { status: 409 },
      )
    }
    console.error('[gym/plan] POST failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to generate plan' }, { status: 500 })
  }
}
