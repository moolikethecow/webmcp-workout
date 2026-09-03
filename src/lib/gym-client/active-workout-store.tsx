'use client'

/**
 * Active-workout optimistic store (GYM_PLAN §2.4, §4, P2a).
 *
 * The in-memory ActiveWorkout is the SINGLE SOURCE OF TRUTH for the logger UI. A
 * ✓ tap and every field edit mutate local state INSTANTLY and enqueue a
 * background write — the tap never awaits the network (the #1 kill risk, §9).
 * The write queue (write-queue.ts) coalesces + debounces + retries, mirrors the
 * unflushed queue to localStorage, and reconciles server-canonical rows back.
 *
 * Structural edits (add/remove/replace/reorder exercise) are direct awaited
 * calls (they need server-assigned ids), but we flush the set queue first so a
 * pending set write never lands against a stale exercise list.
 *
 * The store API is FIXED — A3 (Train tab + finish sheet) consumes it verbatim
 * via `useActiveWorkoutStore()`. Don't rename a method.
 *
 * ── ghost-commit semantics (Strong's one-tap) ──
 * Each set row carries `weight/reps/…` that may be null (untouched). The UI shows
 * the ghost (previous session's aligned set, else the progression target) as a
 * placeholder. `completeSet` on an UNTOUCHED row commits those ghosts as the
 * row's real values before marking it completed; a touched row commits what the
 * user entered. `addSet` clones the last row's *effective* values as the new
 * row's ghosts.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type {
  ActiveExercise,
  ActiveSet,
  ActiveWorkout,
  FinishSummary,
  SetField,
  SetType,
  SetUpsertPayload,
  SetsPutBody,
  SetsPutResponse,
  StrengthSideMode,
  SyncState,
  Unit,
} from './active-types'
import {
  StaleWorkoutRevisionError,
  WriteQueue,
  isStaleWorkoutRevisionError,
  readQueueMirror,
  type PendingQueueSnapshot,
} from './write-queue'
import {
  adjustRestState,
  restSecondsForSet,
  startRestState,
  type RestTimerState,
} from './rest-timer'
import { primeTimerAudio } from '@/lib/timers/chime'
import { useLiveRefresh } from '@/lib/stores/use-live-refresh'
import type { GripPatchInput } from '@/components/gym/logger/GripPicker'

// ── ghost resolution (pure; exported for tests) ──────────────────────────────

type GhostBucket = 'warmup' | 'working'

type LogicalRow = {
  logicalSetId?: string
  side?: 'left' | 'right' | null
  setType?: string | null
}

/** Group physical rows into the rounds the user thinks of as sets. New rows
 * always carry logicalSetId; the adjacent L/R fallback keeps pre-deploy cached
 * payloads aligned during rollout. */
export function logicalSetGroups<T extends LogicalRow>(rows: T[]): T[][] {
  const groups: T[][] = []
  const byId = new Map<string, T[]>()
  for (const row of rows) {
    if (row.logicalSetId) {
      const existing = byId.get(row.logicalSetId)
      if (existing) existing.push(row)
      else {
        const group = [row]
        byId.set(row.logicalSetId, group)
        groups.push(group)
      }
      continue
    }
    const previous = groups.at(-1)
    const previousRow = previous?.at(-1)
    if (
      previous?.length === 1 &&
      previousRow != null &&
      previousRow.logicalSetId == null &&
      previousRow.side != null &&
      row.side != null &&
      previousRow.side !== row.side &&
      (previousRow.setType ?? 'normal') === (row.setType ?? 'normal')
    ) {
      previous.push(row)
    } else {
      groups.push([row])
    }
  }
  return groups
}

/** One-based visual round number. Split rows intentionally return the same
 * number so the logger reads 1L / 1R instead of 1 / 2. */
export function logicalSetNumber(exercise: ActiveExercise, set: ActiveSet): number {
  const index = logicalSetGroups(exercise.sets).findIndex((group) => group.includes(set))
  return index >= 0 ? index + 1 : set.setNumber
}

/** Completed working rounds, used by collapse summaries and superset rotation. */
export function completedLogicalWorkingSets(sets: ActiveSet[]): number {
  return logicalSetGroups(sets.filter((set) => set.setType !== 'warmup'))
    .filter((group) => group.length > 0 && group.every((set) => set.completed))
    .length
}

function ghostBucket(setType: string | null | undefined): GhostBucket {
  return setType === 'warmup' ? 'warmup' : 'working'
}

function previousSetType(set: ActiveExercise['previous'][number]): string {
  // `setType` was added to the server contract with first-class warm-up history.
  // Keep the fallback for a cached/legacy payload hydrated across a deploy: an
  // untyped historical row was always treated as a working set.
  return (set as ActiveExercise['previous'][number] & { setType?: string }).setType ?? 'normal'
}

/** Resolve history + target ghosts by their ordinal within the warm-up or
 * working-set lane. Absolute set numbers shift whenever a warm-up is inserted;
 * ordinals do not. Keeping the lanes separate also guarantees a newly added,
 * blank warm-up can never inherit set 1's working weight. */
export function ghostSourcesFor(
  ex: ActiveExercise,
  setOrNumber: ActiveSet | number,
): {
  previous: ActiveExercise['previous'][number] | undefined
  target: ActiveExercise['targets'][number] | undefined
} {
  const current = typeof setOrNumber === 'number'
    ? ex.sets.find((set) => set.setNumber === setOrNumber)
    : setOrNumber
  const setNumber = typeof setOrNumber === 'number' ? setOrNumber : setOrNumber.setNumber
  const currentIndex = current ? ex.sets.indexOf(current) : -1

  let bucket: GhostBucket
  let ordinal: number
  if (currentIndex >= 0) {
    bucket = ghostBucket(ex.sets[currentIndex]!.setType)
    const lane = ex.sets.filter((set) => ghostBucket(set.setType) === bucket)
    ordinal = logicalSetGroups(lane).findIndex((group) => group.includes(current!))
  } else {
    // `ghostFor` is also used by pure helpers before a virtual target has been
    // materialized. Infer its lane/ordinal from the exact numbered target, then
    // fall back to the historical row and finally the legacy working-set rule.
    const targetIndex = ex.targets.findIndex(
      (target, index) => (target.setNumber ?? index + 1) === setNumber,
    )
    if (targetIndex >= 0) {
      bucket = ghostBucket(ex.targets[targetIndex]!.setType)
      const target = ex.targets[targetIndex]!
      ordinal = logicalSetGroups(
        ex.targets.filter((candidate) => ghostBucket(candidate.setType) === bucket),
      ).findIndex((group) => group.includes(target))
    } else {
      const previousIndex = ex.previous.findIndex((set) => set.setNumber === setNumber)
      if (previousIndex >= 0) {
        bucket = ghostBucket(previousSetType(ex.previous[previousIndex]!))
        const previous = ex.previous[previousIndex]!
        ordinal = logicalSetGroups(
          ex.previous.filter((candidate) => ghostBucket(previousSetType(candidate)) === bucket),
        ).findIndex((group) => group.includes(previous))
      } else {
        bucket = 'working'
        ordinal = Math.max(0, setNumber - 1)
      }
    }
  }

  const side = current?.side ?? null
  const selectSide = <T extends LogicalRow>(group: T[] | undefined): T | undefined => {
    if (!group) return undefined
    if (side != null) return group.find((row) => row.side === side) ?? group.find((row) => row.side == null) ?? group[0]
    return group.find((row) => row.side == null) ?? group[0]
  }
  const previousGroups = logicalSetGroups(
    ex.previous.filter((set) => ghostBucket(previousSetType(set)) === bucket),
  )
  const targetGroups = logicalSetGroups(
    ex.targets.filter((target) => ghostBucket(target.setType) === bucket),
  )

  return {
    previous: selectSide(previousGroups[Math.max(0, ordinal)]),
    target: selectSide(targetGroups[Math.max(0, ordinal)]),
  }
}

/**
 * The most recent set of THIS exercise already logged in THIS session, in the
 * same lane — the value a straight set almost always repeats (#1878).
 *
 * Straight-set work means sets 2 and 3 match set 1, and the template target is
 * often stale the moment the load is adjusted: the user's 2026-08-31 session had a
 * template saying 105 lb, he worked 90, and then retyped 90×10 twice more
 * against a ghost still showing 105. Prefilling from what actually happened is
 * strictly better information than prefilling from what was planned.
 *
 * Three sources are deliberately skipped:
 *  - sets that are not COMPLETED — a blank row below is not evidence of
 *    anything, and would blank the ghost for every row under it.
 *  - the other lane — a warm-up must never inherit a working weight, which is
 *    the same reason ghost lanes exist at all.
 *  - drop and backoff sets, as SOURCES. They are deliberately lighter, so
 *    sourcing from one would drag every set after it down. They still RECEIVE
 *    a prefill, and stay freely editable.
 */
