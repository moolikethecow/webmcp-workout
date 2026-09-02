import { NextResponse, type NextRequest } from 'next/server'

import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import { ActiveEditRequest, applyActiveEdit } from '@/lib/gym/agent-edit'

/**
 * POST /api/gym/workouts/active/edit — the same-origin op editor for the
 * workout currently being performed.
 *
 *   body { expected_revision?, ops: [{ op, ...fields }] }
 *     → 200 { ok: true, workout, revision, applied[], rejected[] }
 *     → 400 { error, issues }        zod validation failure
 *     → 404 { error }                no workout is active
 *     → 409 { error, code:'stale_revision', current_revision, workout, applied[], rejected[] }
 *
 * The 409 is the interesting one: it means a human logged a set (or another
 * agent edited) between the caller's read and this write. The current workout
 * comes back in the body so the caller can re-read and retry without a second
 * round trip. See `lib/gym/agent-edit.ts` for the op vocabulary and invariants.
 */
export async function POST(req: NextRequest) {
  // TODO(workspace): read the request-scoped workspace from the cookie layer
  // and run this inside that workspace's schema context.
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = ActiveEditRequest.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid edit request', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  try {
    await ensureGymSchema()
    const result = await applyActiveEdit(parsed.data)

    if (result.ok) return NextResponse.json(result)

    if (result.code === 'no_active_workout') {
      return NextResponse.json(
        { error: 'No workout is active. Start one before editing.', code: 'no_active_workout' },
        { status: 404 },
      )
    }

    return NextResponse.json(
      {
        error:
          'The workout changed since it was read. Re-read it with get_active_workout and retry the change.',
        code: 'stale_revision',
        current_revision: result.current_revision,
        workout: result.workout,
        applied: result.applied,
        rejected: result.rejected,
      },
      { status: 409 },
    )
  } catch (err) {
    console.error(
      '[gym/workouts/active/edit] POST failed:',
      err instanceof Error ? err.message : err,
    )
    return NextResponse.json({ error: 'Failed to edit the active workout' }, { status: 500 })
  }
}
