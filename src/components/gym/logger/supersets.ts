/**
 * Superset derivation helpers (GYM_PLAN §4 "Supersets", P2b). PURE, no React.
 *
 * `superset_group` is an opaque group id assigned at creation (same value ⇔ same
 * group; never renumbered; delete-middle leaves a harmless gap). A1/A2/B1 labels
 * and the accent-band colour are DERIVED here from (group, position order) — never
 * stored. The "up next" rotation interleaves group members A1→B1→A2→B2: after a set
 * completes on member i, the next target is member (i+1) mod groupSize.
 */

import type { ActiveExercise, ActiveWorkout } from '@/lib/gym-client/active-types'

/** Rotating accent hues for superset bands (by group order of appearance). */
export const SUPERSET_HUES = [
  'var(--accent)',
  'var(--violet, #a78bfa)',
  'var(--success, #34d399)',
  'var(--warning, #fbbf24)',
] as const

export interface SupersetInfo {
  /** The group id (opaque) this exercise belongs to, or null when ungrouped. */
  group: number | null
  /** Derived label like "A1" / "A2" / "B1" (letter = group order, number = member
   *  order within the group). null when ungrouped. */
  label: string | null
  /** Accent band colour for the group (stable per group), or null when ungrouped. */
  color: string | null
  /** The workoutExerciseId of the NEXT member in the rotation (for the up-next
   *  hint), or null when ungrouped / solo group. */
  nextExerciseId: string | null
}

/**
 * Build a per-exercise superset map for a workout. Groups are lettered by first
 * appearance (A, B, C…); members numbered by position order within the group.
 */
export function supersetMap(workout: ActiveWorkout | null): Map<string, SupersetInfo> {
  const map = new Map<string, SupersetInfo>()
  if (!workout) return map

  const ordered = [...workout.exercises].sort((a, b) => a.position - b.position)

  // Assign a letter index to each group by first appearance.
  const groupLetterIdx = new Map<number, number>()
  for (const ex of ordered) {
    if (ex.supersetGroup == null) continue
    if (!groupLetterIdx.has(ex.supersetGroup)) {
      groupLetterIdx.set(ex.supersetGroup, groupLetterIdx.size)
    }
  }

  // Members per group, in position order.
  const members = new Map<number, ActiveExercise[]>()
  for (const ex of ordered) {
    if (ex.supersetGroup == null) continue
    const arr = members.get(ex.supersetGroup) ?? []
    arr.push(ex)
    members.set(ex.supersetGroup, arr)
  }

  for (const ex of ordered) {
    const g = ex.supersetGroup
    if (g == null) {
      map.set(ex.workoutExerciseId, { group: null, label: null, color: null, nextExerciseId: null })
      continue
    }
    const groupMembers = members.get(g)!
    const letterIdx = groupLetterIdx.get(g)!
    const memberIdx = groupMembers.findIndex((m) => m.workoutExerciseId === ex.workoutExerciseId)
    const letter = String.fromCharCode(65 + (letterIdx % 26)) // A, B, C…
    const next = groupMembers.length > 1
      ? groupMembers[(memberIdx + 1) % groupMembers.length]!.workoutExerciseId
      : null
    map.set(ex.workoutExerciseId, {
      group: g,
      label: `${letter}${memberIdx + 1}`,
      color: SUPERSET_HUES[letterIdx % SUPERSET_HUES.length]!,
      nextExerciseId: next,
    })
  }

  return map
}

/**
 * A stable, unused-in-this-workout group id for a NEW superset. Uses max existing
 * group + 1 (never renumbers existing groups — §3 semantics), min 1.
 */
export function nextSupersetGroupId(workout: ActiveWorkout | null): number {
  if (!workout) return 1
  let max = 0
  for (const ex of workout.exercises) {
    if (ex.supersetGroup != null && ex.supersetGroup > max) max = ex.supersetGroup
  }
  return max + 1
}

/**
 * Resolve the pair to group when "Superset with next" is chosen on an exercise:
 * the exercise + the one immediately after it in position order. Returns the two
 * workoutExerciseIds and the group id to assign (the next exercise's existing group
 * if it has one — so chaining a third onto an A group keeps them together — else a
 * fresh id). Returns null when there is no "next" exercise.
 */
export function supersetWithNext(
  workout: ActiveWorkout | null,
  workoutExerciseId: string,
): { ids: string[]; group: number } | null {
  if (!workout) return null
  const ordered = [...workout.exercises].sort((a, b) => a.position - b.position)
  const idx = ordered.findIndex((e) => e.workoutExerciseId === workoutExerciseId)
  if (idx < 0 || idx >= ordered.length - 1) return null
  const cur = ordered[idx]!
  const nxt = ordered[idx + 1]!
  // Prefer an existing group on either neighbour so a chain stays one group.
  const group = cur.supersetGroup ?? nxt.supersetGroup ?? nextSupersetGroupId(workout)
  const ids = [cur.workoutExerciseId, nxt.workoutExerciseId]
  return { ids, group }
}