function loggedThisSession(
  ex: ActiveExercise,
  setOrNumber: ActiveSet | number,
  field: SetField,
): number | null {
  const current =
    typeof setOrNumber === 'number'
      ? ex.sets.find((set) => set.setNumber === setOrNumber)
      : setOrNumber
  if (!current) return null
  const index = ex.sets.indexOf(current)
  if (index <= 0) return null

  const bucket = ghostBucket(current.setType)
  const side = current.side ?? null

  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = ex.sets[i]!
    if (!candidate.completed) continue
    if (ghostBucket(candidate.setType) !== bucket) continue
    if (bucket === 'working' && candidate.setType !== 'normal') continue
    // A split L/R round: left prefills from left, right from right.
    if (side != null && candidate.side != null && candidate.side !== side) continue
    const value = readField(candidate, field)
    if (value != null) return value
  }
  return null
}

/** The effective ghost for a set field: the same-lane previous-session value,
 * else the same-lane progression target. Returns null when no ghost exists. */
export function ghostFor(
  ex: ActiveExercise,
  setOrNumber: ActiveSet | number,
  field: SetField,
): number | null {
  // What just happened in this session outranks both last session and the
  // template — see loggedThisSession. RPE is excluded: it is a judgement about
  // one set, not a value that repeats.
  if (field !== 'rpe') {
    const live = loggedThisSession(ex, setOrNumber, field)
    if (live != null) return live
  }

  const { previous: prev, target } = ghostSourcesFor(ex, setOrNumber)
  switch (field) {
    case 'weight':
      return prev?.weight ?? target?.weight ?? null
    case 'reps':
      return prev?.reps ?? target?.reps ?? null
    case 'durationS':
      return prev?.durationS ?? target?.durationS ?? null
    case 'distanceM':
      return prev?.distanceM ?? null
    case 'rpe':
      return null
  }
}

/** The value a field will COMMIT to: the entered value if present, else the ghost. */
export function committedValue(
  ex: ActiveExercise,
  set: ActiveSet,
  field: SetField,
): number | null {
  const entered = readField(set, field)
  if (entered != null) return entered
  return ghostFor(ex, set, field)
}

function readField(set: ActiveSet, field: SetField): number | null {
  switch (field) {
    case 'weight':
      return set.weight
    case 'reps':
      return set.reps
    case 'durationS':
      return set.durationS
    case 'distanceM':
      return set.distanceM
    case 'rpe':
      return set.rpe
  }
}

function withField(set: ActiveSet, field: SetField, value: number | null): ActiveSet {
  switch (field) {
    case 'weight':
      return { ...set, weight: value }
    case 'reps':
      return { ...set, reps: value }
    case 'durationS':
      return { ...set, durationS: value }
    case 'distanceM':
      return { ...set, distanceM: value }
    case 'rpe':
      return { ...set, rpe: value }
  }
}

/** Which fields a `tracks` shape commits on ✓ (so ghost-commit fills the right ones). */
export function fieldsForTracks(tracks: string): SetField[] {
  switch (tracks) {
    case 'weight_reps':
    case 'weighted_bodyweight':
    case 'assisted_bodyweight':
      return ['weight', 'reps']
    case 'reps':
      return ['reps']
    case 'time':
      return ['weight', 'durationS']
    case 'distance_time':
      return ['distanceM', 'durationS']
    default:
      return ['weight', 'reps']
  }
}

// ── set → queue payload ──────────────────────────────────────────────────────

function toPayload(workoutExerciseId: string, set: ActiveSet, unit: Unit): SetUpsertPayload {
  return {
    clientSetId: set.clientSetId!, // store-created sets always carry one
    logicalSetId: set.logicalSetId,
    workoutExerciseId,
    setNumber: set.setNumber,
    setType: set.setType as SetType,
    weight: set.weight,
    weightUnit: (set.weightUnit as Unit) || unit,
    reps: set.reps,
    distanceM: set.distanceM,
    durationS: set.durationS,
    rpe: set.rpe,
    // undefined preserves a server-side prescription on legacy hydration;
    // explicit null means "inherit" and clears a prior override.
    restSeconds: set.restSeconds,
    side: set.side,
    completed: set.completed,
  }
}

function newSet(
  setNumber: number,
  unit: Unit,
  side: 'left' | 'right' | null = null,
  logicalSetId = crypto.randomUUID(),
): ActiveSet {
  return {
    clientSetId: crypto.randomUUID(),
    logicalSetId,
    setNumber,
    setType: 'normal',
    weight: null,
    weightUnit: unit,
    reps: null,
    distanceM: null,
    durationS: null,
    rpe: null,
    restSeconds: null,
    side,
    completed: false,
  }
}

/** Ensure every set in an exercise has a clientSetId (server hydration may carry
 *  null for imported sets — the store owns id assignment for anything it touches). */
function ensureIds(ex: ActiveExercise): ActiveExercise {
  let mutated = false
  const sets: ActiveSet[] = []
  for (const s of ex.sets) {
    let next = s
    if (!s.clientSetId) {
      mutated = true
      next = { ...next, clientSetId: crypto.randomUUID() }
    }
    if (!(s as ActiveSet & { logicalSetId?: string }).logicalSetId) {
      mutated = true
      const previous = sets.at(-1)
      const previousId = previous &&
        previous.side != null &&
        s.side != null &&
        previous.side !== s.side &&
        (previous.setType ?? 'normal') === (s.setType ?? 'normal')
        ? previous.logicalSetId
        : null
      next = { ...next, logicalSetId: previousId ?? crypto.randomUUID() }
    }
    sets.push(next)
  }
  const loadBasis = (ex as ActiveExercise & { loadBasis?: 'total' | 'per_side' }).loadBasis ?? 'total'
  if (loadBasis !== ex.loadBasis) mutated = true
  return mutated ? { ...ex, loadBasis, sets } : ex
}

function inferStrengthSideMode(exercise: ActiveExercise): StrengthSideMode {
  if (exercise.modality !== 'strength' || exercise.loadBasis !== 'per_side') return 'both'
  const working = exercise.sets.filter((set) => set.setType !== 'warmup')
  const group = logicalSetGroups(working.length > 0 ? working : exercise.sets).at(-1)
  if (!group || group.length === 0) return 'both'
  if (group.some((set) => set.side === 'left') && group.some((set) => set.side === 'right')) {
    return 'split'
  }
  if (group[0]?.side === 'left') return 'left'
  if (group[0]?.side === 'right') return 'right'
  return 'both'
}

function isEmptyLogicalGroup(group: ActiveSet[]): boolean {
  return group.length > 0 && group.every((set) =>
    !set.completed &&
    set.weight == null &&
    set.reps == null &&
    set.distanceM == null &&
    set.durationS == null &&
    set.rpe == null,
  )
}

/** Re-shape only untouched, incomplete strength rounds. A mode switch never
 * rewrites completed work or a row the user has started typing into. */
function reshapeEmptyStrengthGroups(
  exercise: ActiveExercise,
  mode: StrengthSideMode,
): { exercise: ActiveExercise; deletedClientSetIds: string[] } {
  if (exercise.modality !== 'strength' || exercise.loadBasis !== 'per_side') {
    return { exercise, deletedClientSetIds: [] }
  }

  const deletedClientSetIds: string[] = []
  const groups = logicalSetGroups(exercise.sets)
  const reshaped = groups.flatMap((group) => {
    if (!isEmptyLogicalGroup(group)) return group
    const template = group[0]!
    const logicalSetId = template.logicalSetId || crypto.randomUUID()
    const desiredSides: Array<'left' | 'right' | null> =
      mode === 'split' ? ['left', 'right'] : mode === 'left' ? ['left'] : mode === 'right' ? ['right'] : [null]
    const keptIds = new Set<string>()
    const rows = desiredSides.map((side, index) => {
      const sameSide = group.find((set) => set.side === side && !keptIds.has(set.clientSetId ?? ''))
      const source = sameSide ?? group.find((set) => !keptIds.has(set.clientSetId ?? ''))
      if (source?.clientSetId) keptIds.add(source.clientSetId)
      return {
        ...(source ?? template),
        clientSetId: source?.clientSetId ?? crypto.randomUUID(),
        logicalSetId,
        side,
      }
    })
    for (const old of group) {
      if (old.clientSetId && !keptIds.has(old.clientSetId)) deletedClientSetIds.push(old.clientSetId)
    }
    return rows
  })
  const sets = reshaped.map((set, index) => ({ ...set, setNumber: index + 1 }))
  return { exercise: { ...exercise, sets }, deletedClientSetIds }
}

function hydrate(w: ActiveWorkout): ActiveWorkout {
  return { ...w, exercises: w.exercises.map(ensureIds) }
}

