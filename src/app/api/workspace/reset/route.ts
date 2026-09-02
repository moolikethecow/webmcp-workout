import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { workspaceDrizzle } from '@/lib/db/client'
import { NoWorkspaceError, currentWorkspaceId } from '@/lib/workspace/context'
import { ensureProvisioned } from '@/lib/workspace/provision'
import { resetWorkspace } from '@/lib/workspace/seed'

export const dynamic = 'force-dynamic'

/**
 * POST /api/workspace/reset — put this visitor's workspace back to the demo
 * athlete's starting state. Wipes their history/templates/plan and re-seeds;
 * the exercise catalog is left alone (it is identical in every workspace).
 *
 * Scoped to the caller's own cookie — there is no way to reset anyone else's.
 */
export async function POST(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const id = await currentWorkspaceId()
    await ensureProvisioned(id)
    await resetWorkspace(workspaceDrizzle(id))
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof NoWorkspaceError) {
      return NextResponse.json({ error: 'No workspace' }, { status: 400 })
    }
    console.error('[workspace] reset failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to reset workspace' }, { status: 500 })
  }
}
