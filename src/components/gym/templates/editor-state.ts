/**
 * PURE editor-state helpers for the template builder — kept out of the component
 * so the list mutations (reorder, superset grouping, target edits) are unit-tested
 * without React. The editor holds a `DraftExercise[]`; on save it maps to the
 * EditorExerciseInput[] payload (positions re-indexed on the server too, but we
 * keep them dense here so the UI and the ghost-preview stay honest).
 */
import type {
  EditablePolicy,
  EditorExercise,
  EditorExerciseInput,
  EditorTemplateSet,
} from './types'

/** One row in the builder's working draft. Mirrors EditorExercise minus position
 *  (position is the array index) + a stable local key for React. */
export interface DraftExercise {
  /** Stable local key (survives reorder; not sent to the server). */
  key: string
  exerciseId: string
  name: string
  tracks: string
  preferredUnit: 'lb' | 'kg' | null
  targetSets: number | null
  targetReps: number | null
  targetWeight: number | null
  targetWeightUnit: 'lb' | 'kg'
  targetDurationS: number | null
  restSeconds: number | null
  restSecondsWarmup: number | null
  supersetGroup: number | null
  section: 'warmup' | 'main' | 'cooldown'
  sets: EditorTemplateSet[]
  progression: unknown
  notes: string | null
}

let keySeq = 0
/** A process-unique local key for a new draft row. */
export function nextDraftKey(): string {
  keySeq += 1
  return `d${keySeq}_${Math.random().toString(36).slice(2, 8)}`
}

/** Map a loaded EditorExercise into a draft row. */
export function toDraft(e: EditorExercise): DraftExercise {
  return {
    key: nextDraftKey(),
    exerciseId: e.exerciseId,
    name: e.name,
    tracks: e.tracks,
    preferredUnit: e.preferredUnit,
    targetSets: e.targetSets,
    targetReps: e.targetReps,
    targetWeight: e.targetWeight,
    targetWeightUnit: e.targetWeightUnit,
    targetDurationS: e.targetDurationS,
    restSeconds: e.restSeconds,
    restSecondsWarmup: e.restSecondsWarmup,
    supersetGroup: e.supersetGroup,
    section: e.section,
    sets: e.sets.map((set) => ({ ...set })),
    progression: e.progression ?? null,
    notes: e.notes,
  }
}

/** Build a fresh draft row for a just-added exercise (sane defaults per track). */
export function newDraft(input: {
  exerciseId: string
  name: string
  tracks: string
  preferredUnit?: 'lb' | 'kg' | null
  targetWeightUnit?: 'lb' | 'kg'
}): DraftExercise {
  const timed = input.tracks === 'time' || input.tracks === 'distance_time'
  const row: DraftExercise = {
    key: nextDraftKey(),
    exerciseId: input.exerciseId,
    name: input.name,
    tracks: input.tracks,
    preferredUnit: input.preferredUnit ?? null,
    targetSets: 3,
    targetReps: timed ? null : 10,
    targetWeight: null,
    targetWeightUnit: input.targetWeightUnit ?? 'lb',
    targetDurationS: null,
    restSeconds: null,
    restSecondsWarmup: null,
    supersetGroup: null,
    section: 'main',
    sets: [],
    progression: null,
    notes: null,
  }
  row.sets = resizeWorkingSets([], row.targetSets ?? 0, row)
  return row
}

/** Apply one scalar editor change without silently discarding the exact set list.
 * Scalar target edits intentionally affect working sets only; warmups retain their
 * own ramp values. Changing the working-set count trims/appends working rows while
 * preserving every surviving row's type, rest, side, distance, duration, and RPE. */