/** Layer the logger's unsaved actual rows over a freshly-read canonical workout.
 * The agent's structural/prescription changes remain in the server model; matching
 * logger rows keep the user's newest entered values, and rows added on either side are
 * retained. The returned queue snapshot is the exact union that can safely CAS
 * against the freshly-read revision. */
function rebasePendingSnapshot(
  server: ActiveWorkout,
  pending: PendingQueueSnapshot,
): { workout: ActiveWorkout; pending: PendingQueueSnapshot } {
  const deletes = new Set(pending.deletes)
  const dirtyByExercise: Record<string, SetUpsertPayload[]> = {}
  const baseByExercise: Record<string, SetUpsertPayload[]> = {}
  const exerciseIdByExercise: Record<string, string> = {}
  const exercises = server.exercises.map((exercise) => {
    const localRows = pending.dirtyByExercise[exercise.workoutExerciseId]
    const serverRows = exercise.sets.filter((set) => !set.clientSetId || !deletes.has(set.clientSetId))
    if (!localRows) return { ...exercise, sets: serverRows }

    const queuedExerciseId = pending.exerciseIdByExercise[exercise.workoutExerciseId]
    if (queuedExerciseId && queuedExerciseId !== exercise.exerciseId) {
      // The agent replaced the movement while this client still had old-movement
      // rows queued. Never attach those rows to the replacement merely because
      // the workout_exercise id was intentionally retained.
      return { ...exercise, sets: serverRows }
    }

    const baseRows = pending.baseByExercise[exercise.workoutExerciseId]
    const baseById = new Map(baseRows?.map((row) => [row.clientSetId, row]) ?? [])
    const serverById = new Map(
      serverRows.flatMap((row) => row.clientSetId ? [[row.clientSetId, row] as const] : []),
    )
    const merged = [...serverRows]
    const mergedIndex = new Map(
      merged.flatMap((row, index) => row.clientSetId ? [[row.clientSetId, index] as const] : []),
    )

    for (const local of localRows) {
      if (deletes.has(local.clientSetId)) continue
      const base = baseById.get(local.clientSetId)
      const canonical = serverById.get(local.clientSetId)
      const rebased = base
        ? applyLocalSetDelta(local, base, canonical)
        : canonical
          // A pre-revision mirror has no base. Preserve it once for rollout;
          // every newly-written mirror takes the field-delta branch above.
          ? activeSetFromPayload(local, canonical)
          : activeSetFromPayload(local)
      if (!rebased) continue
      const at = mergedIndex.get(local.clientSetId)
      if (at == null) {
        mergedIndex.set(local.clientSetId, merged.length)
        merged.push(rebased)
      } else {
        merged[at] = rebased
      }
    }

    merged.sort((left, right) => left.setNumber - right.setNumber)
    const reindexed = merged.map((set, index) => ({ ...set, setNumber: index + 1 }))
    dirtyByExercise[exercise.workoutExerciseId] = reindexed.map((set) =>
      toPayload(exercise.workoutExerciseId, set, exercise.preferredUnit as Unit),
    )
    baseByExercise[exercise.workoutExerciseId] = exercise.sets.map((set) =>
      toPayload(exercise.workoutExerciseId, set, exercise.preferredUnit as Unit),
    )
    exerciseIdByExercise[exercise.workoutExerciseId] = exercise.exerciseId
    return { ...exercise, sets: reindexed }
  })

  return {
    workout: { ...server, exercises },
    pending: {
      dirtyByExercise,
      baseByExercise,
      exerciseIdByExercise,
      deletes: pending.deletes,
    },
  }
}

/** Idle window before a typed note is persisted. Long enough that a normal cue
 *  is one write, short enough that a backgrounded PWA loses nothing. */
const NOTES_PERSIST_DEBOUNCE_MS = 900

const REBASABLE_SET_FIELDS = [
  'setNumber',
  'logicalSetId',
  'setType',
  'weight',
  'weightUnit',
  'reps',
  'distanceM',
  'durationS',
  'rpe',
  'restSeconds',
  'side',
  'completed',
] as const satisfies ReadonlyArray<keyof SetUpsertPayload>

/** Return the canonical row with only fields genuinely changed by the logger.
 * When the agent removed a row, an actually-edited local row is restored; an
 * untouched copy of the old row stays removed. */
function applyLocalSetDelta(
  local: SetUpsertPayload,
  base: SetUpsertPayload,
  canonical: ActiveSet | undefined,
): ActiveSet | null {
  const changed = REBASABLE_SET_FIELDS.filter((field) => !Object.is(local[field], base[field]))
  if (changed.length === 0) return canonical ?? null
  const merged: SetUpsertPayload = canonical
    ? {
        ...toPayload(local.workoutExerciseId, canonical, canonical.weightUnit as Unit),
        clientSetId: local.clientSetId,
        workoutExerciseId: local.workoutExerciseId,
      }
    : { ...base }
  const source = local as unknown as Record<string, unknown>
  const target = merged as unknown as Record<string, unknown>
  for (const field of changed) target[field] = source[field]
  return activeSetFromPayload(merged, canonical)
}

function activeSetFromPayload(payload: SetUpsertPayload, base?: ActiveSet): ActiveSet {
  return {
    clientSetId: payload.clientSetId,
    logicalSetId: payload.logicalSetId ?? base?.logicalSetId ?? payload.clientSetId,
    setNumber: payload.setNumber,
    setType: payload.setType ?? base?.setType ?? 'normal',
    weight: payload.weight !== undefined ? payload.weight : (base?.weight ?? null),
    weightUnit: payload.weightUnit ?? base?.weightUnit ?? 'lb',
    reps: payload.reps !== undefined ? payload.reps : (base?.reps ?? null),
    distanceM: payload.distanceM !== undefined ? payload.distanceM : (base?.distanceM ?? null),
    durationS: payload.durationS !== undefined ? payload.durationS : (base?.durationS ?? null),
    rpe: payload.rpe !== undefined ? payload.rpe : (base?.rpe ?? null),
    restSeconds:
      payload.restSeconds !== undefined ? payload.restSeconds : (base?.restSeconds ?? null),
    side: payload.side !== undefined ? payload.side : (base?.side ?? null),
    completed: payload.completed ?? base?.completed ?? false,
  }
}

function defaultDisplayUnit(w: ActiveWorkout): Unit {
  if (w.weightUnit === 'kg' || w.weightUnit === 'lb') return w.weightUnit
  return w.exercises[0]?.preferredUnit === 'kg' ? 'kg' : 'lb'
}

// ── store API (FIXED — A3 consumes verbatim) ─────────────────────────────────

