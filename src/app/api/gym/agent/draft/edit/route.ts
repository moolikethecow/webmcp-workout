import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { resolveEligibleExercise } from '@/lib/gym/agent-edit'
import {
  getTodayProposal,
  updateProposalPayload,
  type ProposalExercise,
  type ProposalPayload,
} from '@/lib/gym/plan'

/**
 * POST /api/gym/agent/draft/edit — op editor for today's WORKOUT DRAFT (the
 * proposal that has not been started yet). The live-session equivalent is
 * /api/gym/workouts/active/edit; this one edits the plan, not the performance.
 *
 *   body { ops: [{ op, ...fields }] }
 *     → 200 { ok: true, proposal, applied[], rejected[] }
 *     → 400 { error, issues }
 *     → 404 { error } when there is no open draft for today
 *
 * Additions and replacements go through the same eligibility gate the live
 * editor uses, so a draft can never be steered into a movement the current
 * training constraints exclude.
 */

const DRAFT_EDIT_OPS = [
  'add_exercise',
  'remove_exercise',
  'replace_exercise',
  'reorder',
  'set_scheme',
  'set_weight',
  'set_rest',
  'set_superset',
  'clear_superset',
  'rename',
] as const

type DraftOpName = (typeof DRAFT_EDIT_OPS)[number]

const DraftEditOp = z.object({
  op: z.enum(DRAFT_EDIT_OPS),
  exercise_name: z.string().min(1).nullish(),
  replacement_exercise_name: z.string().min(1).nullish(),
  exercise_names: z.array(z.string().min(1)).min(2).max(10).nullish(),
  to: z.enum(['top', 'bottom']).nullish(),
  to_position: z.number().int().min(1).nullish(),
  sets: z.number().int().min(1).max(20).nullish(),
  reps: z.number().int().min(0).max(1000).nullish(),
  weight: z.number().min(0).nullish(),
  rest_seconds: z.number().int().min(0).max(1200).nullish(),
  workout_name: z.string().min(1).max(120).nullish(),
})

const DraftEditRequest = z.object({ ops: z.array(DraftEditOp).min(1).max(20) })

type DraftOp = z.infer<typeof DraftEditOp>

function findRow(rows: ProposalExercise[], name: string): number {
  const wanted = name.trim().toLowerCase()
  const exact = rows.findIndex((row) => row.name.trim().toLowerCase() === wanted)
  if (exact >= 0) return exact
  return rows.findIndex((row) => row.name.trim().toLowerCase().includes(wanted))
}

function move<T>(rows: T[], from: number, to: number): T[] {
  const next = [...rows]
  const clamped = Math.max(0, Math.min(next.length - 1, to))
  const [moved] = next.splice(from, 1)
  next.splice(clamped, 0, moved!)
  return next
}

type OpOutcome = { ok: true; payload: ProposalPayload; change: string } | { ok: false; error: string }

