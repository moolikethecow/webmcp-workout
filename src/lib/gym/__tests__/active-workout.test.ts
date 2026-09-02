/**
 * Active-workout write path (GYM_PLAN §2.4, §4). The load-bearing invariant is
 * SET UPSERT IDEMPOTENCY: the optimistic write queue replays batches, so the same
 * payload applied twice must yield the same rows — enforced by ON CONFLICT
 * (client_set_id) DO UPDATE. db.execute is mocked with a SQL-text dispatcher; we
 * assert the upsert SQL shape + that a not-active workout is refused (409 path).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sqlText, collapseWs, sqlParams } from './sql-text'

const mockExecute = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db/client', () => ({ db: { execute: mockExecute, transaction: mockTransaction } }))

const {
  ActiveWorkoutPerformedSetsConflictError,
  ActiveWorkoutRevisionConflictError,
  upsertSets,
  upsertExerciseSetsIfUnchanged,
  discardWorkout,
  editExercises,
  startWorkout,
  getActiveWorkoutById,
  materializeSetPrescriptions,
  mergeProgressionPrescription,
} = await import('../active-workout')

const WORKOUT_ID = 'w-1'
const WE_ID = 'we-1'

/** Records every INSERT statement fired (for idempotency inspection). */
function installDb(opts: {
  active?: boolean
  belongCount?: number
  revision?: number
  completedPerformance?: boolean
  /** clientSetIds that should read back as ALREADY completed=true before the write. */
  priorCompletedIds?: string[]
} = {}) {
  const active = opts.active ?? true
  const revision = opts.revision ?? 0
  mockExecute.mockReset()
  mockTransaction.mockImplementation((fn: (tx: { execute: typeof mockExecute }) => unknown) =>
    fn({ execute: mockExecute }),
  )
  mockExecute.mockImplementation((arg: unknown) => {
    const q = collapseWs(sqlText(arg))
    if (/SELECT client_set_id::text AS client_set_id FROM workout_sets/.test(q) && /completed = true/.test(q)) {
      const ids = opts.priorCompletedIds ?? []
      return Promise.resolve({ rows: ids.map((client_set_id) => ({ client_set_id })) })
    }
    if (/FROM workouts w JOIN workout_exercises we/.test(q) && /FOR UPDATE OF w, we/.test(q)) {
      return Promise.resolve({ rows: active ? [{ status: 'active', revision }] : [] })
    }
    if (/SELECT status, revision FROM workouts WHERE id/.test(q) && /FOR UPDATE/.test(q)) {
      return Promise.resolve({ rows: [{ status: active ? 'active' : 'completed', revision }] })
    }
    if (/UPDATE workouts SET revision = revision \+ 1/.test(q)) {
      return Promise.resolve({ rows: active ? [{ revision: revision + 1 }] : [] })
    }
    if (/SELECT status FROM workouts WHERE id/.test(q)) {
      return Promise.resolve({ rows: [{ status: active ? 'active' : 'completed' }] })
    }
    if (/FROM workout_exercises we/.test(q) && /ws\.completed = true/.test(q)) {
      return Promise.resolve({ rows: opts.completedPerformance ? [{ id: WE_ID }] : [] })
    }
    // exerciseIdsBelong count.
    if (/count\(\*\)::int AS n FROM workout_exercises/.test(q)) {
      return Promise.resolve({ rows: [{ n: opts.belongCount ?? 1 }] })
    }
    // materializedSets read — return one canonical row.
    if (/FROM workout_sets WHERE workout_exercise_id/.test(q)) {
      return Promise.resolve({
        rows: [
          {
            client_set_id: 'cs-1',
            logical_set_id: 'ls-1',
            set_number: 1,
            set_type: 'normal',
            weight: '100',
            weight_unit: 'lb',
            reps: 8,
            distance_m: null,
            duration_s: null,
            rpe: null,
            rest_seconds: null,
            side: null,
            completed: true,
          },
        ],
      })
    }
    // discard flip.
    if (/UPDATE workouts SET status = 'discarded'/.test(q)) {
      return Promise.resolve({ rows: active ? [{ id: WORKOUT_ID }] : [] })
    }
    return Promise.resolve({ rows: [] })
  })
}

/** All INSERT-into-workout_sets statements that were fired. */
function firedInserts(): string[] {
  return mockExecute.mock.calls
    .map(([arg]) => collapseWs(sqlText(arg)))
    .filter((q) => /INSERT INTO workout_sets/.test(q))
}

const set = () => ({
  clientSetId: 'cs-1',
  logicalSetId: '00000000-0000-4000-8000-000000000001',
  workoutExerciseId: WE_ID,
  setNumber: 1,
  setType: 'normal',
  weight: 100,
  weightUnit: 'lb',
  reps: 8,
  completed: true,
})

beforeEach(() => vi.clearAllMocks())

