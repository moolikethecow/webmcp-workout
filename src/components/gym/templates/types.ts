/**
 * Client type contract for the Gym Templates builder (GYM_PLAN §4 "Tab:
 * Templates"). Mirrors the server shapes in lib/gym/templates-read.ts exactly —
 * every field is load-bearing across the API seam.
 *
 *   GET   /api/gym/templates?view=cards[&archived=1]  → TemplateCardsResponse
 *   GET   /api/gym/templates/[id]                     → { template: TemplateEditorData }
 *   POST  /api/gym/templates  {name,folder?,notes?,exercises[]} → { template }
 *   POST  /api/gym/templates  {duplicateOf}           → { template }
 *   PATCH /api/gym/templates/[id] {name,exercises[]}  → { template }
 *   PATCH /api/gym/templates/[id] {archived}          → { archived }
 *   DELETE /api/gym/templates/[id]                    → { archived:true }
 */

export type ProgressionUnit = 'lb' | 'kg'

/** One exact ordered set prescription inside a template exercise. */
export interface EditorTemplateSet {
  setNumber: number
  setType: 'warmup' | 'normal' | 'drop' | 'failure'
  targetWeight: number | null
  targetWeightUnit: ProgressionUnit
  targetReps: number | null
  targetDistanceM: number | null
  targetDurationS: number | null
  targetRpe: number | null
  restSeconds: number | null
  side: 'left' | 'right' | null
}

/** One template card on the Templates tab. */
export interface TemplateCard {
  id: string
  name: string
  folder: string | null
  notes: string | null
  source: string
  exerciseCount: number
  lastPerformed: string | null
  exercisePreview: string[]
  archived: boolean
}

export interface TemplateFolderGroup {
  folder: string | null
  templates: TemplateCard[]
}

export interface TemplateCardsResponse {
  folders: TemplateFolderGroup[]
  allFolders: string[]
}

/** One exercise slot as the builder edits it (server → client). */
export interface EditorExercise {
  exerciseId: string
  name: string
  tracks: string
  preferredUnit: ProgressionUnit | null
  position: number
  targetSets: number | null
  targetReps: number | null
  targetWeight: number | null
  /** Unit targetWeight is displayed/edited in (the app-wide setting). */
  targetWeightUnit: ProgressionUnit
  targetDurationS: number | null
  restSeconds: number | null
  restSecondsWarmup: number | null
  supersetGroup: number | null
  section: 'warmup' | 'main' | 'cooldown'
  /** Exact rows take precedence over the scalar compatibility summary above. */
  sets: EditorTemplateSet[]
  progression: unknown
  notes: string | null
}

export interface TemplateEditorData {
  id: string
  name: string
  folder: string | null
  notes: string | null
  source: string
  archived: boolean
  exercises: EditorExercise[]
}

/** One exercise slot in the save payload (client → server). */
export interface EditorExerciseInput {
  exerciseId: string
  position: number
  targetSets?: number | null
  targetReps?: number | null
  targetWeight?: number | null
  targetWeightUnit?: ProgressionUnit | null
  targetDurationS?: number | null
  restSeconds?: number | null
  restSecondsWarmup?: number | null
  supersetGroup?: number | null
  section?: 'warmup' | 'main' | 'cooldown' | null
  sets?: EditorTemplateSet[]
  progression?: unknown
  notes?: string | null
}

export interface TemplateEditorPayload {
  name: string
  folder?: string | null
  notes?: string | null
  exercises: EditorExerciseInput[]
}

// ── Progression policy shapes (mirror lib/gym/progression.ts §2.5) ────────────

export type PolicyType =
  | 'last_time'
  | 'double_progression'
  | 'linear'
  | 'rep_only'
  | 'rpe_target'

/** The picker only authors the 5 named policy types (the composable `rule` type is
 *  chat-authored in P3). Stored as the §2.5 JSON on template_exercises.progression. */
export interface LastTimePolicy {
  type: 'last_time'
}
export interface DoubleProgressionPolicy {
  type: 'double_progression'
  repRange: [number, number]
  increment: number
  deloadAfterMisses?: number
  deloadPct?: number
}
export interface LinearPolicy {
  type: 'linear'
  increment: number
}
export interface RepOnlyPolicy {
  type: 'rep_only'
  addRepWhen: { repsAtLeast: number }
  addReps?: number
  capReps?: number
}
export interface RpeTargetPolicy {
  type: 'rpe_target'
  rpe: number
}

export type EditablePolicy =
  | LastTimePolicy
  | DoubleProgressionPolicy
  | LinearPolicy
  | RepOnlyPolicy
  | RpeTargetPolicy
