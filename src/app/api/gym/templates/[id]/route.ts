import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import {
  archiveTemplate,
  findMissingExerciseId,
  getTemplateForEditor,
  unarchiveTemplate,
  updateTemplateFromEditor,
  validateEditorPayload,
} from '@/lib/gym/templates-read'
import { getGymWeightUnit } from '@/lib/gym/unit-preferences'

/**
 * /api/gym/templates/[id] — one template's full lifecycle (GYM_PLAN §4 "Tab:
 * Templates" builder).
 *
 *   GET    → the full editor shape { template: { id, name, folder, notes, source,
 *            archived, exercises:[{ exerciseId, name, tracks, preferredUnit,
 *            position, targetSets, targetReps, targetWeight, targetWeightUnit, targetDurationS,
 *            restSeconds, supersetGroup, progression, notes }] } }. 404 if missing.
 *
 *   PATCH  { archived: boolean }
 *            → archive (true) / restore (false) toggle → { archived }. 404 when the
 *              toggle is a no-op (already in that state / missing).
 *          { name, folder?, notes?, exercises:[…] }
 *            → replace-all builder save (meta + exercises, in one transaction) →
 *              { template } (the reloaded editor shape). 400 on a bad body / invalid
 *              progression; 422 when an exerciseId doesn't exist; 404 when the
 *              template is missing.
 *
 *   DELETE → soft archive (archived_at = now) → { archived: true }. 404 when already
 *            archived / missing (honest rowcount). Real deletes never happen here —
 *            archive keeps history's template_id references intact.
 *
 * Authed + ensureGymSchema() first, like every gym write route.
 */

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticateRequest(_req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  try {
    await ensureGymSchema()
    const template = await getTemplateForEditor(id)
    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }
    return NextResponse.json({ template })
  } catch (err) {
    console.error('[gym/templates/:id] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load template' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const b = body as { archived?: unknown; exercises?: unknown }

  try {
    await ensureGymSchema()

    // ── Archive / restore toggle ──
    if (typeof b.archived === 'boolean') {
      const ok = b.archived ? await archiveTemplate(id) : await unarchiveTemplate(id)
      if (!ok) {
        return NextResponse.json(
          { error: b.archived ? 'Template not found or already archived' : 'Template not found or not archived' },
          { status: 404 },
        )
      }
      return NextResponse.json({ archived: b.archived })
    }

    // ── Full replace-all save ──
    if (Array.isArray(b.exercises)) {
      const validation = validateEditorPayload(body, await getGymWeightUnit())
      if (!validation.ok) {
        return NextResponse.json({ error: validation.error }, { status: 400 })
      }
      const missing = await findMissingExerciseId(
        validation.payload.exercises.map((e) => e.exerciseId),
      )
      if (missing) {
        return NextResponse.json({ error: `Exercise ${missing} does not exist` }, { status: 422 })
      }
      const updated = await updateTemplateFromEditor(id, validation.payload)
      if (!updated) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 })
      }
      const template = await getTemplateForEditor(id)
      return NextResponse.json({ template })
    }

    return NextResponse.json(
      { error: 'Provide { archived } or { name, exercises }' },
      { status: 400 },
    )
  } catch (err) {
    console.error('[gym/templates/:id] PATCH failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to update template' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticateRequest(_req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  try {
    await ensureGymSchema()
    const ok = await archiveTemplate(id)
    if (!ok) {
      return NextResponse.json(
        { error: 'Template not found or already archived' },
        { status: 404 },
      )
    }
    return NextResponse.json({ archived: true })
  } catch (err) {
    console.error('[gym/templates/:id] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to archive template' }, { status: 500 })
  }
}