describe('upsertSets — idempotency', () => {
  it('emits an ON CONFLICT (client_set_id) DO UPDATE upsert', async () => {
    installDb()
    await upsertSets(WORKOUT_ID, [set()], 0)
    const inserts = firedInserts()
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatch(/ON CONFLICT \(client_set_id\) DO UPDATE/)
    // Every value column is refreshed on conflict (so a replay overwrites cleanly).
    for (const col of ['set_number', 'set_type', 'weight', 'weight_unit', 'reps', 'logical_set_id', 'completed']) {
      expect(inserts[0]).toMatch(new RegExp(`${col} = EXCLUDED.${col}`))
    }
  })

  it('the SAME payload applied twice fires the SAME upsert both times (replay-safe)', async () => {
    installDb()
    await upsertSets(WORKOUT_ID, [set()], 0)
    const first = firedInserts()
    mockExecute.mockClear()
    installDb()
    await upsertSets(WORKOUT_ID, [set()], 0)
    const second = firedInserts()
    expect(second).toEqual(first) // identical statement → identical rows via the key
  })

  it('returns the canonical sets for every touched exercise', async () => {
    installDb()
    const res = await upsertSets(WORKOUT_ID, [set()], 0)
    expect(res).not.toBeNull()
    expect(res!.revision).toBe(1)
    expect(res!.byExercise[WE_ID]).toHaveLength(1)
    expect(res!.byExercise[WE_ID]![0]).toMatchObject({ clientSetId: 'cs-1', reps: 8 })
  })

  it('refuses (null → 409) when the workout is not active', async () => {
    installDb({ active: false })
    const res = await upsertSets(WORKOUT_ID, [set()], 0)
    expect(res).toBeNull()
    expect(firedInserts()).toHaveLength(0) // never wrote
  })

  // #1836: the optimistic client re-sends an exercise's FULL set array (every
  // sibling set, not a diff) on ANY edit — so a set that was already completed
  // before this write must not be reported as newly completed just because it's
  // present again with completed: true.
  describe('newlyCompletedClientSetIds (#1836)', () => {
    it('reports a set as newly completed when it was not already completed', async () => {
      installDb({ priorCompletedIds: [] })
      const res = await upsertSets(WORKOUT_ID, [set()], 0)
      expect(res!.newlyCompletedClientSetIds).toEqual(['cs-1'])
    })

    it('does NOT report a set that was already completed before this write', async () => {
      installDb({ priorCompletedIds: ['cs-1'] })
      const res = await upsertSets(WORKOUT_ID, [set()], 0)
      expect(res!.newlyCompletedClientSetIds).toEqual([])
    })

    it('never reports a not-yet-started (completed: false) set', async () => {
      installDb({ priorCompletedIds: [] })
      const res = await upsertSets(WORKOUT_ID, [{ ...set(), completed: false }], 0)
      expect(res!.newlyCompletedClientSetIds).toEqual([])
    })

    it('separates a genuinely new ✓ from an already-completed sibling in the same batch', async () => {
      installDb({ priorCompletedIds: ['cs-old'] })
      const res = await upsertSets(
        WORKOUT_ID,
        [
          { ...set(), clientSetId: 'cs-old', completed: true },
          { ...set(), clientSetId: 'cs-new', completed: true },
        ],
        0,
      )
      expect(res!.newlyCompletedClientSetIds).toEqual(['cs-new'])
    })
  })

  it('refuses when a set references an exercise not in this workout', async () => {
    installDb({ belongCount: 0 }) // the ownership check fails
    const res = await upsertSets(WORKOUT_ID, [set()], 0)
    expect(res).toBeNull()
    expect(firedInserts()).toHaveLength(0)
  })

  it('rejects a stale logger generation before it can replay any set row', async () => {
    installDb({ revision: 2 })
    await expect(upsertSets(WORKOUT_ID, [set()], 1)).rejects.toBeInstanceOf(
      ActiveWorkoutRevisionConflictError,
    )
    expect(firedInserts()).toHaveLength(0)
  })

  it('deletes the requested client_set_ids scoped to the workout', async () => {
    installDb()
    await upsertSets(WORKOUT_ID, [], 0, ['cs-del-1', 'cs-del-2'])
    const deletes = mockExecute.mock.calls
      .map(([arg]) => collapseWs(sqlText(arg)))
      .filter((q) => /DELETE FROM workout_sets/.test(q))
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toMatch(/workout_exercise_id IN \( SELECT id FROM workout_exercises WHERE workout_id/)
  })

  it('updates an explicit per-set rest while preserving it when omitted', async () => {
    installDb()
    await upsertSets(WORKOUT_ID, [{ ...set(), restSeconds: 75 }], 0)
    const explicit = firedInserts()[0]!
    expect(explicit).toContain('rest_seconds')
    expect(explicit).toMatch(/rest_seconds = EXCLUDED\.rest_seconds/)

    installDb()
    await upsertSets(WORKOUT_ID, [set()], 0)
    expect(firedInserts()[0]).toMatch(/rest_seconds = workout_sets\.rest_seconds/)
  })

  it('updates an explicit logical set ID while preserving migrated grouping when omitted', async () => {
    installDb()
    await upsertSets(WORKOUT_ID, [set()], 0)
    expect(firedInserts()[0]).toMatch(/logical_set_id = EXCLUDED\.logical_set_id/)

    installDb()
    await upsertSets(WORKOUT_ID, [{ ...set(), logicalSetId: undefined }], 0)
    expect(firedInserts()[0]).toMatch(/logical_set_id = workout_sets\.logical_set_id/)
  })
})

describe('upsertExerciseSetsIfUnchanged — atomic structural CAS', () => {
  const expected = [{
    clientSetId: 'cs-1', logicalSetId: 'ls-1', setNumber: 1, setType: 'normal', weight: 100,
    weightUnit: 'lb', reps: 8, distanceM: null, durationS: null, rpe: null,
    restSeconds: null, side: null, completed: true,
  }]

  it('locks, compares, and applies the whole set rewrite in one transaction', async () => {
    installDb()
    const result = await upsertExerciseSetsIfUnchanged(WORKOUT_ID, WE_ID, expected, [{
      ...set(), setNumber: 2, prescribedWeight: 120, prescribedWeightUnit: 'lb',
      prescribedReps: 6, prescriptionSource: 'agent',
    }], 0)

    expect(result.ok).toBe(true)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    const statements = mockExecute.mock.calls.map(([arg]) => collapseWs(sqlText(arg)))
    expect(statements.some((q) => /FOR UPDATE OF w, we/.test(q))).toBe(true)
    expect(statements.some((q) => /FROM workout_sets/.test(q) && /FOR UPDATE/.test(q))).toBe(true)
    expect(statements.some((q) => /prescribed_weight = EXCLUDED\.prescribed_weight/.test(q))).toBe(true)
  })

  it('rejects a stale snapshot before any insert', async () => {
    installDb()
    const result = await upsertExerciseSetsIfUnchanged(WORKOUT_ID, WE_ID, [
      { ...expected[0]!, completed: false },
    ], [set()], 0)

    expect(result).toEqual({ ok: false, reason: 'conflict' })
    expect(firedInserts()).toHaveLength(0)
  })

  it('rejects a stale generation even when the actual-row snapshot still matches', async () => {
    installDb({ revision: 3 })
    const result = await upsertExerciseSetsIfUnchanged(
      WORKOUT_ID,
      WE_ID,
      expected,
      [{ ...set(), prescribedWeight: 125, prescriptionSource: 'agent' }],
      2,
    )
    expect(result).toEqual({ ok: false, reason: 'conflict' })
    expect(firedInserts()).toHaveLength(0)
  })
})

describe('set prescription materialization', () => {
  it('creates incomplete actual rows with immutable planned values + exact rest', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] })
    await materializeSetPrescriptions(execute, WE_ID, [{
      setNumber: 1,
      setType: 'warmup',
      weight: 45,
      weightUnit: 'lb',
      reps: 12,
      restSeconds: 30,
      source: 'template',
    }])
    const queries = execute.mock.calls.map(([q]) => collapseWs(sqlText(q)))
    expect(queries[0]).toMatch(/DELETE FROM workout_sets .* completed = false/)
    expect(queries[1]).toMatch(/prescribed_weight.*prescribed_reps.*rest_seconds.*prescription_source/)
    expect(queries[1]).toMatch(/NULL, .* NULL, NULL, NULL, NULL, .* false, gen_random_uuid\(\)/)
  })

  it('preserves four identical prescriptions as four distinct set rows', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] })
    await materializeSetPrescriptions(
      execute,
      WE_ID,
      Array.from({ length: 4 }, (_, index) => ({
        setNumber: index + 1,
        weight: 45,
        weightUnit: 'lb' as const,
        reps: 10,
        source: 'repeat' as const,
      })),
    )
    const inserts = execute.mock.calls
      .map(([query]) => collapseWs(sqlText(query)))
      .filter((query) => /INSERT INTO workout_sets/.test(query))
    expect(inserts).toHaveLength(4)
  })

  it('overlays progression on working sets while preserving warmup/rest and restoring set count', () => {
    const merged = mergeProgressionPrescription(
      [
        { setNumber: 1, setType: 'warmup', weight: 45, weightUnit: 'lb', reps: 10, restSeconds: 30, source: 'template' },
        { setNumber: 2, setType: 'normal', weight: 100, weightUnit: 'lb', reps: 8, restSeconds: 90, source: 'template' },
      ],
      [
        { weight: 105, reps: 8 },
        { weight: 105, reps: 8 },
        { weight: 105, reps: 8 },
      ],
      'lb',
    )
    expect(merged).toHaveLength(4)
    expect(merged[0]).toMatchObject({ setType: 'warmup', weight: 45, restSeconds: 30, source: 'template' })
    expect(merged.slice(1).every((set) => set.weight === 105 && set.source === 'progression')).toBe(true)
    expect(merged[1]!.restSeconds).toBe(90)
  })

  it('restores missing unilateral rounds as balanced L/R rows', () => {
    const merged = mergeProgressionPrescription(
      [
        { setNumber: 1, setType: 'normal', weight: 20, weightUnit: 'lb', reps: 8, side: 'left', source: 'template' },
        { setNumber: 2, setType: 'normal', weight: 20, weightUnit: 'lb', reps: 8, side: 'right', source: 'template' },
        { setNumber: 3, setType: 'normal', weight: 20, weightUnit: 'lb', reps: 8, side: 'left', source: 'template' },
        { setNumber: 4, setType: 'normal', weight: 20, weightUnit: 'lb', reps: 8, side: 'right', source: 'template' },
      ],
      [
        { weight: 20, reps: 9, side: 'left' },
        { weight: 20, reps: 9, side: 'right' },
        { weight: 20, reps: 8, side: 'left' },
        { weight: 20, reps: 8, side: 'right' },
        { weight: 20, reps: 8, side: 'left' },
        { weight: 20, reps: 8, side: 'right' },
      ],
      'lb',
    )
    expect(merged.map((set) => set.side)).toEqual([
      'left', 'right', 'left', 'right', 'left', 'right',
    ])
  })
})

