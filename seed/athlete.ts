/**
 * The demo athlete — "Sam" (fictional; no real person).
 *
 * Pure data module: no DB, no imports from src/lib/db/**. `src/lib/workspace/
 * seed.ts` turns this into rows. Every date is computed from a `now` the
 * caller supplies (never hardcoded), so the seeded history always ends
 * YESTERDAY relative to whenever it's provisioned.
 *
 * Exercise names are copied VERBATIM from seed/catalog.json's `raw_name`
 * (== src/lib/fitness/exercise-catalog.json's `name`) — the vendored
 * free-exercise-db catalog, all lower-case, often verbose. There is no
 * "Barbell Back Squat" or "Face Pull" in that catalog; the closest real
 * entries are used instead (see the comment on each key below). The app's
 * `displayExerciseName()` title-cases these for display — this file never
 * pre-formats them.
 *
 * THE STORY (what the seeded history is built to demonstrate on /health):
 *  - Incline DB press: a clean double-progression arc across all 6 of its
 *    Upper-A appearances — 65x10/10/9 -> 70x9/9/8 -> 70x10/10/9 -> 75x8/8/8
 *    -> 75x9/9/8 -> 75x10/10/10 — so "load 80 next time" is the obviously
 *    correct answer to "what's next".
 *  - Squat + leg press: steady linear gains, one plate/one increment every
 *    session, no plateau.
 *  - Lat pulldown + seated row: genuinely flat across all 6 Upper-A sessions
 *    (identical weight/reps every time) — a real plateau, not noise.
 *  - Hamstrings + calves: well-trained through week 5, then nearly abandoned
 *    — the last volume either region sees is a single 2-set cameo 9 days
 *    before `now`, then nothing. That reads as `undertrained` (>5 days since
 *    + <2 weighted sets in the trailing 7 days) without ever going to zero
 *    history.
 *  - Back (lats/mid_back): last real pulling work is the Upper-A session 6
 *    days before `now` — stale relative to the final week, but still inside
 *    the 60-day recovery window.
 *  - Chest + triceps: hit in the very last session (1 day before `now`), so
 *    the map shows them `recovering` opposite hamstrings/calves being
 *    `undertrained` and back reading `fresh` — an obvious three-way spread.
 *  - Delts get partial SECONDARY credit from that last chest/triceps session
 *    (bench/fly rules always secondary-credit delts in lib/fitness/muscles.ts)
 *    — that's the app's coarse region model, not a seeding bug. `mid_back`
 *    is the cleaner "back" signal for the stale side of the story.
 */

export const UNIT = 'lb' as const

// ---------------------------------------------------------------------------
// Exercise names — verbatim catalog `raw_name` strings. Verified to exist
// 1:1 in both src/lib/fitness/exercise-catalog.json and seed/catalog.json.
// ---------------------------------------------------------------------------
export const EXERCISE_NAMES = {
  /** The star of the progression story. Catalog has no plain "Incline
   *  Dumbbell Bench Press" — this is its exact entry. */
  inclineBench: 'dumbbell incline bench press',
  /** Catalog has no "Barbell Back Squat"; this is FEDB's back-squat entry
   *  (glutes/quads primary, barbell). */
  squat: 'barbell full squat',
  romanianDeadlift: 'barbell romanian deadlift',
  /** Catalog has no plain "Lat Pulldown"; this is the closest full-ROM cable
   *  pulldown entry. */
  latPulldown: 'cable lat pulldown full range of motion',
  /** Exact match for "Seated Cable Row". */
  seatedRow: 'cable seated row',
  /** Catalog has no plain "Dumbbell Shoulder Press"; the seated variant. */
  shoulderPress: 'dumbbell seated shoulder press',
  /** Catalog has no plain "Leg Press"; this is the sled 45-degree entry. */
  legPress: 'sled 45° leg press (side pov)',
  /** Exact match for "Lying Leg Curl". */
  legCurl: 'lever lying leg curl',
  /** Catalog has no plain "Dumbbell Curl"; this is its bare biceps-curl entry. */
  dbCurl: 'dumbbell biceps curl',
  /** Exact match for "Triceps Pushdown" (v-bar). */
  tricepsPushdown: 'cable triceps pushdown (v-bar)',
  /** Catalog has no plain "Standing Calf Raise"; the dumbbell variant. */
  calfRaise: 'dumbbell standing calf raise',
  /** Catalog has no "Cable Fly"/"Chest Fly" alone; this is its plain cable-fly
   *  entry (chest primary, delts secondary). */
  chestFly: 'cable middle fly',
  /** Catalog has NO "Face Pull" at all. Closest substitute for a rear-delt/
   *  upper-back isolation pull: this rope rear-delt row (delts primary,
   *  mid_back/traps secondary — the same muscles a face pull targets). */
  rearDeltRow: 'cable rear delt row (with rope)',
  /** Catalog has NO real "Hip Thrust" (only a resistance-band variant).
   *  Closest barbell hip-extension substitute: the barbell glute bridge. */
  hipThrust: 'barbell glute bridge',
} as const