export interface ActiveWorkoutStore {
  workout: ActiveWorkout | null
  loading: boolean
  syncState: SyncState
  pendingCount: number
  elapsedSeconds: number
  /**
   * Live rest countdown (GYM_PLAN §4), or null when no rest is running. Started
   * automatically when a WORKING set is completed (warmup sets use the exercise's
   * warmup rest when configured). Timestamp-math: read remaining via rest-timer.ts
   * helpers against `nowMs`. In-memory only — a reload mid-rest loses it (accepted,
   * §7: no localStorage for timer state).
   */
  restTimer: RestTimerState | null
  /** Monotonic `Date.now()` sample that advances ~1s while a workout is active —
   *  the tick source for both the elapsed clock and the rest ring (throttle-proof). */
  nowMs: number
  /**
   * Workout-level display unit override (GYM_PLAN §8). null = follow each exercise's
   * preferredUnit; 'lb'|'kg' = force that unit for DISPLAY across the whole session
   * (ghosts, committed values, steppers). NEVER mutates stored set values (tested).
   */
  displayUnit: Unit | null
  /** Start (or restart) the rest countdown for an exercise, `seconds` from now. */
  startRest: (exerciseId: string, seconds: number) => void
  /** Nudge the running rest by ±seconds (+30 / −15). Empties → clears the timer. */
  adjustRest: (deltaSeconds: number) => void
  /** Cancel the running rest immediately. */
  skipRest: () => void
  /** Set the workout-level display-unit override (null clears → per-exercise pref). */
  setDisplayUnit: (unit: Unit | null) => void
  /**
   * Prime the rest-alert AudioContext from a user gesture (the first ✓/tap of the
   * workout). Best-effort; safe to call repeatedly. Wired into completeSet so the
   * first set completion unlocks audio for the end-of-rest chime.
   */
  primeAudio: () => void
  /**
   * Probe the server for an active workout (hydrates the store). Resolves void —
   * read `store.workout` for the result (this matches A3's store-contract mirror).
   */
  probe: () => Promise<void>
  /** Queue-safe canonical refresh for an already-open logger. Unlike the mount
   * probe, this never replays the localStorage mirror a second time. */
  refresh: () => Promise<void>
  /**
   * Start a workout. A 409 (an active workout already exists) is handled INSIDE
   * the store — it probes + hydrates the existing session so the UI resumes it,
   * and resolves normally (no throw). Read `store.workout` for the result.
   */
  start: (from: 'template' | 'empty' | 'repeat_last', templateId?: string) => Promise<void>
  completeSet: (workoutExerciseId: string, clientSetId: string) => void
  updateSetField: (clientSetId: string, field: SetField, value: number | null) => void
  /** Override rest after one exact set; null returns to warmup/working fallback. */
  updateSetRest: (clientSetId: string, seconds: number | null) => void
  /**
   * Set the weight UNIT a set was entered in (GYM_PLAN §8). Called by the numeric
   * pad when a weight is entered under a workout-level display-unit override so the
   * row records the value in the unit it was typed — keeping the stored-as-entered
   * invariant honest (a toggle changes DISPLAY; typing under a toggle changes the
   * entered unit for THAT row only).
   */
  setSetWeightUnit: (clientSetId: string, unit: Unit) => void
  /** Current authoring mode for a per-side strength movement. */
  sideModeFor: (workoutExerciseId: string) => StrengthSideMode
  /** Change how future logical rounds are authored; only untouched placeholders
   * are re-shaped to match the newly selected mode. */
  setSideMode: (workoutExerciseId: string, mode: StrengthSideMode) => void
  /** Apply a catalog load-basis edit immediately while the canonical active
   * workout refreshes in the background. This does not enqueue set writes. */
  updateExerciseLoadBasis: (workoutExerciseId: string, loadBasis: 'total' | 'per_side') => void
  addSet: (workoutExerciseId: string) => void
  /** Insert one opt-in warm-up row before the working sets. */
  addWarmupSet: (workoutExerciseId: string) => void
  deleteSet: (clientSetId: string) => void
  cycleSetType: (clientSetId: string, type: SetType) => void
  addExercise: (exerciseId: string) => Promise<void>
  removeExercise: (workoutExerciseId: string) => Promise<void>
  /** `keepPrescription` (#1876) carries the replaced exercise's prescribed
   *  load/reps forward as the new exercise's ghost target instead of the
   *  default blank slate — the logger asks before setting it. */
  replaceExercise: (
    workoutExerciseId: string,
    newExerciseId: string,
    keepPrescription?: boolean,
  ) => Promise<void>
  /** Move an exercise to a zero-based visual position. The store writes a full,
   * contiguous order in one structural request so two rows can never share a
   * position after an in-workout move. */
  reorderExercise: (workoutExerciseId: string, position: number) => Promise<void>
  /**
   * Set (or clear) the superset group for one or more exercises (GYM_PLAN §4
   * supersets). Batched through the existing POST /exercises {superset:[…]} op.
   * A non-null call treats `workoutExerciseIds` as the group's complete desired
   * membership and clears singleton groups left behind, atomically.
   */
  setSupersetGroup: (workoutExerciseIds: string[], group: number | null) => Promise<void>
  /** Type into a per-exercise note. Applies locally at once and schedules a
   * debounced persist; `commitExerciseNotes` forces the write (blur/finish). */
  updateExerciseNotes: (workoutExerciseId: string, notes: string) => void
  /** Record how an exercise is being held; every set inherits it. */
  setExerciseGrip: (workoutExerciseId: string, patch: GripPatchInput) => Promise<void>
  /** Flush any pending note edits now. Safe to call with nothing pending. */
  commitExerciseNotes: () => Promise<void>
  /** Persist this exercise's note AND promote it to the source template. */
  saveExerciseNoteToTemplate: (workoutExerciseId: string) => Promise<void>
  updateHeader: (patch: { name?: string; notes?: string }) => Promise<void>
  finish: () => Promise<FinishSummary>
  discard: () => Promise<void>
}

const StoreContext = createContext<ActiveWorkoutStore | null>(null)

/** Consume the active-workout store. Throws outside a provider. */
export function useActiveWorkoutStore(): ActiveWorkoutStore {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useActiveWorkoutStore must be used within <ActiveWorkoutProvider>')
  return ctx
}

// ── network (injectable for tests) ───────────────────────────────────────────

export interface ActiveWorkoutApi {
  getActive: () => Promise<ActiveWorkout | { active: null }>
  start: (
    from: string,
    templateId?: string,
  ) => Promise<{ workout?: ActiveWorkout; conflict?: string }>
  putSets: (
    workoutId: string,
    body: SetsPutBody,
  ) => Promise<SetsPutResponse>
  editExercises: (
    workoutId: string,
    edits: Record<string, unknown>,
    expectedRevision: number,
  ) => Promise<ActiveWorkout>
  patchMeta: (workoutId: string, patch: { name?: string; notes?: string }) => Promise<ActiveWorkout>
  finish: (workoutId: string) => Promise<FinishSummary>
  discard: (workoutId: string) => Promise<void>
}

async function throwWorkoutApiError(res: Response, fallback: string): Promise<never> {
  if (res.status === 409) {
    const body = (await res.clone().json().catch(() => null)) as { code?: unknown } | null
    if (body?.code === 'stale_revision') throw new StaleWorkoutRevisionError()
  }
  throw new Error(`${fallback} → ${res.status}`)
}

/** The default API — plain fetch against the P2a gym routes. */
export const defaultActiveWorkoutApi: ActiveWorkoutApi = {
  async getActive() {
    const res = await fetch('/api/gym/workouts/active')
    if (!res.ok) throw new Error(`GET /active → ${res.status}`)
    return res.json()
  },
  async start(from, templateId) {
    const res = await fetch('/api/gym/workouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, templateId }),
    })
    if (res.status === 409) {
      const body = (await res.json()) as { activeWorkoutId: string }
      return { conflict: body.activeWorkoutId }
    }
    if (!res.ok) throw new Error(`POST /workouts → ${res.status}`)
    return { workout: (await res.json()) as ActiveWorkout }
  },
  async putSets(workoutId, body) {
    const res = await fetch(`/api/gym/workouts/${workoutId}/sets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) await throwWorkoutApiError(res, 'PUT /sets')
    return res.json()
  },
  async editExercises(workoutId, edits, expectedRevision) {
    const res = await fetch(`/api/gym/workouts/${workoutId}/exercises`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...edits, expectedRevision }),
    })
    if (!res.ok) await throwWorkoutApiError(res, 'POST /exercises')
    return res.json()
  },
  async patchMeta(workoutId, patch) {
    const res = await fetch(`/api/gym/workouts/${workoutId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error(`PATCH /workouts → ${res.status}`)
    return res.json()
  },
  async finish(workoutId) {
    const res = await fetch(`/api/gym/workouts/${workoutId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'finish' }),
    })
    if (!res.ok) throw new Error(`finish → ${res.status}`)
    return res.json()
  },
  async discard(workoutId) {
    const res = await fetch(`/api/gym/workouts/${workoutId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'discard' }),
    })
    if (!res.ok) throw new Error(`discard → ${res.status}`)
  },
}

// ── provider ─────────────────────────────────────────────────────────────────