describe('active workout prescription explanation', () => {
  it('uses the start-time plan rule instead of recomputing a template default', async () => {
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/FROM workouts w LEFT JOIN workout_templates/.test(q)) {
        return Promise.resolve({ rows: [{
          id: WORKOUT_ID, revision: 0, name: 'Upper', status: 'active',
          started_at: '2026-07-15T12:00:00Z', template_id: null, template_name: null,
        }] })
      }
      if (/FROM workout_exercises we JOIN exercises e/.test(q)) {
        return Promise.resolve({ rows: [{
          workout_exercise_id: WE_ID, exercise_id: 'bench', name: 'sphinx',
          tracks: 'weight_reps', modality: 'strength', per_side: false, section: 'main',
          position: 0, superset_group: null, we_rest: 120, we_rest_warmup: null,
          ex_default_rest: 120, ex_rest_warmup: 30, preferred_unit: 'lb', notes: null,
          prescription_rule: 'Work 8–10 reps for 3 sets; add 5 lb when all clear.',
        }] })
      }
      if (/FROM app_settings WHERE id = 1/.test(q)) {
        return Promise.resolve({ rows: [{ rest: 120, unit: 'lb', distance_unit: 'mi' }] })
      }
      if (/SELECT client_set_id::text/.test(q)) return Promise.resolve({ rows: [] })
      if (/SELECT ws.set_number, ws.set_type/.test(q)) {
        return Promise.resolve({ rows: [{
          set_number: 1, set_type: 'warmup', weight: '45', unit: 'lb', reps: 10,
          duration_s: null, distance_m: null,
        }] })
      }
      if (/SELECT w.id AS workout_id/.test(q)) return Promise.resolve({ rows: [] })
      if (/SELECT set_number, set_type, prescribed_weight/.test(q)) {
        return Promise.resolve({ rows: [{
          set_number: 1, set_type: 'normal', prescribed_weight: '100',
          prescribed_weight_unit: 'lb', prescribed_reps: 8, prescribed_distance_m: null,
          prescribed_duration_s: null, prescribed_rpe: null, rest_seconds: 120,
          prescription_source: 'progression', side: null,
        }] })
      }
      return Promise.resolve({ rows: [] })
    })

    const workout = await getActiveWorkoutById(WORKOUT_ID)
    expect(workout?.exercises[0]?.name).toBe('Sphinx')
    expect(workout?.exercises[0]?.previous[0]?.setType).toBe('warmup')
    expect(workout?.exercises[0]?.ruleText).toBe(
      'Work 8–10 reps for 3 sets; add 5 lb when all clear.',
    )
  })
})

