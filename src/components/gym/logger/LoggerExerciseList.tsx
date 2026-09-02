'use client'

/**
 * LoggerExerciseList (GYM_PLAN §4) — renders every ActiveExerciseCard for the
 * live workout + the [+ Add exercise] affordance (opens AddExerciseSheet). Wires
 * each card to the store's set/exercise mutations. Auto-scrolls the next
 * uncompleted exercise into view when one collapses on complete.
 *
 * A3 composes this inside its ActiveWorkoutView shell (with the header + finish/
 * discard UI, which are A3's). This component owns only the exercise list body.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'

import { completedLogicalWorkingSets, useActiveWorkoutStore } from '@/lib/gym-client/active-workout-store'
import type { ActiveWorkout } from '@/lib/gym-client/active-types'
import { ActiveExerciseCard } from './ActiveExerciseCard'
import { AddExerciseSheet } from './AddExerciseSheet'
import { SupersetSheet } from './SupersetSheet'
import { nextSupersetGroupId, supersetMap } from './supersets'

export function LoggerExerciseList() {
  const store = useActiveWorkoutStore()
  const workout = store.workout
  const [adding, setAdding] = useState(false)
  const [supersetFor, setSupersetFor] = useState<string | null>(null)
  const [movingId, setMovingId] = useState<string | null>(null)

  // Derived superset labels / colours / rotation (never stored — §4).
  const ssMap = useMemo(() => supersetMap(workout), [workout])

  // "Up next" in each superset circuit = the member at rotation slot
  // (Σ completed working sets in the group) mod groupSize — so A1→B1→A2→B2 as
  // sets land. Recomputed from live state (no extra stateful tracking).
  const upNextIds = useMemo(() => upNextForGroups(workout, ssMap), [workout, ssMap])

  // Track which exercise to auto-scroll to (the first uncompleted one) after a
  // completion collapses a card. Keyed by workoutExerciseId.
  const refs = useRef<Map<string, HTMLDivElement>>(new Map())
  const prevAllComplete = useRef<Record<string, boolean>>({})

  useEffect(() => {
    if (!workout) return
    // Find an exercise that JUST became all-complete this render.
    let justCompleted = false
    for (const ex of workout.exercises) {
      const all = ex.sets.length > 0 && ex.sets.every((s) => s.completed)
      if (all && !prevAllComplete.current[ex.workoutExerciseId]) justCompleted = true
      prevAllComplete.current[ex.workoutExerciseId] = all
    }
    if (!justCompleted) return
    // Scroll the next uncompleted exercise into view.
    const nextUncompleted = workout.exercises.find(
      (ex) => !(ex.sets.length > 0 && ex.sets.every((s) => s.completed)),
    )
    if (nextUncompleted) {
      const el = refs.current.get(nextUncompleted.workoutExerciseId)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [workout])

  if (!workout) return null

  const orderedExercises = [...workout.exercises].sort((a, b) => a.position - b.position)

  async function moveExercise(workoutExerciseId: string, position: number) {
    if (movingId) return
    setMovingId(workoutExerciseId)
    try {
      await store.reorderExercise(workoutExerciseId, position)
    } catch {
      const { toast } = await import('sonner')
      toast.error("Couldn't move that exercise.")
    } finally {
      setMovingId(null)
    }
  }

  async function saveSuperset(workoutExerciseIds: string[]) {
    if (!workout || !supersetFor) return
    const source = workout.exercises.find((exercise) => exercise.workoutExerciseId === supersetFor)
    if (!source) return
    const group = source.supersetGroup ?? nextSupersetGroupId(workout)

    // The store treats these ids as the complete desired membership and sends
    // the mixed assign/clear edits in one structural request.
    await store.setSupersetGroup(workoutExerciseIds, group)
  }

  // §10b.3 section dividers — only drawn when the session actually has a
  // non-'main' block (a plain strength day stays divider-free).
  const hasSections = workout.exercises.some((ex) => ex.section !== 'main')
  const SECTION_LABEL: Record<string, string> = {
    warmup: 'Warm-up',
    main: 'Workout',
    cooldown: 'Cool-down',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {orderedExercises.map((ex, i) => (
        <div
          key={ex.workoutExerciseId}
          ref={(el) => {
            if (el) refs.current.set(ex.workoutExerciseId, el)
            else refs.current.delete(ex.workoutExerciseId)
          }}
        >
          {hasSections && (i === 0 || orderedExercises[i - 1]!.section !== ex.section) && (
            <div style={sectionDivider} aria-hidden>
              {SECTION_LABEL[ex.section] ?? ex.section}
            </div>
          )}
          <ActiveExerciseCard
            exercise={ex}
            superset={ssMap.get(ex.workoutExerciseId) ?? null}
            upNext={upNextIds.has(ex.workoutExerciseId)}
            canSuperset={orderedExercises.length > 1}
            canMoveUp={i > 0}
            canMoveDown={i < orderedExercises.length - 1}
            moving={movingId != null}
            sideMode={store.sideModeFor(ex.workoutExerciseId)}
            onCompleteSet={store.completeSet}
            onAddSet={store.addSet}
            onAddWarmupSet={store.addWarmupSet}
            onDeleteSet={store.deleteSet}
            onCycleSetType={store.cycleSetType}
            onUpdateSetRest={store.updateSetRest}
            onSideModeChange={store.setSideMode}
            onExerciseLoadBasisChange={(workoutExerciseId, loadBasis) => {
              store.updateExerciseLoadBasis(workoutExerciseId, loadBasis)
              void store.refresh()
            }}
            onUpdateNotes={store.updateExerciseNotes}
            onSetGrip={store.setExerciseGrip}
            onCommitNotes={() => void store.commitExerciseNotes()}
            onSaveNoteToTemplate={
              store.workout?.templateId
                ? (weId) => {
                    void store
                      .saveExerciseNoteToTemplate(weId)
                      .then(() => toast.success('Note saved to template'))
                      .catch(() => toast.error("Couldn't save that note to the template"))
                  }
                : undefined
            }
            onRemove={store.removeExercise}
            onManageSuperset={(weId) => setSupersetFor(weId)}
            onRemoveFromSuperset={(weId) => void store.setSupersetGroup([weId], null)}
            onMoveUp={(weId) => void moveExercise(weId, i - 1)}
            onMoveDown={(weId) => void moveExercise(weId, i + 1)}
            onReplace={(weId) => {
              // Legacy fallback (kept for prop compatibility) — the swap sheet is
              // the real path via onReplaceWith below.
              void weId
              setAdding(true)
            }}
            onReplaceWith={(weId, newId, keepPrescription) =>
              store.replaceExercise(weId, newId, keepPrescription)
            }
          />
        </div>
      ))}

      {workout.exercises.length === 0 && (
        <p style={emptyNote}>No exercises yet — add one to start logging.</p>
      )}

      <button type="button" onClick={() => setAdding(true)} style={addExerciseBtn} aria-label="Add exercise">
        <Plus size={16} strokeWidth={2} /> Add exercise
      </button>

      {adding && (
        <AddExerciseSheet
          onAdd={(exerciseId) => store.addExercise(exerciseId)}
          onClose={() => setAdding(false)}
          inWorkoutIds={new Set(workout.exercises.map((ex) => ex.exerciseId))}
        />
      )}

      {supersetFor && (
        <SupersetSheet
          exercises={orderedExercises}
          initialSelectedIds={selectedSupersetIds(workout, supersetFor)}
          onSave={saveSuperset}
          onClose={() => setSupersetFor(null)}
        />
      )}
    </div>
  )
}

function selectedSupersetIds(
  workout: { exercises: Array<{ workoutExerciseId: string; supersetGroup: number | null }> },
  sourceId: string,
): string[] {
  const source = workout.exercises.find((exercise) => exercise.workoutExerciseId === sourceId)
  if (!source || source.supersetGroup == null) return source ? [sourceId] : []
  return workout.exercises
    .filter((exercise) => exercise.supersetGroup === source.supersetGroup)
    .map((exercise) => exercise.workoutExerciseId)
}

/** For each multi-member superset group, the workoutExerciseId that is "up next"
 *  in the interleaved circuit: rotation slot (Σ completed working sets) mod size.
 *  Solo groups + ungrouped exercises never appear. */