export function ActiveWorkoutProvider({
  children,
  api = defaultActiveWorkoutApi,
  /** Skip the mount probe (tests that seed state manually). */
  autoProbe = true,
}: {
  children: ReactNode
  api?: ActiveWorkoutApi
  autoProbe?: boolean
}) {
  const [workout, setWorkout] = useState<ActiveWorkout | null>(null)
  const [loading, setLoading] = useState(autoProbe)
  const [syncState, setSyncState] = useState<SyncState>('saved')
  const [pendingCount, setPendingCount] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  // Rest timer (in-memory only — a reload mid-rest loses it, §7). A hydrated
  // workout seeds displayUnit from the canonical app preference; tapping the pill
  // remains a display-only session override.
  const [restTimer, setRestTimer] = useState<RestTimerState | null>(null)
  const [displayUnit, setDisplayUnitState] = useState<Unit | null>(null)
  const [sideModes, setSideModes] = useState<Record<string, StrengthSideMode>>({})
  const sideModesRef = useRef(sideModes)
  sideModesRef.current = sideModes

  // The live workout is the source of truth for both render AND the queue's
  // payload builder — keep a ref so callbacks read the latest without re-binding.
  const workoutRef = useRef<ActiveWorkout | null>(null)
  workoutRef.current = workout

  const queueRef = useRef<WriteQueue | null>(null)
  const conflictRecoveryRef = useRef<(() => Promise<void>) | null>(null)
  const refreshRequestRef = useRef(0)
  /** workoutExerciseId → the newest typed note not yet confirmed by the server. */
  const notesDraftRef = useRef<Map<string, string>>(new Map())
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setVisibleWorkout = useCallback((next: ActiveWorkout | null) => {
    workoutRef.current = next
    setWorkout(next)
  }, [])

  /** Reconcile a successful set CAS without letting an older ack clobber a
   * newer optimistic edit that entered the queue while the request was open. */
  const reconcile = useCallback((res: SetsPutResponse) => {
    const cur = workoutRef.current
    if (!cur) return
    const exercises = cur.exercises.map((ex) => {
      const server = res.byExercise[ex.workoutExerciseId]
      if (!server) return ex
      if (queueRef.current?.hasPendingFor(ex.workoutExerciseId)) return ex
      const byId = new Map(server.map((set) => [set.clientSetId, set]))
      const merged = ex.sets.map((local) => byId.get(local.clientSetId) ?? local)
      for (const set of server) {
        if (!merged.some((local) => local.clientSetId === set.clientSetId)) merged.push(set)
      }
      return { ...ex, sets: merged }
    })
    setVisibleWorkout({ ...cur, revision: res.revision, exercises })
  }, [setVisibleWorkout])

  const bumpPending = useCallback(() => {
    setPendingCount(queueRef.current?.pendingCount() ?? 0)
  }, [])

  // ── queue lifecycle (one per workout id) ───────────────────────────────────
  const ensureQueue = useCallback(
    (workoutId: string, initialRevision: number): WriteQueue => {
      if (queueRef.current) return queueRef.current
      const q = new WriteQueue(workoutId, {
        put: (body) => api.putSets(workoutId, body),
        initialRevision,
        onAck: (res: SetsPutResponse) => reconcile(res),
        onConflict: () => conflictRecoveryRef.current?.(),
        onSyncStateChange: (s) => {
          setSyncState(s)
          setPendingCount(q.pendingCount())
        },
      })
      queueRef.current = q
      return q
    },
    [api, reconcile],
  )

  const teardownQueue = useCallback(() => {
    queueRef.current?.close()
    queueRef.current = null
    if (notesTimerRef.current != null) {
      clearTimeout(notesTimerRef.current)
      notesTimerRef.current = null
    }
    notesDraftRef.current.clear()
    setSyncState('saved')
    setPendingCount(0)
  }, [])

  /** Canonical reload used by mount probing, post-agent live refresh, and typed
   * revision-conflict recovery. It rebases unsaved logger intent instead of
   * replacing it or blindly replaying an obsolete generation. */
  const refreshCanonical = useCallback(
    async ({ flushPending = true, replayMirror = false } = {}): Promise<void> => {
      const requestId = ++refreshRequestRef.current
      const response = await api.getActive()
      if (requestId !== refreshRequestRef.current) return
      const active = 'active' in response && response.active === null
        ? null
        : hydrate(response as ActiveWorkout)
      if (!active) {
        setVisibleWorkout(null)
        setDisplayUnitState(null)
        setSideModes({})
        teardownQueue()
        return
      }

      const priorId = workoutRef.current?.id
      if (queueRef.current && priorId && priorId !== active.id) teardownQueue()
      const queue = ensureQueue(active.id, active.revision)
      if (replayMirror) queue.replayMirror(readQueueMirror(), false)

      const rebased = rebasePendingSnapshot(active, queue.pendingSnapshot())
      queue.replacePendingAtRevision(active.revision, rebased.pending)
      setVisibleWorkout(rebased.workout)
      if (displayUnit == null || priorId !== active.id) {
        setDisplayUnitState(defaultDisplayUnit(active))
      }
      bumpPending()
      if (flushPending && queue.pendingCount() > 0) {
        await queue.flush()
        bumpPending()
      }
    },
    [api, bumpPending, displayUnit, ensureQueue, setVisibleWorkout, teardownQueue],
  )

  conflictRecoveryRef.current = () => refreshCanonical({ flushPending: false })

  /** Enqueue one exercise's set array FROM AN EXPLICIT workout snapshot.
   *  Mutators must pass the state they just computed — `workoutRef.current` is
   *  stale until the next render, and the ✓ tap flushes synchronously (the
   *  prod-caught bug: a stale snapshot sent completed:false, then the ack echo
   *  reverted the optimistic ✓). */
  const enqueueExerciseFrom = useCallback(
    (
      w: ActiveWorkout,
      workoutExerciseId: string,
      flushNow = false,
      baseWorkout?: ActiveWorkout | null,
    ) => {
      const ex = w.exercises.find((e) => e.workoutExerciseId === workoutExerciseId)
      if (!ex) return
      const baseExercise = baseWorkout?.exercises.find(
        (candidate) => candidate.workoutExerciseId === workoutExerciseId,
      )
      const q = ensureQueue(w.id, w.revision)
      q.enqueue(
        workoutExerciseId,
        ex.sets.map((s) => toPayload(workoutExerciseId, s, ex.preferredUnit as Unit)),
        baseExercise?.sets.map((set) =>
          toPayload(workoutExerciseId, set, baseExercise.preferredUnit as Unit),
        ),
        ex.exerciseId,
      )
      bumpPending()
      if (flushNow) void q.flush().finally(bumpPending)
    },
    [ensureQueue, bumpPending],
  )

  /** Apply a pure workout transform, sync the ref SYNCHRONOUSLY (so any
   *  immediate flush snapshots the new state), then optionally enqueue the
   *  touched exercise from that same next state. All set mutators route here. */
  const mutateWorkout = useCallback(
    (
      fn: (cur: ActiveWorkout) => ActiveWorkout,
      enqueueId?: string | null,
      flushNow = false,
    ) => {
      const cur = workoutRef.current
      if (!cur) return
      const next = fn(cur)
      workoutRef.current = next
      setWorkout(next)
      if (enqueueId) enqueueExerciseFrom(next, enqueueId, flushNow, cur)
    },
    [enqueueExerciseFrom],
  )

  // ── elapsed timer (ticks from startedAt) ───────────────────────────────────
  useEffect(() => {
    if (!workout) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [workout?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const elapsedSeconds = useMemo(() => {
    if (!workout) return 0
    const started = new Date(workout.startedAt).getTime()
    if (Number.isNaN(started)) return 0
    return Math.max(0, Math.floor((now - started) / 1000))
  }, [workout, now])

  // ── mount probe + mirror replay ────────────────────────────────────────────
  const probe = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      await refreshCanonical({ replayMirror: true })
    } finally {
      setLoading(false)
    }
  }, [refreshCanonical])

  const refresh = useCallback(async (): Promise<void> => {
    await refreshCanonical()
  }, [refreshCanonical])

  // Every agent surface invalidates `gym` after an executed
  // gym mutation. Re-read immediately so the agent's change appears in the
  // open logger; refreshCanonical preserves/rebases any local values still in
  // the optimistic queue. This must also run while no workout is currently
  // loaded: start_workout is precisely the mutation that turns the start
  // surface into the live logger.
  useLiveRefresh('gym', () => {
    void refreshCanonical()
  })

  useEffect(() => {
    if (autoProbe) void probe()
    else setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, [])

  // ── flush-on-blur / visibility-hidden ──────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    const flush = () => {
      void queueRef.current?.flush().finally(bumpPending)
    }
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [bumpPending])

  // ── start ──────────────────────────────────────────────────────────────────
  const start = useCallback(
    async (from: 'template' | 'empty' | 'repeat_last', templateId?: string): Promise<void> => {
      const res = await api.start(from, templateId)
      if (res.conflict) {
        // An active workout already exists (409) — resume it rather than error.
        await probe()
        return
      }
      if (res.workout) {
        refreshRequestRef.current += 1
        const hy = hydrate(res.workout)
        setVisibleWorkout(hy)
        setDisplayUnitState(defaultDisplayUnit(hy))
        setSideModes({})
        ensureQueue(hy.id, hy.revision)
        setSyncState('saved')
        setPendingCount(0)
        setNow(Date.now())
      }
    },
    [api, ensureQueue, probe, setVisibleWorkout],
  )

  // ── set mutations (optimistic; never await network) ────────────────────────

  const updateSetField = useCallback(
    (clientSetId: string, field: SetField, value: number | null) => {
      let touchedEx: string | null = null
      const baseWorkout = workoutRef.current
      mutateWorkout(
        (cur) => {
          const exercises = cur.exercises.map((ex) => {
            if (!ex.sets.some((s) => s.clientSetId === clientSetId)) return ex
            touchedEx = ex.workoutExerciseId
            return { ...ex, sets: ex.sets.map((s) => (s.clientSetId === clientSetId ? withField(s, field, value) : s)) }
          })
          return { ...cur, exercises }
        },
        null,
      )
      if (touchedEx && workoutRef.current) {
        enqueueExerciseFrom(workoutRef.current, touchedEx, false, baseWorkout)
      }
    },
    [mutateWorkout, enqueueExerciseFrom],
  )

  const setSetWeightUnit = useCallback(
    (clientSetId: string, unit: Unit) => {
      let touchedEx: string | null = null
      const baseWorkout = workoutRef.current
      mutateWorkout(
        (cur) => {
          const exercises = cur.exercises.map((ex) => {
            if (!ex.sets.some((s) => s.clientSetId === clientSetId)) return ex
            touchedEx = ex.workoutExerciseId
            return {
              ...ex,
              sets: ex.sets.map((s) =>
                s.clientSetId === clientSetId && s.weightUnit !== unit ? { ...s, weightUnit: unit } : s,
              ),
            }
          })
          return { ...cur, exercises }
        },
        null,
      )
      if (touchedEx && workoutRef.current) {
        enqueueExerciseFrom(workoutRef.current, touchedEx, false, baseWorkout)
      }
    },
    [mutateWorkout, enqueueExerciseFrom],
  )

  const updateSetRest = useCallback(
    (clientSetId: string, seconds: number | null) => {
      let touchedEx: string | null = null
      const baseWorkout = workoutRef.current
      const safe = seconds == null ? null : Math.max(0, Math.min(3600, Math.round(seconds)))
      mutateWorkout(
        (cur) => {
          const exercises = cur.exercises.map((ex) => {
            const selected = ex.sets.find((set) => set.clientSetId === clientSetId)
            if (!selected) return ex
            touchedEx = ex.workoutExerciseId
            return {
              ...ex,
              sets: ex.sets.map((set) =>
                set.logicalSetId === selected.logicalSetId ? { ...set, restSeconds: safe } : set,
              ),
            }
          })
          return { ...cur, exercises }
        },
        null,
      )
      if (touchedEx && workoutRef.current) {
        enqueueExerciseFrom(workoutRef.current, touchedEx, false, baseWorkout)
      }
    },
    [mutateWorkout, enqueueExerciseFrom],
  )

  // ── rest timer (in-memory, timestamp-math) ─────────────────────────────────
  const primeAudio = useCallback(() => {
    primeTimerAudio()
  }, [])

  const startRest = useCallback((exerciseId: string, seconds: number) => {
    if (seconds <= 0) {
      setRestTimer(null)
      return
    }
    setRestTimer(startRestState(exerciseId, seconds, Date.now()))
  }, [])

  const adjustRest = useCallback((deltaSeconds: number) => {
    setRestTimer((cur) => (cur ? adjustRestState(cur, deltaSeconds, Date.now()) : cur))
  }, [])

  const skipRest = useCallback(() => setRestTimer(null), [])

  const setDisplayUnit = useCallback((unit: Unit | null) => setDisplayUnitState(unit), [])

  const sideModeFor = useCallback(
    (workoutExerciseId: string): StrengthSideMode => {
      const selected = sideModes[workoutExerciseId]
      if (selected) return selected
      const exercise = workoutRef.current?.exercises.find(
        (candidate) => candidate.workoutExerciseId === workoutExerciseId,
      )
      return exercise ? inferStrengthSideMode(exercise) : 'both'
    },
    [sideModes],
  )

  const setSideMode = useCallback(
    (workoutExerciseId: string, mode: StrengthSideMode) => {
      setSideModes((current) => {
        const next = { ...current, [workoutExerciseId]: mode }
        sideModesRef.current = next
        return next
      })
      const baseWorkout = workoutRef.current
      const deletedClientSetIds: string[] = []
      let touched = false
      mutateWorkout(
        (cur) => ({
          ...cur,
          exercises: cur.exercises.map((exercise) => {
            if (exercise.workoutExerciseId !== workoutExerciseId) return exercise
            touched = true
            const result = reshapeEmptyStrengthGroups(exercise, mode)
            deletedClientSetIds.push(...result.deletedClientSetIds)
            return result.exercise
          }),
        }),
        null,
      )
      const next = workoutRef.current
      if (!touched || !next) return
      const queue = ensureQueue(next.id, next.revision)
      for (const id of deletedClientSetIds) queue.enqueueDelete(id)
      enqueueExerciseFrom(next, workoutExerciseId, false, baseWorkout)
    },
    [enqueueExerciseFrom, ensureQueue, mutateWorkout],
  )

  const completeSet = useCallback(
    (workoutExerciseId: string, clientSetId: string) => {
      // The first ✓ of the workout is a user gesture — prime the rest-alert audio
      // so the end-of-rest chime can play even when the tab later backgrounds.
      primeTimerAudio()
      // Snapshot the pre-toggle set + its exercise so we can decide (after the
      // optimistic commit) whether this ✓ *starts* a rest and for how long.
      let resolvedRestFor: { exerciseId: string; seconds: number } | null = null
      // ✓ flushes immediately (§2.4) — mutateWorkout enqueues from the NEXT
      // state, so the flush carries the committed values, not a stale snapshot.
      mutateWorkout(
        (cur) => {
          const exercises = cur.exercises.map((ex) => {
            if (ex.workoutExerciseId !== workoutExerciseId) return ex
            const fields = fieldsForTracks(ex.tracks)
            const selected = ex.sets.find((set) => set.clientSetId === clientSetId)
            const sets = ex.sets.map((s) => {
              if (s.clientSetId !== clientSetId) return s
              // Commit ghosts for any field the user left blank (Strong's one-tap);
              // whatever's still blank after that (no previous, no target) fills 0 —
              // null is ambiguous downstream (#1842), 0 states "recorded, no load."
              let next: ActiveSet = { ...s, completed: !s.completed }
              if (!s.completed) {
                for (const f of fields) {
                  if (readField(next, f) == null) {
                    const g = ghostFor(ex, s, f)
                    next = withField(next, f, g ?? 0)
                  }
                }
              }
              return next
            })
            // A logical round rests only after its last physical side lands.
            // Unchecking never starts rest.
            if (selected && !selected.completed) {
              const group = sets.filter((set) => set.logicalSetId === selected.logicalSetId)
              if (group.length > 0 && group.every((set) => set.completed)) {
                const completed = group.find((set) => set.clientSetId === clientSetId) ?? group.at(-1)!
                const isWarmup = completed.setType === 'warmup'
                const seconds = restSecondsForSet(
                  isWarmup,
                  ex.restSeconds,
                  ex.restSecondsWarmup,
                  completed.restSeconds,
                )
                resolvedRestFor = { exerciseId: ex.exerciseId, seconds }
              }
            }
            return { ...ex, sets }
          })
          return { ...cur, exercises }
        },
        workoutExerciseId,
        true,
      )
      if (resolvedRestFor) {
        const r = resolvedRestFor as { exerciseId: string; seconds: number }
        setRestTimer(r.seconds > 0 ? startRestState(r.exerciseId, r.seconds, Date.now()) : null)
      }
    },
    [mutateWorkout],
  )

  const addSet = useCallback(
    (workoutExerciseId: string) => {
      mutateWorkout((cur) => {
        const exercises = cur.exercises.map((ex) => {
          if (ex.workoutExerciseId !== workoutExerciseId) return ex
          const last = ex.sets[ex.sets.length - 1]
          const lastGroup = logicalSetGroups(ex.sets.filter((set) => set.setType !== 'warmup')).at(-1)
          const unit = (ex.preferredUnit as Unit) || 'lb'
          // Clone the last row's effective values as new rows' ghosts (Strong).
          const cloneFrom = (created: ActiveSet) => {
            const source =
              lastGroup?.find((set) => set.side === created.side) ??
              lastGroup?.find((set) => set.side == null) ??
              lastGroup?.[0] ??
              last
            if (source) {
              created.weight = source.weight
              created.reps = source.reps
              created.durationS = source.durationS
              created.distanceM = source.distanceM
              created.weightUnit = source.weightUnit
              created.restSeconds = source.restSeconds ?? null
            }
            return created
          }
          // Per-side holds add a PAIR (§10b.2) — left then right.
          if (ex.perSide) {
            const n = last?.setNumber ?? 0
            const logicalSetId = crypto.randomUUID()
            const left = cloneFrom(newSet(n + 1, unit, 'left', logicalSetId))
            const right = cloneFrom(newSet(n + 2, unit, 'right', logicalSetId))
            return { ...ex, sets: [...ex.sets, left, right] }
          }
          if (ex.modality === 'strength' && ex.loadBasis === 'per_side') {
            const logicalSetId = crypto.randomUUID()
            const n = last?.setNumber ?? 0
            const mode = sideModesRef.current[workoutExerciseId] ?? inferStrengthSideMode(ex)
            const sides: Array<'left' | 'right' | null> =
              mode === 'split' ? ['left', 'right'] : mode === 'left' ? ['left'] : mode === 'right' ? ['right'] : [null]
            const created = sides.map((side, index) =>
              cloneFrom(newSet(n + index + 1, unit, side, logicalSetId)),
            )
            return { ...ex, sets: [...ex.sets, ...created] }
          }
          const created = cloneFrom(newSet((last?.setNumber ?? 0) + 1, unit))
          return { ...ex, sets: [...ex.sets, created] }
        })
        return { ...cur, exercises }
      }, workoutExerciseId)
    },
    [mutateWorkout],
  )

  const addWarmupSet = useCallback(
    (workoutExerciseId: string) => {
      mutateWorkout((cur) => {
        const exercises = cur.exercises.map((ex) => {
          if (ex.workoutExerciseId !== workoutExerciseId) return ex
          const unit = (ex.preferredUnit as Unit) || 'lb'
          const logicalSetId = crypto.randomUUID()
          // Per-side holds always warm up both sides (§10b.2, mirrors addSet) —
          // checked before the strength split-mode picker so an obligate
          // unilateral exercise can never fall back to one ambiguous row (#1840).
          const mode = sideModesRef.current[workoutExerciseId] ?? inferStrengthSideMode(ex)
          const sides: Array<'left' | 'right' | null> = ex.perSide
            ? ['left', 'right']
            : ex.modality === 'strength' && ex.loadBasis === 'per_side'
              ? mode === 'split' ? ['left', 'right'] : mode === 'left' ? ['left'] : mode === 'right' ? ['right'] : [null]
              : [null]
          const created = sides.map((side, index) => ({
            ...newSet(index + 1, unit, side, logicalSetId),
            setType: 'warmup' as const,
          }))
          const firstWorking = ex.sets.findIndex((set) => set.setType !== 'warmup')
          const insertAt = firstWorking < 0 ? ex.sets.length : firstWorking
          const sets = [
            ...ex.sets.slice(0, insertAt),
            ...created,
            ...ex.sets.slice(insertAt),
          ].map((set, index) => ({ ...set, setNumber: index + 1 }))
          return { ...ex, sets }
        })
        return { ...cur, exercises }
      }, workoutExerciseId)
    },
    [mutateWorkout],
  )

  const deleteSet = useCallback(
    (clientSetId: string) => {
      let touchedEx: string | null = null
      const deletedClientSetIds: string[] = []
      const baseWorkout = workoutRef.current
      mutateWorkout(
        (cur) => {
          const exercises = cur.exercises.map((ex) => {
            const selected = ex.sets.find((set) => set.clientSetId === clientSetId)
            if (!selected) return ex
            touchedEx = ex.workoutExerciseId
            // Delete the whole logical round (both Split sides) and renumber the
            // remaining physical rows contiguously for storage.
            const removed = ex.sets.filter((set) => set.logicalSetId === selected.logicalSetId)
            deletedClientSetIds.push(
              ...removed.flatMap((set) => set.clientSetId ? [set.clientSetId] : []),
            )
            const remaining = ex.sets.filter((set) => set.logicalSetId !== selected.logicalSetId)
            const renumbered = remaining.map((s, i) => ({ ...s, setNumber: i + 1 }))
            return { ...ex, sets: renumbered }
          })
          return { ...cur, exercises }
        },
        null,
      )
      if (touchedEx && workoutRef.current) {
        const q = ensureQueue(workoutRef.current.id, workoutRef.current.revision)
        for (const id of deletedClientSetIds) q.enqueueDelete(id)
        enqueueExerciseFrom(workoutRef.current, touchedEx, false, baseWorkout)
      }
    },
    [ensureQueue, mutateWorkout, enqueueExerciseFrom],
  )

  const cycleSetType = useCallback(
    (clientSetId: string, type: SetType) => {
      let touchedEx: string | null = null
      const baseWorkout = workoutRef.current
      mutateWorkout(
        (cur) => {
          const exercises = cur.exercises.map((ex) => {
            const selected = ex.sets.find((set) => set.clientSetId === clientSetId)
            if (!selected) return ex
            touchedEx = ex.workoutExerciseId
            const shouldClear = selected.setType === type
            return {
              ...ex,
              sets: ex.sets.map((s) =>
                s.logicalSetId === selected.logicalSetId
                  ? { ...s, setType: shouldClear ? 'normal' : type }
                  : s,
              ),
            }
          })
          return { ...cur, exercises }
        },
        null,
      )
      if (touchedEx && workoutRef.current) {
        enqueueExerciseFrom(workoutRef.current, touchedEx, false, baseWorkout)
      }
    },
    [mutateWorkout, enqueueExerciseFrom],
  )

  const updateExerciseLoadBasis = useCallback(
    (workoutExerciseId: string, loadBasis: 'total' | 'per_side') => {
      const current = workoutRef.current
      if (!current) return
      const previousBasis = current.exercises.find(
        (exercise) => exercise.workoutExerciseId === workoutExerciseId,
      )?.loadBasis
      setVisibleWorkout({
        ...current,
        exercises: current.exercises.map((exercise) =>
          exercise.workoutExerciseId === workoutExerciseId
            ? { ...exercise, loadBasis }
            : exercise,
        ),
      })
      setSideModes((modes) => {
        const next = { ...modes }
        if (loadBasis === 'per_side' && previousBasis !== 'per_side') {
          next[workoutExerciseId] = 'both'
        } else if (loadBasis === 'total') {
          delete next[workoutExerciseId]
        }
        sideModesRef.current = next
        return next
      })
    },
    [setVisibleWorkout],
  )

  const updateHeader = useCallback(
    async (patch: { name?: string; notes?: string }): Promise<void> => {
      // Optimistic: apply the name locally immediately so the input reflects it.
      const current = workoutRef.current
      if (current) setVisibleWorkout({ ...current, name: patch.name ?? current.name })
      const w = workoutRef.current
      if (!w) return
      const updated = await api.patchMeta(w.id, patch)
      const latest = workoutRef.current
      if (latest?.id === updated.id) {
        setVisibleWorkout({ ...latest, name: updated.name, revision: updated.revision })
      }
    },
    [api, setVisibleWorkout],
  )

  // ── structural edits (awaited; flush sets first) ───────────────────────────

  const applyStructural = useCallback(
    async (edits: Record<string, unknown>) => {
      let current = workoutRef.current
      if (!current) return
      await queueRef.current?.flushOrThrow().finally(bumpPending)
      current = workoutRef.current
      if (!current) return

      let updated: ActiveWorkout
      try {
        updated = await api.editExercises(
          current.id,
          edits,
          queueRef.current?.getRevision() ?? current.revision,
        )
      } catch (error) {
        if (!isStaleWorkoutRevisionError(error)) throw error
        // One deterministic retry applies the UI intent to the canonical model
        // that won the race. Invalidated ids remain a server-side no-op/error;
        // we never replay a stale body indefinitely.
        await refreshCanonical()
        current = workoutRef.current
        if (!current) return
        await queueRef.current?.flushOrThrow().finally(bumpPending)
        updated = await api.editExercises(
          current.id,
          edits,
          queueRef.current?.getRevision() ?? current.revision,
        )
      }

      const canonical = hydrate(updated)
      const queue = queueRef.current
      if (!queue) {
        setVisibleWorkout(canonical)
        return
      }
      const rebased = rebasePendingSnapshot(canonical, queue.pendingSnapshot())
      queue.replacePendingAtRevision(canonical.revision, rebased.pending)
      setVisibleWorkout(rebased.workout)
      bumpPending()
      if (queue.pendingCount() > 0) void queue.flush().finally(bumpPending)
    },
    [api, bumpPending, refreshCanonical, setVisibleWorkout],
  )

  /** Notes are typed a character at a time, so the write is debounced rather than
   * fired per keystroke — each structural call flushes the set queue and advances
   * the revision. Drafts live in a ref keyed by exercise: the local value is
   * authoritative until the server confirms it, and any keystroke that lands
   * DURING a round-trip is re-applied over the canonical model afterwards so the
   * response can never rewind text the user has already typed. */
  const commitExerciseNotes = useCallback(async (): Promise<void> => {
    if (notesTimerRef.current != null) {
      clearTimeout(notesTimerRef.current)
      notesTimerRef.current = null
    }
    const inFlight = [...notesDraftRef.current.entries()]
    if (inFlight.length === 0) return
    for (const [id] of inFlight) notesDraftRef.current.delete(id)

    try {
      await applyStructural({
        notes: inFlight.map(([workoutExerciseId, notes]) => ({ workoutExerciseId, notes })),
      })
    } catch (error) {
      // Keep the draft so the next commit retries it; the local text stands.
      for (const [id, value] of inFlight) {
        if (!notesDraftRef.current.has(id)) notesDraftRef.current.set(id, value)
      }
      throw error
    }

    // Keystrokes that raced the round-trip are newer than the canonical row.
    const newer = notesDraftRef.current
    const latest = workoutRef.current
    if (newer.size === 0 || !latest) return
    setVisibleWorkout({
      ...latest,
      exercises: latest.exercises.map((ex) =>
        newer.has(ex.workoutExerciseId)
          ? { ...ex, notes: newer.get(ex.workoutExerciseId)! }
          : ex,
      ),
    })
  }, [applyStructural, setVisibleWorkout])

  /** Promote one exercise's note to the template the session came from. Sends the
   * draft (the newest typed value) so the link never lags a keystroke behind, and
   * drops it from the queue so the debounce can't write the same note twice. */
  const saveExerciseNoteToTemplate = useCallback(
    async (workoutExerciseId: string): Promise<void> => {
      const current = workoutRef.current
      if (!current) return
      const notes =
        notesDraftRef.current.get(workoutExerciseId) ??
        current.exercises.find((ex) => ex.workoutExerciseId === workoutExerciseId)?.notes ??
        null
      notesDraftRef.current.delete(workoutExerciseId)
      if (notesDraftRef.current.size === 0 && notesTimerRef.current != null) {
        clearTimeout(notesTimerRef.current)
        notesTimerRef.current = null
      }
      await applyStructural({
        notes: [{ workoutExerciseId, notes, applyToTemplate: true }],
      })
    },
    [applyStructural],
  )

  /**
   * Record how an exercise is being held. Optimistic, because the value is
   * whatever was just tapped — there is nothing for the server to compute — and
   * a chip that waits for a round trip mid-workout reads as broken.
   */
  const setExerciseGrip = useCallback(
    async (workoutExerciseId: string, patch: GripPatchInput) => {
      const cur = workoutRef.current
      if (!cur) return
      setVisibleWorkout({
        ...cur,
        exercises: cur.exercises.map((ex) =>
          ex.workoutExerciseId === workoutExerciseId
            ? { ...ex, grip: { ...ex.grip, ...patch } }
            : ex,
        ),
      })
      await applyStructural({ grip: [{ workoutExerciseId, ...patch }] })
    },
    [applyStructural, setVisibleWorkout],
  )

  const updateExerciseNotes = useCallback((workoutExerciseId: string, notes: string) => {
    const cur = workoutRef.current
    if (!cur) return
    notesDraftRef.current.set(workoutExerciseId, notes)
    setVisibleWorkout({
      ...cur,
      exercises: cur.exercises.map((ex) =>
        ex.workoutExerciseId === workoutExerciseId ? { ...ex, notes } : ex,
      ),
    })
    if (notesTimerRef.current != null) clearTimeout(notesTimerRef.current)
    notesTimerRef.current = setTimeout(() => {
      notesTimerRef.current = null
      void commitExerciseNotes().catch(() => {})
    }, NOTES_PERSIST_DEBOUNCE_MS)
  }, [commitExerciseNotes, setVisibleWorkout])

  const addExercise = useCallback(
    async (exerciseId: string) => applyStructural({ add: [{ exerciseId }] }),
    [applyStructural],
  )
  const removeExercise = useCallback(
    async (workoutExerciseId: string) => applyStructural({ remove: [workoutExerciseId] }),
    [applyStructural],
  )
  const replaceExercise = useCallback(
    async (workoutExerciseId: string, newExerciseId: string, keepPrescription?: boolean) =>
      applyStructural({ replace: [{ workoutExerciseId, newExerciseId, keepPrescription }] }),
    [applyStructural],
  )
  const reorderExercise = useCallback(
    async (workoutExerciseId: string, position: number) => {
      const w = workoutRef.current
      if (!w) return
      const ordered = [...w.exercises].sort((a, b) => a.position - b.position)
      const from = ordered.findIndex((ex) => ex.workoutExerciseId === workoutExerciseId)
      if (from < 0) return
      const to = Math.max(0, Math.min(ordered.length - 1, Math.trunc(position)))
      if (from === to) return

      const [moved] = ordered.splice(from, 1)
      ordered.splice(to, 0, moved!)
      await applyStructural({
        reorder: ordered.map((ex, nextPosition) => ({
          workoutExerciseId: ex.workoutExerciseId,
          position: nextPosition,
        })),
      })
    },
    [applyStructural],
  )
  const setSupersetGroup = useCallback(
    async (workoutExerciseIds: string[], group: number | null) => {
      const w = workoutRef.current
      if (!w || workoutExerciseIds.length === 0) return

      const selected = new Set(workoutExerciseIds)
      const desired = new Map(w.exercises.map((exercise) => [exercise.workoutExerciseId, exercise.supersetGroup]))
      if (group == null) {
        for (const id of selected) desired.set(id, null)
      } else {
        for (const exercise of w.exercises) {
          if (exercise.supersetGroup === group) desired.set(exercise.workoutExerciseId, null)
        }
        for (const id of selected) desired.set(id, group)
      }

      // Moving a member out of another two-exercise group must not leave a lone
      // A1 badge behind. Collapse every singleton after the desired assignment.
      const counts = new Map<number, number>()
      for (const value of desired.values()) {
        if (value != null) counts.set(value, (counts.get(value) ?? 0) + 1)
      }
      for (const [id, value] of desired) {
        if (value != null && (counts.get(value) ?? 0) < 2) desired.set(id, null)
      }

      const edits = w.exercises
        .map((exercise) => ({
          workoutExerciseId: exercise.workoutExerciseId,
          group: desired.get(exercise.workoutExerciseId) ?? null,
          previous: exercise.supersetGroup,
        }))
        .filter((edit) => edit.group !== edit.previous)
        .map(({ workoutExerciseId, group: nextGroup }) => ({ workoutExerciseId, group: nextGroup }))
      if (edits.length > 0) await applyStructural({ superset: edits })
    },
    [applyStructural],
  )

  // ── finish / discard ───────────────────────────────────────────────────────
  const finish = useCallback(async (): Promise<FinishSummary> => {
    if (!workoutRef.current) throw new Error('no active workout to finish')
    // A note typed inside the debounce window must land before the session is
    // sealed — finishing reads the server model, not this tab's state.
    await commitExerciseNotes().catch(() => {})
    // Flush the queue FIRST — the one awaited spinner (§2.4).
    await queueRef.current?.flushOrThrow()
    bumpPending()
    const w = workoutRef.current
    if (!w) throw new Error('the active workout changed before it could finish')
    const summary = await api.finish(w.id)
    refreshRequestRef.current += 1
    queueRef.current?.clearMirror()
    setVisibleWorkout(null)
    setRestTimer(null)
    setDisplayUnitState(null)
    setSideModes({})
    teardownQueue()
    return summary
  }, [api, bumpPending, commitExerciseNotes, setVisibleWorkout, teardownQueue])

  const discard = useCallback(async (): Promise<void> => {
    const w = workoutRef.current
    if (!w) return
    await api.discard(w.id)
    refreshRequestRef.current += 1
    queueRef.current?.clearMirror()
    setVisibleWorkout(null)
    setRestTimer(null)
    setDisplayUnitState(null)
    setSideModes({})
    teardownQueue()
  }, [api, setVisibleWorkout, teardownQueue])

  const store = useMemo<ActiveWorkoutStore>(
    () => ({
      workout,
      loading,
      syncState,
      pendingCount,
      elapsedSeconds,
      restTimer,
      nowMs: now,
      displayUnit,
      probe,
      refresh,
      start,
      completeSet,
      updateSetField,
      updateSetRest,
      setSetWeightUnit,
      sideModeFor,
      setSideMode,
      updateExerciseLoadBasis,
      addSet,
      addWarmupSet,
      deleteSet,
      cycleSetType,
      addExercise,
      removeExercise,
      replaceExercise,
      reorderExercise,
      setSupersetGroup,
      setExerciseGrip,
      updateExerciseNotes,
      commitExerciseNotes,
      saveExerciseNoteToTemplate,
      updateHeader,
      startRest,
      adjustRest,
      skipRest,
      setDisplayUnit,
      primeAudio,
      finish,
      discard,
    }),
    [
      workout,
      loading,
      syncState,
      pendingCount,
      elapsedSeconds,
      restTimer,
      now,
      displayUnit,
      probe,
      refresh,
      start,
      completeSet,
      updateSetField,
      updateSetRest,
      setSetWeightUnit,
      sideModeFor,
      setSideMode,
      updateExerciseLoadBasis,
      addSet,
      addWarmupSet,
      deleteSet,
      cycleSetType,
      addExercise,
      removeExercise,
      replaceExercise,
      reorderExercise,
      setSupersetGroup,
      setExerciseGrip,
      updateExerciseNotes,
      commitExerciseNotes,
      saveExerciseNoteToTemplate,
      updateHeader,
      startRest,
      adjustRest,
      skipRest,
      setDisplayUnit,
      primeAudio,
      finish,
      discard,
    ],
  )

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}