describe('discardWorkout — rowcount guard', () => {
  it('flips active → discarded and reports true', async () => {
    installDb({ active: true })
    expect(await discardWorkout(WORKOUT_ID)).toBe(true)
  })

  it('reports false when the workout was not active (no row flipped)', async () => {
    installDb({ active: false })
    expect(await discardWorkout(WORKOUT_ID)).toBe(false)
  })
})

describe('editExercises — active gate', () => {
  it('returns null (409) when the workout is not active', async () => {
    installDb({ active: false })
    const res = await editExercises(WORKOUT_ID, { remove: ['we-x'] }, 0)
    expect(res).toBeNull()
  })

  it('writes a per-exercise note, storing a blank one as NULL', async () => {
    installDb({ active: true })
    await editExercises(
      WORKOUT_ID,
      { notes: [{ workoutExerciseId: WE_ID, notes: '  elbows tucked  ' }, { workoutExerciseId: 'we-2', notes: '   ' }] },
      0,
    )
    const writes = mockExecute.mock.calls
      .filter(([a]) => /UPDATE workout_exercises SET notes/.test(collapseWs(sqlText(a))))
      .map(([a]) => sqlParams(a))
    expect(writes).toEqual([
      ['elbows tucked', WE_ID, WORKOUT_ID],
      [null, 'we-2', WORKOUT_ID],
    ])
  })

  it('promotes a note to the source template only when asked, scoped to that workout', async () => {
    installDb({ active: true })
    await editExercises(
      WORKOUT_ID,
      {
        notes: [
          { workoutExerciseId: WE_ID, notes: 'elbows tucked', applyToTemplate: true },
          { workoutExerciseId: 'we-2', notes: 'session only' },
        ],
      },
      0,
    )
    const templateWrites = mockExecute.mock.calls
      .map(([a]) => collapseWs(sqlText(a)))
      .filter((q) => /UPDATE template_exercises te SET notes/.test(q))
    expect(templateWrites).toHaveLength(1)
    // The template row is reached THROUGH the workout, never by a client-supplied id.
    expect(templateWrites[0]).toMatch(/te\.template_id = w\.template_id/)
    expect(templateWrites[0]).toMatch(/te\.exercise_id = we\.exercise_id/)
    expect(templateWrites[0]).toMatch(/we\.workout_id =/)
  })

  it('replace deletes the old exercise’s sets (different movement)', async () => {
    installDb({ active: true })
    await editExercises(WORKOUT_ID, { replace: [{ workoutExerciseId: WE_ID, newExerciseId: 'ex-new' }] }, 0)
    const q = mockExecute.mock.calls.map(([a]) => collapseWs(sqlText(a)))
    expect(q.some((s) => /UPDATE workout_exercises SET exercise_id/.test(s))).toBe(true)
    expect(q.some((s) => /DELETE FROM workout_sets WHERE workout_exercise_id/.test(s))).toBe(true)
  })

  it('replace with keepPrescription carries the target forward instead of deleting it (#1876)', async () => {
    installDb({ active: true })
    await editExercises(
      WORKOUT_ID,
      { replace: [{ workoutExerciseId: WE_ID, newExerciseId: 'ex-new', keepPrescription: true }] },
      0,
    )
    const q = mockExecute.mock.calls.map(([a]) => collapseWs(sqlText(a)))
    expect(q.some((s) => /UPDATE workout_exercises SET exercise_id/.test(s))).toBe(true)
    expect(
      q.some((s) => /UPDATE workout_sets SET prescription_source = 'replacement'/.test(s)),
    ).toBe(true)
    expect(q.some((s) => /DELETE FROM workout_sets WHERE workout_exercise_id/.test(s))).toBe(false)
  })

  it.each(['remove', 'replace'] as const)(
    'refuses to %s an exercise with completed performance before any destructive write',
    async (operation) => {
      installDb({ active: true, completedPerformance: true })
      const edits = operation === 'remove'
        ? { remove: [WE_ID] }
        : { replace: [{ workoutExerciseId: WE_ID, newExerciseId: 'ex-new' }] }

      let error: unknown
      try {
        await editExercises(WORKOUT_ID, edits, 0)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(ActiveWorkoutPerformedSetsConflictError)
      expect(error).toMatchObject({
        name: 'ActiveWorkoutPerformedSetsConflictError',
        code: 'performed_sets_present',
        workoutExerciseId: WE_ID,
        operation,
      })

      const q = mockExecute.mock.calls.map(([arg]) => collapseWs(sqlText(arg)))
      expect(q.some((statement) => /DELETE FROM workout_exercises/.test(statement))).toBe(false)
      expect(q.some((statement) => /UPDATE workout_exercises SET exercise_id/.test(statement))).toBe(false)
      expect(q.some((statement) => /DELETE FROM workout_sets/.test(statement))).toBe(false)
      expect(q.some((statement) => /UPDATE workouts SET revision/.test(statement))).toBe(false)
    },
  )

  it('updates working + warmup rest only on an exercise in this workout', async () => {
    installDb({ active: true })
    await editExercises(WORKOUT_ID, {
      rest: [{ workoutExerciseId: WE_ID, seconds: 120, warmupSeconds: 45 }],
    }, 0)
    const q = mockExecute.mock.calls.map(([a]) => collapseWs(sqlText(a)))
    const update = q.find((s) => /SET rest_seconds = .*rest_seconds_warmup/.test(s))
    expect(update).toBeDefined()
    expect(update).toMatch(/WHERE id = .* AND workout_id =/)
  })
})

// ── startWorkout — from:'workout' (History "Repeat"), P2b ──────────────────────
describe("startWorkout — from:'workout'", () => {
  const SRC_ID = 'src-workout'
  const NEW_ID = 'new-workout'

  /**
   * Dispatch the start flow's reads/writes. `existingActive` seeds the
   * one-active-at-a-time guard; `sourceFound` toggles whether the source completed
   * workout resolves.
   */
  function installStart(opts: { existingActive?: string | null; sourceFound?: boolean } = {}) {
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      // activeWorkoutId() probe.
      if (/SELECT id FROM workouts WHERE status = 'active'/.test(q)) {
        return Promise.resolve({ rows: opts.existingActive ? [{ id: opts.existingActive }] : [] })
      }
      // Source-workout resolve (from='workout').
      if (/SELECT id, name, template_id FROM workouts WHERE id =/.test(q)) {
        return Promise.resolve({
          rows: opts.sourceFound === false ? [] : [{ id: SRC_ID, name: 'Legacy Push', template_id: 't-1' }],
        })
      }
      // INSERT the new active workout.
      if (/INSERT INTO workouts/.test(q)) {
        return Promise.resolve({ rows: [{ id: NEW_ID }] })
      }
      if (/SELECT we\.id AS source_workout_exercise_id/.test(q)) {
        return Promise.resolve({
          rows: [{
            source_workout_exercise_id: 'source-we', exercise_id: 'bench', position: 0,
            superset_group: null, rest_seconds: 120, rest_seconds_warmup: 45,
            section: 'main', notes: null,
          }],
        })
      }
      if (/INSERT INTO workout_exercises/.test(q)) {
        return Promise.resolve({ rows: [{ id: WE_ID }] })
      }
      if (/FROM workout_sets WHERE workout_exercise_id/.test(q)) {
        return Promise.resolve({
          // A completed workout may contain unchecked rows. History shows all
          // four, so Repeat must not collapse this to the sole checked row.
          rows: Array.from({ length: 4 }, (_, index) => ({
            set_number: index + 1, set_type: 'normal', weight: '45', weight_unit: 'lb',
            reps: 10, distance_m: null, duration_s: null, rpe: '8',
            rest_seconds: 120, side: null,
          })),
        })
      }
      // getActiveWorkoutById header (any status).
      if (/FROM workouts w LEFT JOIN workout_templates t/.test(q)) {
        return Promise.resolve({
          rows: [{ id: NEW_ID, name: 'Legacy Push', status: 'active', started_at: '2026-07-09T00:00:00Z', template_id: 't-1', template_name: 'Push' }],
        })
      }
      // getActiveWorkoutById exercise list + app defaults + everything else → empty.
      return Promise.resolve({ rows: [] })
    })
  }

  it('copies every History-visible set from the SPECIFIC completed source workout', async () => {
    installStart()
    const res = await startWorkout('workout', undefined, SRC_ID)
    expect(res.workout?.id).toBe(NEW_ID)

    const q = mockExecute.mock.calls.map(([a]) => collapseWs(sqlText(a)))
    // The workout is status-scoped, but individual rows are intentionally not:
    // History displays unchecked planned rows too, and Repeat must match it.
    const copy = q.find((s) => /SELECT we\.id AS source_workout_exercise_id/.test(s))
    expect(copy).toBeDefined()
    expect(copy).toMatch(/JOIN workouts w ON we\.workout_id = w\.id AND w\.status = 'completed'/)
    const sourceSets = q.find((s) => /FROM workout_sets WHERE workout_exercise_id/.test(s))
    expect(sourceSets).toBeDefined()
    expect(sourceSets).not.toMatch(/completed = true/)
    expect(sourceSets).toMatch(/COALESCE\(weight, prescribed_weight\)/)
    expect(q.filter((s) => /INSERT INTO workout_sets .*prescribed_weight/.test(s))).toHaveLength(4)
  })

  it('409s (conflict) when an active workout already exists — no insert', async () => {
    installStart({ existingActive: 'already-active' })
    const res = await startWorkout('workout', undefined, SRC_ID)
    expect(res.conflictActiveWorkoutId).toBe('already-active')
    expect(res.workout).toBeUndefined()
    const q = mockExecute.mock.calls.map(([a]) => collapseWs(sqlText(a)))
    expect(q.some((s) => /INSERT INTO workouts/.test(s))).toBe(false)
  })

  it('throws "workout not found" when the source is missing / not completed', async () => {
    installStart({ sourceFound: false })
    await expect(startWorkout('workout', undefined, SRC_ID)).rejects.toThrow(/workout not found/)
  })

  it('throws when sourceWorkoutId is omitted', async () => {
    installStart()
    await expect(startWorkout('workout')).rejects.toThrow(/sourceWorkoutId required/)
  })

  it("repeat_last still works (regression) and copies the most-recent session", async () => {
    // repeat_last resolves the last completed workout, then copies its exercises.
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT id FROM workouts WHERE status = 'active'/.test(q)) return Promise.resolve({ rows: [] })
      if (/SELECT id, name, template_id FROM workouts WHERE status = 'completed' ORDER BY started_at DESC/.test(q)) {
        return Promise.resolve({ rows: [{ id: 'last', name: 'Last', template_id: null }] })
      }
      if (/INSERT INTO workouts/.test(q)) return Promise.resolve({ rows: [{ id: NEW_ID }] })
      if (/FROM workouts w LEFT JOIN workout_templates t/.test(q)) {
        return Promise.resolve({ rows: [{ id: NEW_ID, name: 'Last', status: 'active', started_at: '2026-07-09T00:00:00Z', template_id: null, template_name: null }] })
      }
      return Promise.resolve({ rows: [] })
    })
    const res = await startWorkout('repeat_last')
    expect(res.workout?.id).toBe(NEW_ID)
    const q = mockExecute.mock.calls.map(([a]) => collapseWs(sqlText(a)))
    expect(q.some((s) => /SELECT id, name, template_id FROM workouts WHERE status = 'completed' ORDER BY started_at DESC LIMIT 1/.test(s))).toBe(true)
  })
})

