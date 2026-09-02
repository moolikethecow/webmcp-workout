import { NextResponse, type NextRequest } from 'next/server'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import {
  createTemplateFromEditor,
  createTemplateFromWorkout,
  duplicateTemplate,
  findMissingExerciseId,
  getTemplateForEditor,
  listTemplateCards,
  listTemplatesForStart,
  validateEditorPayload,
} from '@/lib/gym/templates-read'
import { getGymWeightUnit } from '@/lib/gym/unit-preferences'

/**
 * /api/gym/templates — the Templates surface. GET serves either the Train-tab
 * start surface (default) or the Templates-tab card list (?view=cards[&archived=1]);
 * POST creates a template three ways (full builder payload · duplicate · save-as
 * from a workout).
 *
 *   GET
 *     (default)              → { templates:[…], lastWorkout } — Train start surface.
 *     ?view=cards            → { folders:[{folder, templates:[…]}], allFolders } —
 *                              folder-grouped Templates-tab cards. &archived=1 →
 *                              only archived (the restore view).
 *
 *   POST (dispatched by body shape):
 *     { name, folder?, notes?, exercises:[{ exerciseId, position, targetSets?,
 *       targetReps?, targetWeight?, targetWeightUnit?, targetDurationS?, restSeconds?, supersetGroup?,
 *       progression? }] }        → full builder create → { template: {id,…} }.
 *                                  400 on a bad body / invalid progression;
 *                                  422 when an exerciseId doesn't exist.
 *     { duplicateOf }           → duplicate an existing template → { template }.
 *                                  404 when the source is missing.
 *     { fromWorkoutId, name, carryProgression? }
 *                                → save-as-template from a completed workout (P2a
 *                                  finish-sheet path) → { template }. 422 no exercises.
 *                                  carryProgression copies the SOURCE template's
 *                                  per-exercise progression policies onto the new one.
 *
 * Authed + ensureGymSchema() like the other gym write routes.
 */

export async function GET(req: NextRequest) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    await ensureGymSchema()
    const url = new URL(req.url)
    if (url.searchParams.get('view') === 'cards') {
      const archived = url.searchParams.get('archived') === '1'
      const result = await listTemplateCards(archived)
      return NextResponse.json(result)
    }
    const result = await listTemplatesForStart()
    return NextResponse.json(result)
  } catch (err) {
    console.error('[gym/templates] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load templates' }, { status: 500 })
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
    fromWorkoutId?: unknown
    duplicateOf?: unknown
    name?: unknown
    exercises?: unknown
    carryProgression?: unknown
  }

  try {
    await ensureGymSchema()

    // ── Duplicate an existing template ──
    if (typeof b.duplicateOf === 'string' && b.duplicateOf) {
      const template = await duplicateTemplate(b.duplicateOf)
      if (!template) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 })
      }
      return NextResponse.json({ template }, { status: 201 })
    }

    // ── Save-as-template from a completed workout (P2a finish path) ──
    if (typeof b.fromWorkoutId === 'string' && b.fromWorkoutId) {
      const name = typeof b.name === 'string' ? b.name : ''
      if (!name.trim()) {
        return NextResponse.json({ error: 'name is required' }, { status: 400 })
      }
      const template = await createTemplateFromWorkout(b.fromWorkoutId, name, {
        carryProgression: b.carryProgression === true,
      })
      if (!template) {
        return NextResponse.json(
          { error: 'Workout has no exercises to save as a template' },
          { status: 422 },
        )
      }
      return NextResponse.json({ template }, { status: 201 })
    }

    // ── Full builder create (the editor payload) ──
    if (Array.isArray(b.exercises)) {
      const validation = validateEditorPayload(body, await getGymWeightUnit())
      if (!validation.ok) {
        return NextResponse.json({ error: validation.error }, { status: 400 })
      }
      const missing = await findMissingExerciseId(
        validation.payload.exercises.map((e) => e.exerciseId),
      )
      if (missing) {
        return NextResponse.json(
          { error: `Exercise ${missing} does not exist` },
          { status: 422 },
        )
      }
      const id = await createTemplateFromEditor(validation.payload)
      const template = await getTemplateForEditor(id)
      return NextResponse.json({ template }, { status: 201 })
    }

    return NextResponse.json(
      { error: 'Provide exercises (create), duplicateOf, or fromWorkoutId' },
      { status: 400 },
    )
  } catch (err) {
    console.error('[gym/templates] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to create template' }, { status: 500 })
  }
}
