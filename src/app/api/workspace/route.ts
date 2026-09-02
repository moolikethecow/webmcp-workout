import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { NoWorkspaceError, currentWorkspaceId } from '@/lib/workspace/context'
import { ensureProvisioned, workspaceInfo } from '@/lib/workspace/provision'

export const dynamic = 'force-dynamic'

/**
 * GET /api/workspace — who am I?
 *
 * Also the cheapest way to force provisioning: hitting this on first load
 * creates and seeds the schema before the UI starts fanning out gym queries.
 */
export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const id = await currentWorkspaceId()
    await ensureProvisioned(id)
    return NextResponse.json(await workspaceInfo(id))
  } catch (err) {
    if (err instanceof NoWorkspaceError) {
      return NextResponse.json({ error: 'No workspace' }, { status: 400 })
    }
    console.error('[workspace] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load workspace' }, { status: 500 })
  }
}