describe("startWorkout — from:'template' exact sets", () => {
  it('materializes every ordered template set, including warmup rest', async () => {
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT id FROM workouts WHERE status = 'active'/.test(q)) return Promise.resolve({ rows: [] })
      if (/SELECT id, name FROM workout_templates/.test(q)) {
        return Promise.resolve({ rows: [{ id: 'tpl', name: 'Upper' }] })
      }
      if (/INSERT INTO workouts/.test(q)) return Promise.resolve({ rows: [{ id: 'new' }] })
      if (/SELECT te\.id AS template_exercise_id/.test(q)) {
        return Promise.resolve({
          rows: [{
            template_exercise_id: 'te-1', exercise_id: 'bench', position: 0,
            superset_group: null, rest_seconds: 120, rest_seconds_warmup: 30,
            section: 'main', notes: null, target_sets: 3, target_reps: 8,
            target_weight: '185', target_weight_unit: 'lb', target_duration_s: null,
            progression: null, preferred_unit: 'lb', per_side: false,
          }],
        })
      }
      if (/INSERT INTO workout_exercises/.test(q)) return Promise.resolve({ rows: [{ id: 'we-new' }] })
      if (/FROM template_sets WHERE template_exercise_id/.test(q)) {
        return Promise.resolve({
          rows: [
            { set_number: 1, set_type: 'warmup', target_weight: '45', target_weight_unit: 'lb', target_reps: 12, target_distance_m: null, target_duration_s: null, target_rpe: null, rest_seconds: 30, side: null },
            { set_number: 2, set_type: 'normal', target_weight: '185', target_weight_unit: 'lb', target_reps: 8, target_distance_m: null, target_duration_s: null, target_rpe: '8', rest_seconds: 120, side: null },
          ],
        })
      }
      if (/FROM workouts w LEFT JOIN workout_templates t/.test(q)) {
        return Promise.resolve({
          rows: [{ id: 'new', name: 'Upper', status: 'active', started_at: '2026-07-15T00:00:00Z', template_id: 'tpl', template_name: 'Upper' }],
        })
      }
      return Promise.resolve({ rows: [] })
    })

    const result = await startWorkout('template', 'tpl')
    expect(result.workout?.id).toBe('new')
    const queries = mockExecute.mock.calls.map(([q]) => collapseWs(sqlText(q)))
    const setInserts = queries.filter((q) => /INSERT INTO workout_sets/.test(q))
    expect(setInserts).toHaveLength(2)
    expect(setInserts.every((q) => /prescribed_weight.*rest_seconds.*prescription_source/.test(q))).toBe(true)
  })
})