function upNextForGroups(
  workout: ActiveWorkout | null,
  ssMap: Map<string, { group: number | null }>,
): Set<string> {
  const out = new Set<string>()
  if (!workout) return out
  const byGroup = new Map<number, Array<{ id: string; position: number; done: number }>>()
  for (const ex of workout.exercises) {
    const g = ex.supersetGroup
    if (g == null) continue
    const done = completedLogicalWorkingSets(ex.sets)
    const arr = byGroup.get(g) ?? []
    arr.push({ id: ex.workoutExerciseId, position: ex.position, done })
    byGroup.set(g, arr)
  }
  for (const members of byGroup.values()) {
    if (members.length < 2) continue
    members.sort((a, b) => a.position - b.position)
    const total = members.reduce((n, m) => n + m.done, 0)
    const slot = total % members.length
    out.add(members[slot]!.id)
  }
  void ssMap
  return out
}

const sectionDivider: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  margin: '4px 2px 10px',
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const emptyNote: React.CSSProperties = {
  margin: 0,
  padding: '18px 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13.5,
  color: 'var(--fg-subtle)',
  textAlign: 'center',
}
const addExerciseBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '12px',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--accent)',
  background: 'transparent',
  border: '1px dashed color-mix(in oklch, var(--accent) 40%, transparent)',
  borderRadius: 12,
  cursor: 'pointer',
}
