/**
 * Patch edits for workout templates (#1830).
 *
 * `manage_workout_template action:"update"` is replace-all: setting rest on two
 * exercises meant resending the whole ten-exercise list with every per-set
 * prescription, note and progression rule — ~2KB for a two-field change. That is
 * expensive, and worse, it is lossy in a way that fails SILENTLY: an exercise
 * accidentally left out of the resent list is deleted, and a field the client
 * forgets to echo (a note, a per-set RPE) is gone with no error.
 *
 * ── The shape of the fix ───────────────────────────────────────────────────
 * A patch is NOT a second write path. It reads the template through the same
 * editor model the builder uses, applies operations in memory, and hands the
 * result back to the SAME `validateEditorPayload` → `updateTemplateFromEditor`
 * the full update already goes through. So every invariant that protects a
 * replace-all protects a patch too, for free, and there is no second
 * implementation to drift.
 *
 * Operation names deliberately mirror `edit_active_workout` (set_rest,
 * set_superset, clear_superset, set_scheme, remove_exercise), because the live
 * session and the template are the same mental model and should not need two
 * vocabularies.
 */
import type { EditorExercise, TemplateSetInput } from '@/lib/gym/templates-read'

export type TemplatePatchOp =
  | { op: 'set_rest'; exercise: string; restSeconds: number | null }
  | { op: 'set_scheme'; exercise: string; sets?: number | null; reps?: number | null }
  | { op: 'set_superset'; exercise: string; group: number }
  | { op: 'clear_superset'; exercise: string }
  | { op: 'set_notes'; exercise: string; notes: string | null }
  | { op: 'remove_exercise'; exercise: string }

export interface PatchOutcome {
  ok: boolean
  exercises: EditorExercise[]
  /** One line per applied op, for the tool's echo. */
  changes: string[]
  error?: string
}

const norm = (s: string) => s.trim().toLowerCase()

/** Rebuild a set list for a new sets×reps scheme, preserving what the existing
 *  rows already say. Extra rounds copy the LAST working set rather than
 *  inventing a prescription, and warmups are never touched — the same division
 *  the live logger's scheme edit makes. */
function reshape(
  sets: TemplateSetInput[],
  targetCount: number | null,
  reps: number | null | undefined,
): TemplateSetInput[] {
  const warmups = sets.filter((s) => s.setType === 'warmup')
  const working = sets.filter((s) => s.setType !== 'warmup')
  const wanted = targetCount ?? working.length
  const template = working[working.length - 1]

  const next: TemplateSetInput[] = []
  for (let i = 0; i < wanted; i += 1) {
    const base = working[i] ?? template
    if (!base) break
    next.push({ ...base, ...(reps != null ? { targetReps: reps } : {}) })
  }
  // Renumber across warmups + working so set_number stays dense and ordered.
  return [...warmups, ...next].map((s, i) => ({ ...s, setNumber: i + 1 }))
}

/**
 * Apply patch operations to a template's exercises, in order.
 *
 * Pure: takes the current editor exercises, returns new ones. Every op names its
 * target by EXERCISE NAME (what the caller is looking at) and fails loudly on a
 * miss — a silent no-op here would look exactly like a successful edit, which is
 * the failure mode this whole feature exists to remove.
 */
export function applyTemplatePatch(
  current: EditorExercise[],
  ops: readonly TemplatePatchOp[],
): PatchOutcome {
  if (ops.length === 0) {
    return { ok: false, exercises: current, changes: [], error: 'Pass at least one operation.' }
  }

  let exercises = current.map((e) => ({ ...e, sets: e.sets.map((s) => ({ ...s })) }))
  const changes: string[] = []

  for (const op of ops) {
    const idx = exercises.findIndex((e) => norm(e.name) === norm(op.exercise))
    if (idx < 0) {
      return {
        ok: false,
        exercises: current,
        changes: [],
        error: `"${op.exercise}" is not in this template. It has: ${current.map((e) => e.name).join(', ')}.`,
      }
    }
    const ex = exercises[idx]!

    switch (op.op) {
      case 'set_rest': {
        // Rest lives on the exercise AND on each working set; a template whose
        // two disagree renders one number and programs the other.
        exercises[idx] = {
          ...ex,
          restSeconds: op.restSeconds,
          sets: ex.sets.map((s) =>
            s.setType === 'warmup' ? s : { ...s, restSeconds: op.restSeconds },
          ),
        }
        changes.push(`${ex.name}: rest ${op.restSeconds ?? 'cleared'}s on working sets`)
        break
      }
      case 'set_scheme': {
        const sets = op.sets ?? null
        exercises[idx] = {
          ...ex,
          targetSets: sets ?? ex.targetSets,
          targetReps: op.reps ?? ex.targetReps,
          sets: reshape(ex.sets, sets, op.reps),
        }
        changes.push(
          `${ex.name}: ${sets ?? ex.targetSets ?? '?'}×${op.reps ?? ex.targetReps ?? '?'}`,
        )
        break
      }
      case 'set_superset': {
        exercises[idx] = { ...ex, supersetGroup: op.group }
        changes.push(`${ex.name}: superset group ${op.group}`)
        break
      }
      case 'clear_superset': {
        exercises[idx] = { ...ex, supersetGroup: null }
        changes.push(`${ex.name}: superset cleared`)
        break
      }
      case 'set_notes': {
        exercises[idx] = { ...ex, notes: op.notes }
        changes.push(`${ex.name}: note ${op.notes ? 'updated' : 'cleared'}`)
        break
      }
      case 'remove_exercise': {
        exercises = exercises.filter((_, i) => i !== idx)
        changes.push(`${ex.name}: removed`)
        break
      }
    }
  }

  // Positions stay dense after a removal, so the template's order survives a
  // patch the same way it survives a full rewrite.
  exercises = exercises.map((e, i) => ({ ...e, position: i }))
  return { ok: true, exercises, changes }
}