describe('startWorkout — singleton races and failed-start cleanup', () => {
  it('translates a raced singleton-index violation into the winning active workout', async () => {
    let activeProbes = 0
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT id FROM workouts WHERE status = 'active'/.test(q)) {
        activeProbes += 1
        return Promise.resolve({ rows: activeProbes === 1 ? [] : [{ id: 'race-winner' }] })
      }
      if (/INSERT INTO workouts/.test(q)) {
        return Promise.reject(Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'uq_workouts_one_active',
        }))
      }
      return Promise.resolve({ rows: [] })
    })

    await expect(startWorkout('empty')).resolves.toEqual({
      conflictActiveWorkoutId: 'race-winner',
    })
    expect(activeProbes).toBe(2)
  })

  it('does not disguise a different unique-constraint failure as an active workout', async () => {
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT id FROM workouts WHERE status = 'active'/.test(q)) {
        return Promise.resolve({ rows: [] })
      }
      if (/INSERT INTO workouts/.test(q)) {
        return Promise.reject(Object.assign(new Error('wrong unique key'), {
          code: '23505',
          constraint: 'uq_something_else',
        }))
      }
      return Promise.resolve({ rows: [] })
    })

    await expect(startWorkout('empty')).rejects.toThrow('wrong unique key')
  })

  it('deletes its new active row when copying a source workout fails', async () => {
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT id FROM workouts WHERE status = 'active'/.test(q)) {
        return Promise.resolve({ rows: [] })
      }
      if (/SELECT id, name, template_id FROM workouts WHERE id =/.test(q)) {
        return Promise.resolve({ rows: [{ id: 'source', name: 'Source', template_id: null }] })
      }
      if (/INSERT INTO workouts/.test(q)) return Promise.resolve({ rows: [{ id: 'orphan-risk' }] })
      if (/SELECT we\.id AS source_workout_exercise_id/.test(q)) {
        return Promise.resolve({
          rows: [{
            source_workout_exercise_id: 'source-we', exercise_id: 'bench', position: 0,
            superset_group: null, rest_seconds: 120, rest_seconds_warmup: 45,
            section: 'main', notes: null,
          }],
        })
      }
      if (/INSERT INTO workout_exercises/.test(q)) return Promise.reject(new Error('copy failed'))
      return Promise.resolve({ rows: [] })
    })

    await expect(startWorkout('workout', undefined, 'source')).rejects.toThrow('copy failed')
    const queries = mockExecute.mock.calls.map(([arg]) => collapseWs(sqlText(arg)))
    expect(queries.some((q) => /DELETE FROM workouts WHERE id = .* AND status = 'active'/.test(q))).toBe(true)
  })

  it('deletes its new active row when the finished read model cannot be reloaded', async () => {
    mockExecute.mockReset()
    mockExecute.mockImplementation((arg: unknown) => {
      const q = collapseWs(sqlText(arg))
      if (/SELECT id FROM workouts WHERE status = 'active'/.test(q)) {
        return Promise.resolve({ rows: [] })
      }
      if (/INSERT INTO workouts/.test(q)) return Promise.resolve({ rows: [{ id: 'orphan-risk' }] })
      return Promise.resolve({ rows: [] })
    })

    await expect(startWorkout('empty')).rejects.toThrow('could not be reloaded')
    const queries = mockExecute.mock.calls.map(([arg]) => collapseWs(sqlText(arg)))
    expect(queries.some((q) => /DELETE FROM workouts WHERE id = .* AND status = 'active'/.test(q))).toBe(true)
  })
})