async function applyDraftOp(payload: ProposalPayload, op: DraftOp): Promise<OpOutcome> {
  const rows = payload.exercises
  const needRow = (): { ok: true; index: number } | { ok: false; error: string } => {
    if (!op.exercise_name) return { ok: false, error: `exercise_name is required for op "${op.op}".` }
    const index = findRow(rows, op.exercise_name)
    if (index < 0) {
      return {
        ok: false,
        error: `"${op.exercise_name}" isn't in the draft. It has: ${rows.map((row) => row.name).join(', ')}.`,
      }
    }
    return { ok: true, index }
  }

  switch (op.op) {
    case 'add_exercise': {
      if (!op.exercise_name) return { ok: false, error: 'exercise_name is required for op "add_exercise".' }
      const match = await resolveEligibleExercise(op.exercise_name)
      if (!match.ok) return match
      const added: ProposalExercise = {
        exerciseId: match.id,
        name: match.name,
        sets: op.sets ?? 3,
        reps: op.reps ?? null,
        targetWeight: op.weight ?? null,
        supersetGroup: null,
        restSeconds: op.rest_seconds ?? null,
        why: 'Added on request.',
        region: null,
      }
      const next = [...rows, added]
      const ordered = op.to_position != null ? move(next, next.length - 1, op.to_position - 1) : next
      return { ok: true, payload: { ...payload, exercises: ordered }, change: `Added ${match.name} to the draft.` }
    }

    case 'remove_exercise': {
      const found = needRow()
      if (!found.ok) return found
      if (rows.length <= 1) return { ok: false, error: "Can't remove the draft's last exercise." }
      const removed = rows[found.index]!
      return {
        ok: true,
        payload: { ...payload, exercises: rows.filter((_, index) => index !== found.index) },
        change: `Removed ${removed.name} from the draft.`,
      }
    }

    case 'replace_exercise': {
      const found = needRow()
      if (!found.ok) return found
      if (!op.replacement_exercise_name) {
        return { ok: false, error: 'replacement_exercise_name is required for op "replace_exercise".' }
      }
      const match = await resolveEligibleExercise(op.replacement_exercise_name)
      if (!match.ok) return match
      const old = rows[found.index]!
      const next = [...rows]
      next[found.index] = { ...old, exerciseId: match.id, name: match.name, why: 'Swapped on request.' }
      return { ok: true, payload: { ...payload, exercises: next }, change: `Replaced ${old.name} with ${match.name}.` }
    }

    case 'reorder': {
      const found = needRow()
      if (!found.ok) return found
      let to: number
      if (op.to === 'top') to = 0
      else if (op.to === 'bottom') to = rows.length - 1
      else if (op.to_position != null) to = op.to_position - 1
      else return { ok: false, error: 'Pass to (top/bottom) or to_position for op "reorder".' }
      return {
        ok: true,
        payload: { ...payload, exercises: move(rows, found.index, to) },
        change: `Moved ${rows[found.index]!.name} to slot ${Math.max(1, Math.min(rows.length, to + 1))}.`,
      }
    }

    case 'set_scheme': {
      const found = needRow()
      if (!found.ok) return found
      if (op.sets == null && op.reps == null) return { ok: false, error: 'Pass sets and/or reps for op "set_scheme".' }
      const next = [...rows]
      const row = next[found.index]!
      // Exact set rows, when present, are the source of truth at Start; a
      // scalar scheme change would silently disagree with them.
      next[found.index] = {
        ...row,
        sets: op.sets ?? row.sets,
        reps: op.reps ?? row.reps,
        setPrescriptions: op.sets != null || op.reps != null ? undefined : row.setPrescriptions,
      }
      return {
        ok: true,
        payload: { ...payload, exercises: next },
        change: `${row.name} is now ${op.sets ?? row.sets} sets${op.reps != null ? ` × ${op.reps}` : ''} in the draft.`,
      }
    }

    case 'set_weight': {
      const found = needRow()
      if (!found.ok) return found
      if (op.weight == null) return { ok: false, error: 'weight is required for op "set_weight".' }
      const next = [...rows]
      const row = next[found.index]!
      next[found.index] = { ...row, targetWeight: op.weight, setPrescriptions: undefined }
      return { ok: true, payload: { ...payload, exercises: next }, change: `${row.name} target set to ${op.weight}.` }
    }

    case 'set_rest': {
      const found = needRow()
      if (!found.ok) return found
      if (op.rest_seconds == null) return { ok: false, error: 'rest_seconds is required for op "set_rest".' }
      const next = [...rows]
      const row = next[found.index]!
      next[found.index] = { ...row, restSeconds: op.rest_seconds }
      return { ok: true, payload: { ...payload, exercises: next }, change: `Rest on ${row.name} set to ${op.rest_seconds}s.` }
    }

    case 'set_superset': {
      if (!op.exercise_names) return { ok: false, error: 'exercise_names (at least two) is required for op "set_superset".' }
      const indexes = new Set<number>()
      for (const name of op.exercise_names) {
        const index = findRow(rows, name)
        if (index < 0) return { ok: false, error: `"${name}" isn't in the draft.` }
        indexes.add(index)
      }
      if (indexes.size < 2) return { ok: false, error: 'A superset needs at least two different draft exercises.' }
      const group = Math.max(0, ...rows.map((row) => row.supersetGroup ?? 0)) + 1
      const next = rows.map((row, index) => (indexes.has(index) ? { ...row, supersetGroup: group } : row))
      return {
        ok: true,
        payload: { ...payload, exercises: next },
        change: `Supersetted ${[...indexes].map((index) => rows[index]!.name).join(' + ')}.`,
      }
    }

    case 'clear_superset': {
      const found = needRow()
      if (!found.ok) return found
      const row = rows[found.index]!
      if (row.supersetGroup == null) return { ok: false, error: `${row.name} is not in a superset.` }
      const group = row.supersetGroup
      const members = rows.filter((candidate) => candidate.supersetGroup === group)
      const next = rows.map((candidate, index) =>
        index === found.index || (members.length === 2 && candidate.supersetGroup === group)
          ? { ...candidate, supersetGroup: null }
          : candidate,
      )
      return { ok: true, payload: { ...payload, exercises: next }, change: `Removed ${row.name} from its superset.` }
    }

    case 'rename': {
      if (!op.workout_name) return { ok: false, error: 'workout_name is required for op "rename".' }
      return {
        ok: true,
        payload: { ...payload, name: op.workout_name.trim() },
        change: `Renamed the draft to ${op.workout_name.trim()}.`,
      }
    }

    default:
      return { ok: false, error: 'Unknown op.' }
  }
}

export async function POST(req: NextRequest) {
  // TODO(workspace): read the request-scoped workspace from the cookie layer
  // and run these readers/writers inside that workspace's schema context.
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = DraftEditRequest.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid draft edit', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    await ensureGymSchema()
    const proposal = await getTodayProposal()
    if (!proposal || proposal.status !== 'proposed') {
      return NextResponse.json(
        { error: 'There is no open draft for today. Build one with draft_workout first.' },
        { status: 404 },
      )
    }

    let payload = proposal.payload
    const applied: Array<{ op: DraftOpName; change: string }> = []
    const rejected: Array<{ op: DraftOpName; error: string }> = []
    for (const op of parsed.data.ops) {
      const outcome = await applyDraftOp(payload, op)
      if (outcome.ok) {
        payload = outcome.payload
        applied.push({ op: op.op, change: outcome.change })
      } else {
        rejected.push({ op: op.op, error: outcome.error })
      }
    }

    if (applied.length === 0) {
      return NextResponse.json({ ok: true, proposal, applied, rejected })
    }

    const updated = await updateProposalPayload(proposal.id, payload)
    if (!updated) {
      return NextResponse.json({ error: 'That draft is no longer editable.' }, { status: 404 })
    }
    return NextResponse.json({ ok: true, proposal: updated, applied, rejected })
  } catch (err) {
    console.error('[gym/agent/draft/edit] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to edit the draft' }, { status: 500 })
  }
}