export function patchDraftExercise(
  row: DraftExercise,
  patch: Partial<DraftExercise>,
): DraftExercise {
  const next = { ...row, ...patch }
  let sets = row.sets.map((set) => ({ ...set }))

  if (Object.hasOwn(patch, 'targetSets')) {
    const count = next.targetSets == null ? 0 : Math.max(0, Math.trunc(next.targetSets))
    sets = resizeWorkingSets(sets, count, next)
  }
  if (Object.hasOwn(patch, 'targetReps')) {
    sets = mapWorkingSets(sets, (set) => ({ ...set, targetReps: next.targetReps }))
  }
  if (Object.hasOwn(patch, 'targetWeight') || Object.hasOwn(patch, 'targetWeightUnit')) {
    sets = mapWorkingSets(sets, (set) => ({
      ...set,
      targetWeight: next.targetWeight,
      targetWeightUnit: next.targetWeightUnit,
    }))
  }
  if (Object.hasOwn(patch, 'targetDurationS')) {
    sets = mapWorkingSets(sets, (set) => ({
      ...set,
      targetDurationS: next.targetDurationS,
    }))
  }

  return { ...next, sets: reindexSets(sets) }
}

function mapWorkingSets(
  sets: EditorTemplateSet[],
  update: (set: EditorTemplateSet) => EditorTemplateSet,
): EditorTemplateSet[] {
  return sets.map((set) => (set.setType === 'warmup' ? set : update(set)))
}

function resizeWorkingSets(
  sets: EditorTemplateSet[],
  targetCount: number,
  row: Pick<
    DraftExercise,
    'targetWeight' | 'targetWeightUnit' | 'targetReps' | 'targetDurationS'
  >,
): EditorTemplateSet[] {
  const workingCount = sets.filter((set) => set.setType !== 'warmup').length
  if (workingCount === targetCount) return reindexSets(sets)

  if (workingCount > targetCount) {
    let keep = targetCount
    return reindexSets(
      sets.filter((set) => {
        if (set.setType === 'warmup') return true
        if (keep <= 0) return false
        keep -= 1
        return true
      }),
    )
  }

  const lastWorking = [...sets].reverse().find((set) => set.setType !== 'warmup')
  const next = [...sets]
  for (let index = workingCount; index < targetCount; index += 1) {
    next.push({
      setNumber: next.length + 1,
      setType: 'normal',
      targetWeight: row.targetWeight ?? lastWorking?.targetWeight ?? null,
      targetWeightUnit: row.targetWeightUnit,
      targetReps: row.targetReps ?? lastWorking?.targetReps ?? null,
      targetDistanceM: lastWorking?.targetDistanceM ?? null,
      targetDurationS: row.targetDurationS ?? lastWorking?.targetDurationS ?? null,
      targetRpe: lastWorking?.targetRpe ?? null,
      restSeconds: lastWorking?.restSeconds ?? null,
      side: lastWorking?.side ?? null,
    })
  }
  return reindexSets(next)
}

function reindexSets(sets: EditorTemplateSet[]): EditorTemplateSet[] {
  return sets.map((set, index) => ({ ...set, setNumber: index + 1 }))
}

/** Move the row at `from` to `to`, returning a new array (bounds-clamped). */
export function moveRow<T>(rows: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= rows.length) return rows
  const clampedTo = Math.max(0, Math.min(rows.length - 1, to))
  const next = [...rows]
  const [moved] = next.splice(from, 1)
  next.splice(clampedTo, 0, moved!)
  return next
}

/**
 * Toggle a superset link between the row at `index` and the one BELOW it. If they
 * already share a group, ungroup the lower row (split); otherwise assign both the
 * lower's existing group, the upper's existing group, or a NEW group id (max+1) —
 * so "group with next" always merges adjacent rows into one opaque group id
 * (GYM_PLAN §3 semantics: same value ⇔ same group, ids never renumbered).
 */
export function toggleSupersetWithNext(rows: DraftExercise[], index: number): DraftExercise[] {
  if (index < 0 || index >= rows.length - 1) return rows
  const a = rows[index]!
  const b = rows[index + 1]!
  const next = [...rows]

  const linked = a.supersetGroup != null && a.supersetGroup === b.supersetGroup
  if (linked) {
    // Split: drop the LOWER row out of the group. If that leaves the upper row
    // as a singleton in its group, clear it too (a group of one is meaningless).
    const groupId = a.supersetGroup
    next[index + 1] = { ...b, supersetGroup: null }
    const remaining = next.filter((r) => r.supersetGroup === groupId).length
    if (remaining <= 1) {
      return next.map((r) => (r.supersetGroup === groupId ? { ...r, supersetGroup: null } : r))
    }
    return next
  }

  // Merge: reuse an existing adjacent group id, else mint a new one.
  const groupId = a.supersetGroup ?? b.supersetGroup ?? nextGroupId(rows)
  next[index] = { ...a, supersetGroup: groupId }
  next[index + 1] = { ...b, supersetGroup: groupId }
  return next
}