// #1857, reported live: start a proposed workout, then cancel it, and
// the staged suggestion was gone — nothing left to restart from, as if the plan
// had been thrown away. Starting moves the proposal 'proposed' → 'started'
// (which un-stages it); cancelling never put it back.
describe('discardWorkout re-stages the proposal it consumed (#1857)', () => {
  function sqlText(call: unknown[]): string {
    return JSON.stringify(call[0] ?? '')
  }
  const restageCalls = () =>
    mockExecute.mock.calls.filter(
      (c) => sqlText(c).includes('workout_proposals') && sqlText(c).includes('proposed'),
    )

  it('puts the suggestion back when the session came from one', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: 'w1', proposal_id: 'p1' }] })
      .mockResolvedValueOnce({ rows: [] })
    expect(await discardWorkout('w1')).toBe(true)
    expect(restageCalls()).toHaveLength(1)
  })

  it('does nothing for a session that was not started from a proposal', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'w1', proposal_id: null }] })
    expect(await discardWorkout('w1')).toBe(true)
    expect(restageCalls()).toHaveLength(0)
  })

  // The transition is rowcount-guarded on 'active', so a second cancel is a
  // no-op — it must not resurrect a proposal a later session already consumed.
  it('does not re-stage when the workout was not active to begin with', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] })
    expect(await discardWorkout('w1')).toBe(false)
    expect(restageCalls()).toHaveLength(0)
  })

  // Only a proposal still sitting at 'started' is restorable; one that has been
  // superseded, dismissed, or consumed by a finished session must stay put.
  it('guards the restore on the proposal still being started', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: 'w1', proposal_id: 'p1' }] })
      .mockResolvedValueOnce({ rows: [] })
    await discardWorkout('w1')
    expect(sqlText(restageCalls()[0]!)).toContain('started')
  })
})

// #1835. The user asked mid-workout "what was my discrepancy from the timer?" and the
// data could not answer: rest_seconds echoed the PRESCRIPTION on every set
// (150/150/150), so actual pacing was invisible. `created_at` cannot substitute —
// prescription rows are materialized at workout start, so they all share one
// timestamp. A completion stamp is the only thing that measures anything.
describe('set completion is timestamped (#1835)', () => {
  const upsertText = () =>
    mockExecute.mock.calls
      .map(([arg]) => collapseWs(sqlText(arg)))
      .find((t) => t.includes('completed_at'))

  it('stamps a set on the transition to completed', async () => {
    installDb()
    await upsertSets(WORKOUT_ID, [set()], 0)
    const text = upsertText()
    expect(text).toBeDefined()
    expect(text).toMatch(/completed_at/)
  })

  // Editing a completed set's weight must not move when it happened, and
  // unchecking then rechecking is a correction — not a second performance.
  it('never re-stamps a set that already carries a time, and clears on uncheck', async () => {
    installDb()
    await upsertSets(WORKOUT_ID, [set()], 0)
    const text = upsertText()!
    expect(text).toMatch(/completed_at IS NOT NULL/)
    expect(text).toMatch(/EXCLUDED.completed = false/)
  })
})