export type ExerciseKey = keyof typeof EXERCISE_NAMES

/** Rest between working sets, by exercise (90-180s range per GYM_PLAN norms). */
const REST_SECONDS: Record<ExerciseKey, number> = {
  inclineBench: 150,
  squat: 180,
  romanianDeadlift: 150,
  latPulldown: 120,
  seatedRow: 120,
  shoulderPress: 120,
  legPress: 150,
  legCurl: 90,
  dbCurl: 90,
  tricepsPushdown: 90,
  calfRaise: 90,
  chestFly: 90,
  rearDeltRow: 90,
  hipThrust: 120,
}

export function restSecondsFor(key: ExerciseKey): number {
  return REST_SECONDS[key]
}

// ---------------------------------------------------------------------------
// Gym — a commercial gym with the full equipment vocabulary.
// ---------------------------------------------------------------------------
export const GYM = {
  name: 'Iron Vault Fitness',
  notes: "Sam's regular commercial gym — full equipment, never a bottleneck.",
  equipment: {
    categories: [
      'barbell',
      'dumbbell',
      'machine',
      'cable',
      'body only',
      'kettlebells',
      'bands',
      'e-z curl bar',
      'medicine ball',
      'exercise ball',
      'foam roll',
      'other',
    ] as string[],
    machines: [
      'Smith machine',
      'Assisted pull-up/dip station',
      'Leg press sled',
      'Cable crossover tower',
      'Seated leg curl machine',
      'Hack squat machine',
      'Glute drive machine',
    ] as string[],
    machines_excluded: [] as string[],
  },
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
export interface TemplateExerciseSpec {
  key: ExerciseKey
  targetSets: number
  targetReps: number
  /** Double-progression policy for template_exercises.progression (only the
   *  incline press carries one — the rest default to 'last_time'). */
  progression?: {
    type: 'double_progression'
    repRange: [number, number]
    increment: number
    requiredSets: number
    deloadAfterMisses: number
    deloadPct: number
  }
}

export interface TemplateSpec {
  name: string
  exercises: TemplateExerciseSpec[]
}

const INCLINE_PRESS_PROGRESSION = {
  type: 'double_progression' as const,
  repRange: [8, 10] as [number, number],
  increment: 5,
  requiredSets: 3,
  deloadAfterMisses: 2,
  deloadPct: 10,
}

export const TEMPLATES: Record<'upperA' | 'lowerA', TemplateSpec> = {
  upperA: {
    name: 'Upper A',
    exercises: [
      { key: 'inclineBench', targetSets: 3, targetReps: 9, progression: INCLINE_PRESS_PROGRESSION },
      { key: 'latPulldown', targetSets: 3, targetReps: 8 },
      { key: 'seatedRow', targetSets: 3, targetReps: 10 },
      { key: 'shoulderPress', targetSets: 3, targetReps: 9 },
      { key: 'dbCurl', targetSets: 3, targetReps: 10 },
      { key: 'tricepsPushdown', targetSets: 3, targetReps: 11 },
    ],
  },
  lowerA: {
    name: 'Lower A',
    exercises: [
      { key: 'squat', targetSets: 3, targetReps: 8 },
      { key: 'romanianDeadlift', targetSets: 3, targetReps: 10 },
      { key: 'legPress', targetSets: 3, targetReps: 10 },
      { key: 'legCurl', targetSets: 3, targetReps: 11 },
      { key: 'calfRaise', targetSets: 3, targetReps: 15 },
    ],
  },
}

// ---------------------------------------------------------------------------
// Training plan — "Base Block". Mirrors DEFAULT_POLICY in
// src/lib/gym/training-plans.ts exactly (double progression, 8-10 reps, +5 lb).
// ---------------------------------------------------------------------------
export const TRAINING_PLAN = {
  name: 'Base Block',
  goal: 'Build a strength base with double progression on the primary lifts',
  scheduleMode: 'flexible' as const,
  policy: {
    progression: {
      type: 'double_progression',
      repRange: [8, 10],
      increment: 5,
      requiredSets: 3,
      deloadAfterMisses: 2,
      deloadPct: 10,
    },
    applyToUnconfiguredExercises: true,
    autoAdjustTargets: true,
    reviewEverySessions: 4,
    programming: {
      goal: 'balanced',
      order: 'fatigue_aware',
      supersets: 'history',
      warmups: 'ramp',
      history: 'bounded',
    },
    blocks: [] as unknown[],
    repeatBlocks: false,
  },
  days: [
    { name: 'Upper A', templateKey: 'upperA' as const, weekday: null as number | null },
    { name: 'Lower A', templateKey: 'lowerA' as const, weekday: null as number | null },
  ],
}

// ---------------------------------------------------------------------------
// Resolved constraint — left knee, nagging, resolved 3 weeks ago. No active
// injury: the demo can create one live.
// ---------------------------------------------------------------------------
export const RESOLVED_INJURY = {
  /** 'knees' is a canonical InjurySite/MuscleRegion (joint/mobility-only). */
  region: 'knees' as const,
  label: 'Left knee',
  note: 'Anterior ache after high-rep leg press days; backed off depth, physio cleared it.',
  severity: 'nagging' as const,
  startedDaysAgo: 35,
  resolvedDaysAgo: 21,
}

// ---------------------------------------------------------------------------
// Workout history — 6 weeks, 3x/week, upper/lower/full rotation, 18 sessions,
// ending YESTERDAY (daysAgo: 1) relative to `now`. Oldest first.
//
// `exercises[0]` of every workout gets 2 warmup sets prepended automatically
// (see buildSetPlan in src/lib/workspace/seed.ts) — sets listed here are the
// WORKING sets only, as {weight, reps} pairs.
// ---------------------------------------------------------------------------
export interface ExerciseLog {
  key: ExerciseKey
  /** Working-set reps, in order. Length is normally 3; a couple of sessions
   *  deliberately log only 2 (an abbreviated/quick session, and the
   *  hamstring/calf cameo that drives the under-trained story). */
  sets: Array<{ weight: number; reps: number }>
}

export interface WorkoutLog {
  /** Whole days before `now` this session was logged. 1 = yesterday. */
  daysAgo: number
  name: string
  templateKey: 'upperA' | 'lowerA' | null
  startHour: number
  durationMinutes: number
  exercises: ExerciseLog[]
}

function sets(weight: number, reps: number[]): Array<{ weight: number; reps: number }> {
  return reps.map((r) => ({ weight, reps: r }))
}

export const WORKOUTS: WorkoutLog[] = [
  // n1 — Upper A (daysAgo 41)
  {
    daysAgo: 41,
    name: 'Upper A',
    templateKey: 'upperA',
    startHour: 18,
    durationMinutes: 58,
    exercises: [
      { key: 'inclineBench', sets: sets(65, [10, 10, 9]) },
      { key: 'latPulldown', sets: sets(120, [8, 8, 8]) },
      { key: 'seatedRow', sets: sets(100, [10, 10, 9]) },
      { key: 'shoulderPress', sets: sets(45, [10, 9, 8]) },
      { key: 'dbCurl', sets: sets(30, [10, 10, 9]) },
      { key: 'tricepsPushdown', sets: sets(50, [12, 11, 10]) },
    ],
  },
  // n2 — Lower A (daysAgo 38)
  {
    daysAgo: 38,
    name: 'Lower A',
    templateKey: 'lowerA',
    startHour: 17,
    durationMinutes: 55,
    exercises: [
      { key: 'squat', sets: sets(165, [8, 8, 8]) },
      { key: 'romanianDeadlift', sets: sets(135, [10, 10, 9]) },
      { key: 'legPress', sets: sets(230, [10, 10, 10]) },
      { key: 'legCurl', sets: sets(90, [12, 11, 10]) },
      { key: 'calfRaise', sets: sets(40, [15, 15, 14]) },
    ],
  },
  // n3 — Full Body (daysAgo 36) — ad hoc, no template
  {
    daysAgo: 36,
    name: 'Full Body',
    templateKey: null,
    startHour: 19,
    durationMinutes: 47,
    exercises: [
      { key: 'chestFly', sets: sets(25, [12, 11, 10]) },
      { key: 'rearDeltRow', sets: sets(40, [12, 12, 11]) },
      { key: 'dbCurl', sets: sets(30, [10, 10, 9]) },
      { key: 'hipThrust', sets: sets(95, [10, 10, 9]) },
    ],
  },
  // n4 — Upper A (daysAgo 34)
  {
    daysAgo: 34,
    name: 'Upper A',
    templateKey: 'upperA',
    startHour: 18,
    durationMinutes: 60,
    exercises: [
      { key: 'inclineBench', sets: sets(70, [9, 9, 8]) },
      { key: 'latPulldown', sets: sets(120, [8, 8, 8]) },
      { key: 'seatedRow', sets: sets(100, [10, 10, 9]) },
      { key: 'shoulderPress', sets: sets(45, [10, 9, 8]) },
      { key: 'dbCurl', sets: sets(30, [10, 10, 9]) },
      { key: 'tricepsPushdown', sets: sets(50, [12, 11, 10]) },
    ],
  },
  // n5 — Lower A (daysAgo 31)
  {
    daysAgo: 31,
    name: 'Lower A',
    templateKey: 'lowerA',
    startHour: 17,
    durationMinutes: 56,
    exercises: [
      { key: 'squat', sets: sets(170, [8, 8, 8]) },
      { key: 'romanianDeadlift', sets: sets(140, [10, 10, 9]) },
      { key: 'legPress', sets: sets(250, [10, 10, 9]) },
      { key: 'legCurl', sets: sets(95, [12, 11, 10]) },
      { key: 'calfRaise', sets: sets(45, [15, 14, 14]) },
    ],
  },
  // n6 — Full Body (daysAgo 29)
  {
    daysAgo: 29,
    name: 'Full Body',
    templateKey: null,
    startHour: 19,
    durationMinutes: 49,
    exercises: [
      { key: 'chestFly', sets: sets(25, [12, 12, 11]) },
      { key: 'rearDeltRow', sets: sets(40, [12, 12, 12]) },
      { key: 'hipThrust', sets: sets(105, [10, 10, 9]) },
      { key: 'calfRaise', sets: sets(45, [15, 15, 14]) },
    ],
  },
  // n7 — Upper A (daysAgo 27)
  {
    daysAgo: 27,
    name: 'Upper A',
    templateKey: 'upperA',
    startHour: 18,
    durationMinutes: 61,
    exercises: [
      { key: 'inclineBench', sets: sets(70, [10, 10, 9]) },
      { key: 'latPulldown', sets: sets(120, [8, 8, 8]) },
      { key: 'seatedRow', sets: sets(100, [10, 10, 9]) },
      { key: 'shoulderPress', sets: sets(45, [10, 9, 8]) },
      { key: 'dbCurl', sets: sets(30, [10, 10, 9]) },
      { key: 'tricepsPushdown', sets: sets(50, [12, 11, 10]) },
    ],
  },
  // n8 — Lower A (daysAgo 24)
  {
    daysAgo: 24,
    name: 'Lower A',
    templateKey: 'lowerA',
    startHour: 17,
    durationMinutes: 57,
    exercises: [
      { key: 'squat', sets: sets(175, [8, 8, 7]) },
      { key: 'romanianDeadlift', sets: sets(145, [10, 9, 9]) },
      { key: 'legPress', sets: sets(270, [10, 10, 10]) },
      { key: 'legCurl', sets: sets(95, [12, 12, 11]) },
      { key: 'calfRaise', sets: sets(45, [15, 15, 14]) },
    ],
  },
  // n9 — Full Body (daysAgo 22)
  {
    daysAgo: 22,
    name: 'Full Body',
    templateKey: null,
    startHour: 19,
    durationMinutes: 48,
    exercises: [
      { key: 'chestFly', sets: sets(30, [12, 11, 10]) },
      { key: 'rearDeltRow', sets: sets(45, [12, 11, 11]) },
      { key: 'dbCurl', sets: sets(30, [10, 10, 9]) },
      { key: 'tricepsPushdown', sets: sets(50, [12, 11, 10]) },
    ],
  },
  // n10 — Upper A (daysAgo 20)
  {
    daysAgo: 20,
    name: 'Upper A',
    templateKey: 'upperA',
    startHour: 18,
    durationMinutes: 62,
    exercises: [
      { key: 'inclineBench', sets: sets(75, [8, 8, 8]) },
      { key: 'latPulldown', sets: sets(120, [8, 8, 8]) },
      { key: 'seatedRow', sets: sets(100, [10, 10, 9]) },
      { key: 'shoulderPress', sets: sets(45, [10, 9, 8]) },
      { key: 'dbCurl', sets: sets(30, [10, 10, 9]) },
      { key: 'tricepsPushdown', sets: sets(50, [12, 11, 10]) },
    ],
  },
  // n11 — Lower A (daysAgo 17)
  {
    daysAgo: 17,
    name: 'Lower A',
    templateKey: 'lowerA',
    startHour: 17,
    durationMinutes: 58,
    exercises: [
      { key: 'squat', sets: sets(180, [8, 8, 8]) },
      { key: 'romanianDeadlift', sets: sets(150, [10, 10, 9]) },
      { key: 'legPress', sets: sets(290, [9, 9, 9]) },
      { key: 'legCurl', sets: sets(100, [12, 11, 10]) },
      { key: 'calfRaise', sets: sets(50, [15, 14, 14]) },
    ],
  },
  // n12 — Full Body (daysAgo 15)
  {
    daysAgo: 15,
    name: 'Full Body',
    templateKey: null,
    startHour: 19,
    durationMinutes: 50,
    exercises: [
      { key: 'chestFly', sets: sets(30, [12, 12, 11]) },
      { key: 'rearDeltRow', sets: sets(45, [12, 12, 11]) },
      { key: 'hipThrust', sets: sets(115, [10, 10, 10]) },
      { key: 'dbCurl', sets: sets(30, [10, 10, 9]) },
    ],
  },
  // n13 — Upper A (daysAgo 13)
  {
    daysAgo: 13,
    name: 'Upper A',
    templateKey: 'upperA',
    startHour: 18,
    durationMinutes: 63,
    exercises: [
      { key: 'inclineBench', sets: sets(75, [9, 9, 8]) },
      { key: 'latPulldown', sets: sets(120, [8, 8, 8]) },
      { key: 'seatedRow', sets: sets(100, [10, 10, 9]) },
      { key: 'shoulderPress', sets: sets(45, [10, 9, 8]) },
      { key: 'dbCurl', sets: sets(30, [10, 10, 9]) },
      { key: 'tricepsPushdown', sets: sets(50, [12, 11, 10]) },
    ],
  },
  // n14 — Lower A (daysAgo 11) — last FULL lower day before the drop-off;
  // just outside the "last 10 days" window.
  {
    daysAgo: 11,
    name: 'Lower A',
    templateKey: 'lowerA',
    startHour: 17,
    durationMinutes: 59,
    exercises: [
      { key: 'squat', sets: sets(185, [7, 7, 7]) },
      { key: 'romanianDeadlift', sets: sets(155, [9, 9, 8]) },
      { key: 'legPress', sets: sets(310, [10, 10, 10]) },
      { key: 'legCurl', sets: sets(100, [12, 12, 11]) },
      { key: 'calfRaise', sets: sets(50, [15, 15, 14]) },
    ],
  },
  // n15 — Full Body (daysAgo 9) — the hamstring/calf cameo: 2 sets each, then
  // nothing touches those regions again in the seeded history.
  {
    daysAgo: 9,
    name: 'Full Body',
    templateKey: null,
    startHour: 19,
    durationMinutes: 46,
    exercises: [
      { key: 'legCurl', sets: sets(100, [12, 11]) },
      { key: 'calfRaise', sets: sets(50, [15, 14]) },
      { key: 'chestFly', sets: sets(30, [12, 11, 10]) },
      { key: 'dbCurl', sets: sets(30, [10, 10, 9]) },
    ],
  },
  // n16 — Upper A (daysAgo 6) — incline press closes its progression arc;
  // last real back (lats/mid_back) volume in the seeded history.
  {
    daysAgo: 6,
    name: 'Upper A',
    templateKey: 'upperA',
    startHour: 18,
    durationMinutes: 64,
    exercises: [
      { key: 'inclineBench', sets: sets(75, [10, 10, 10]) },
      { key: 'latPulldown', sets: sets(120, [8, 8, 8]) },
      { key: 'seatedRow', sets: sets(100, [10, 10, 9]) },
      { key: 'shoulderPress', sets: sets(45, [10, 9, 8]) },
      { key: 'dbCurl', sets: sets(30, [10, 10, 9]) },
      { key: 'tricepsPushdown', sets: sets(50, [12, 11, 10]) },
    ],
  },
  // n17 — Full Body, upper accessory only (daysAgo 3). NOT a leg day: squat/
  // leg press/RDL/leg curl/calf raise ALSO secondary-credit hamstrings (see
  // the "squat" and "glute"/"hip thrust" RULES in lib/fitness/muscles.ts) and
  // glute-bridge secondary-credits hamstrings too — any of them here would
  // refresh the hamstring "last worked" clock and erase the under-trained
  // story. Squat/leg press's last appearance is n14 (daysAgo 11); their
  // linear-gain arc is 5 points, not 6, by design — the tail of the plan
  // genuinely stops loading legs while push/pull work continues, which is
  // exactly what "hamstrings/calves undertrained" means as a training fact.
  {
    daysAgo: 3,
    name: 'Full Body',
    templateKey: null,
    startHour: 18,
    durationMinutes: 42,
    exercises: [
      { key: 'dbCurl', sets: sets(30, [10, 10, 9]) },
      { key: 'tricepsPushdown', sets: sets(50, [12, 11, 10]) },
      { key: 'shoulderPress', sets: sets(45, [10, 9, 8]) },
      { key: 'chestFly', sets: sets(30, [12, 11, 10]) },
    ],
  },
  // n18 — Full Body, "yesterday" (daysAgo 1) — chest + triceps (+ shoulders),
  // no back/delt-ROW work and no leg/glute/hamstring-touching movement (no
  // hip thrust here either — same secondary-hamstring reason as n17), so
  // chest/triceps read `recovering` opposite a stale back and undertrained
  // hamstrings/calves.
  {
    daysAgo: 1,
    name: 'Full Body',
    templateKey: null,
    startHour: 18,
    durationMinutes: 45,
    exercises: [
      { key: 'chestFly', sets: sets(35, [12, 11, 10]) },
      { key: 'tricepsPushdown', sets: sets(50, [12, 11, 10]) },
      { key: 'dbCurl', sets: sets(30, [10, 10, 9]) },
      { key: 'shoulderPress', sets: sets(45, [10, 9, 8]) },
    ],
  },
]

/**
 * Compute the start time for a workout, `daysAgo` whole days before `now`, at
 * `startHour:00`.
 *
 * Anchored on `now`'s UTC calendar date (not the machine's local date) and
 * expressed in UTC, deliberately: the readiness math this seed is built to
 * demonstrate (`daysSinceDate` in src/lib/fitness/muscle-state.ts) computes
 * "today" via `Date.UTC(now.getUTCFullYear(), ...)`, and the DB casts
 * `started_at::date` under the session's `TimeZone` (UTC on this stack's
 * Postgres — verified via `SHOW TimeZone`). Building this date from
 * LOCAL-time `Date#setDate`/`setHours` instead would silently drift by a day
 * whenever the machine's local calendar date and the UTC calendar date
 * disagree (e.g. any time after ~20:00 US-Eastern, once UTC has already
 * rolled to the next day) — exactly the kind of skew that turned "trained
 * yesterday" into "trained 2 days ago" the first time this was verified.
 */
export function workoutStartDate(now: Date, daysAgo: number, startHour: number): Date {
  const utcMidnightToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return new Date(utcMidnightToday - daysAgo * 86_400_000 + startHour * 3_600_000)
}