/** Replace one template superset/circuit with an arbitrary set of members.
 * Reuses the source row's existing opaque group when possible, moves rows out of
 * other groups, and clears any singleton left behind. */
export function setSupersetMembers(
  rows: DraftExercise[],
  sourceKey: string,
  selectedKeys: string[],
): DraftExercise[] {
  const selected = new Set(selectedKeys)
  if (selected.size < 2) return rows
  const source = rows.find((row) => row.key === sourceKey)
  if (!source) return rows
  const groupId = source.supersetGroup ?? nextGroupId(rows)

  let next = rows.map((row) => {
    if (selected.has(row.key)) return { ...row, supersetGroup: groupId }
    if (source.supersetGroup != null && row.supersetGroup === source.supersetGroup) {
      return { ...row, supersetGroup: null }
    }
    return row
  })

  const counts = new Map<number, number>()
  for (const row of next) {
    if (row.supersetGroup != null) {
      counts.set(row.supersetGroup, (counts.get(row.supersetGroup) ?? 0) + 1)
    }
  }
  next = next.map((row) =>
    row.supersetGroup != null && (counts.get(row.supersetGroup) ?? 0) < 2
      ? { ...row, supersetGroup: null }
      : row,
  )
  return next
}

/** The next unused superset group id (max existing + 1, or 1). */
export function nextGroupId(rows: DraftExercise[]): number {
  let max = 0
  for (const r of rows) if (r.supersetGroup != null && r.supersetGroup > max) max = r.supersetGroup
  return max + 1
}

/**
 * Derived A1/B1-style superset labels: within each group (in row order) the label
 * is `<groupLetter><ordinal>` — group A is the first group encountered, B the next,
 * etc.; the ordinal counts occurrences within that group. Rows with no group get
 * null. Pure + tested — labels are NEVER stored (GYM_PLAN §3).
 */
export function supersetLabels(rows: DraftExercise[]): Array<string | null> {
  const groupLetter = new Map<number, string>()
  const groupCount = new Map<number, number>()
  let letterIdx = 0
  const out: Array<string | null> = []
  for (const r of rows) {
    if (r.supersetGroup == null) {
      out.push(null)
      continue
    }
    let letter = groupLetter.get(r.supersetGroup)
    if (!letter) {
      letter = String.fromCharCode(65 + (letterIdx % 26))
      groupLetter.set(r.supersetGroup, letter)
      letterIdx += 1
    }
    const n = (groupCount.get(r.supersetGroup) ?? 0) + 1
    groupCount.set(r.supersetGroup, n)
    out.push(`${letter}${n}`)
  }
  return out
}

/** Map the draft rows → the save payload's exercise list (dense positions). */
export function draftToPayload(rows: DraftExercise[]): EditorExerciseInput[] {
  return rows.map((r, i) => ({
    exerciseId: r.exerciseId,
    position: i,
    targetSets: r.targetSets,
    targetReps: r.targetReps,
    targetWeight: r.targetWeight,
    targetWeightUnit: r.targetWeightUnit,
    targetDurationS: r.targetDurationS,
    restSeconds: r.restSeconds,
    restSecondsWarmup: r.restSecondsWarmup,
    supersetGroup: r.supersetGroup,
    section: r.section,
    sets: r.sets.map((set) => ({ ...set })),
    progression: r.progression ?? null,
    notes: r.notes,
  }))
}

/** True when a track uses duration (time / distance_time) rather than reps. */
export function isTimedTrack(tracks: string): boolean {
  return tracks === 'time' || tracks === 'distance_time'
}

/** Re-export the policy type union for the editor's convenience. */
export type { EditablePolicy }
