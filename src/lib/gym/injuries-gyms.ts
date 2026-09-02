/**
 * Injuries + gyms CRUD read/write model (GYM_PLAN §4 settings sheet, §6 dislike-
 * learning). Backs /api/gym/injuries + /api/gym/gyms and the logger reason chips.
 * DB glue only — the route handlers stay thin (auth + ensureGymSchema + shape) and
 * delegate here.
 *
 * ── The "active injury" convention (decided here, documented once) ──
 * An injury is ACTIVE when `resolved_at IS NULL OR resolved_at > now()`. This is
 * the single convention across every reader:
 *   - a genuinely open injury has resolved_at = NULL;
 *   - the logger's "Tweaked" chip writes a PRE-RESOLVED-IN-FUTURE injury
 *     (resolved_at = now()+7d) — an auto-expiring SOFT flag that reads as active
 *     until its window lapses, then silently drops out with no cleanup job.
 * `resolvedActivePredicate` is the shared SQL fragment so no reader re-derives it.
 *
 * (This used to warn that coach-context's readInjuries filtered `resolved_at IS
 * NULL` only and would miss "Tweaked" flags. STALE as of 2026-07-27 — verified:
 * coach-context.ts already uses the full `resolved_at IS NULL OR resolved_at >
 * now()`, so the safety gate does see soft flags. The third reader,
 * `activeInjurySignals` in lib/personalization/synth-models.ts, matches it too.
 * Any NEW reader must use this same predicate: filtering on `IS NULL` alone
 * silently drops every auto-expiring tweak.)
 */
import { sql, type SQL } from 'drizzle-orm'

import { db } from '@/lib/db/client'
import { isMuscleRegion } from '@/lib/fitness/muscles'
import { isInjurySite, type InjurySite } from './injury-profile'

// ---------------------------------------------------------------------------
// Equipment vocabulary (FEDB canonical tokens) — the My-Gyms checklist source.
// ---------------------------------------------------------------------------

/** FEDB's canonical equipment vocabulary (public-domain, stable). The My-Gyms
 *  editor renders this as the equipment checklist; the same list backs the
 *  Exercises-tab equipment filter (kept in lockstep with ExercisesTab). */
export const GYM_EQUIPMENT_VOCAB = [
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
] as const

export type GymEquipmentToken = (typeof GYM_EQUIPMENT_VOCAB)[number]

const VOCAB_SET = new Set<string>(GYM_EQUIPMENT_VOCAB)

export function isEquipmentToken(s: string): s is GymEquipmentToken {
  return VOCAB_SET.has(s)
}

// ---------------------------------------------------------------------------
// Injuries
// ---------------------------------------------------------------------------

export const INJURY_SEVERITIES = ['nagging', 'limiting', 'out'] as const
export type InjurySeverity = (typeof INJURY_SEVERITIES)[number]

const SEVERITY_SET = new Set<string>(INJURY_SEVERITIES)
export function isInjurySeverity(s: string): s is InjurySeverity {
  return SEVERITY_SET.has(s)
}

export interface Injury {
  id: string
  region: InjurySite
  label: string | null
  note: string | null
  severity: InjurySeverity | null
  startedAt: string | null
  resolvedAt: string | null
  createdAt: string
  /** Derived: active when unresolved OR resolved in the future (auto-expiring). */
  active: boolean
}

interface InjuryRowRaw {
  id: string
  region: string
  label: string | null
  note: string | null
  severity: string | null
  started_at: string | null
  resolved_at: string | null
  created_at: string
}

/** The shared "active" SQL predicate — resolved_at NULL or still in the future. */
function resolvedActivePredicate(): SQL {
  return sql`(resolved_at IS NULL OR resolved_at > now())`
}

function mapInjury(r: InjuryRowRaw): Injury {
  const active = r.resolved_at == null || Date.parse(r.resolved_at) > Date.now()
  return {
    id: r.id,
    region: r.region as InjurySite,
    label: r.label,
    note: r.note,
    severity: (r.severity as InjurySeverity | null) ?? null,
    startedAt: r.started_at,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    active,
  }
}

/** List injuries. `active` → only currently-active (unresolved or future-resolved);
 *  otherwise all rows (active + resolved), newest first. */
export async function listInjuries(activeOnly: boolean): Promise<Injury[]> {
  const where = activeOnly ? sql`WHERE ${resolvedActivePredicate()}` : sql``
  const rows = (
    await db.execute(sql`
      SELECT id, region, label, note, severity,
        started_at::text AS started_at, resolved_at::text AS resolved_at,
        created_at::text AS created_at
      FROM injuries
      ${where}
      ORDER BY (${resolvedActivePredicate()}) DESC, created_at DESC
    `)
  ).rows as unknown as InjuryRowRaw[]
  return rows.map(mapInjury)
}

export interface CreateInjuryInput {
  region: string
  label?: string | null
  note?: string | null
  severity?: string | null
  /** ISO timestamp — the auto-resolve moment ("Tweaked" chip sets now()+7d). */
  resolvedAt?: string | null
}

/** Create an injury. Returns null when the region isn't a canonical InjurySite
 *  (the caller returns 400) — the write path is the safety gate. */
export async function createInjury(input: CreateInjuryInput): Promise<Injury | null> {
  if (typeof input.region !== 'string' || !isInjurySite(input.region)) return null
  const severity =
    typeof input.severity === 'string' && isInjurySeverity(input.severity) ? input.severity : 'nagging'
  const label = input.label ?? null
  const note = input.note ?? null
  const resolvedAt = input.resolvedAt ?? null

  const rows = (
    await db.execute(sql`
      INSERT INTO injuries (region, label, note, severity, started_at, resolved_at)
      VALUES (${input.region}, ${label}, ${note}, ${severity}, now(), ${resolvedAt})
      RETURNING id, region, label, note, severity,
        started_at::text AS started_at, resolved_at::text AS resolved_at,
        created_at::text AS created_at
    `)
  ).rows as unknown as InjuryRowRaw[]
  return rows[0] ? mapInjury(rows[0]) : null
}

export interface UpdateInjuryInput {
  label?: string | null
  note?: string | null
  severity?: string | null
  /** true → resolve now; false → clear (reopen); a string → set explicit resolve time. */
  resolve?: boolean | string
}

/** Patch an injury (label/note/severity/resolve). Returns the updated row, or null
 *  when the id doesn't exist (rowcount-honest 404). */
export async function updateInjury(id: string, input: UpdateInjuryInput): Promise<Injury | null> {
  const sets: SQL[] = []
  if (input.label !== undefined) sets.push(sql`label = ${input.label}`)
  if (input.note !== undefined) sets.push(sql`note = ${input.note}`)
  if (input.severity !== undefined) {
    const sev =
      typeof input.severity === 'string' && isInjurySeverity(input.severity) ? input.severity : null
    if (sev) sets.push(sql`severity = ${sev}`)
  }
  if (input.resolve !== undefined) {
    if (input.resolve === true) sets.push(sql`resolved_at = now()`)
    else if (input.resolve === false) sets.push(sql`resolved_at = NULL`)
    else if (typeof input.resolve === 'string') sets.push(sql`resolved_at = ${input.resolve}`)
  }
  // #1680: any real patch is a human looking at the row — stamp it, so the
  // energy-state synthesis can tell a live severity label from a month-old one.
  if (sets.length > 0) sets.push(sql`updated_at = now()`)
  if (sets.length === 0) {
    // No-op patch → read-back (still 404 on a missing id).
    const rows = (
      await db.execute(sql`
        SELECT id, region, label, note, severity,
          started_at::text AS started_at, resolved_at::text AS resolved_at,
          created_at::text AS created_at
        FROM injuries WHERE id = ${id} LIMIT 1
      `)
    ).rows as unknown as InjuryRowRaw[]
    return rows[0] ? mapInjury(rows[0]) : null
  }
  const rows = (
    await db.execute(sql`
      UPDATE injuries SET ${sql.join(sets, sql`, `)}
      WHERE id = ${id}
      RETURNING id, region, label, note, severity,
        started_at::text AS started_at, resolved_at::text AS resolved_at,
        created_at::text AS created_at
    `)
  ).rows as unknown as InjuryRowRaw[]
  return rows[0] ? mapInjury(rows[0]) : null
}

/** Hard-delete an injury. Returns true when a row was removed (404 otherwise). */
export async function deleteInjury(id: string): Promise<boolean> {
  const rows = (
    await db.execute(sql`DELETE FROM injuries WHERE id = ${id} RETURNING id`)
  ).rows as unknown as { id: string }[]
  return rows.length > 0
}

/** Create an auto-expiring "tweaked" injury from the logger's reason chip: a
 *  pre-resolved-in-future soft region flag (resolved_at = now()+`days`d). Region is
 *  validated; returns null on a non-canonical region. */
export async function createTweakInjury(region: string, days = 7): Promise<Injury | null> {
  if (!isMuscleRegion(region)) return null
  const resolvedAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
  return createInjury({
    region,
    severity: 'nagging',
    label: 'tweaked (auto)',
    note: 'via logger',
    resolvedAt,
  })
}

// ---------------------------------------------------------------------------
// Gyms
// ---------------------------------------------------------------------------

/** The gym `equipment` jsonb: FEDB categories the gym has + free-text machine
 *  names + per-gym excluded exercise names (the "Not available here" chip). */
export interface GymEquipmentPayload {
  categories: string[]
  machines: string[]
  machines_excluded: string[]
}

export interface Gym {
  id: string
  name: string
  equipment: GymEquipmentPayload
  notes: string | null
  isDefault: boolean
  createdAt: string
}

interface GymRowRaw {
  id: string
  name: string
  equipment: unknown
  notes: string | null
  is_default: boolean
  created_at: string
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Coerce a raw request-body `equipment` value into a partial payload (route glue;
 *  the create/update paths sanitize further via `cleanEquipment`). Non-object → an
 *  empty partial. Lives here (not in the route module) because Next.js route files
 *  may only export HTTP handlers. */
export function pickEquipment(v: unknown): Partial<GymEquipmentPayload> {
  if (!v || typeof v !== 'object') return {}
  const o = v as Record<string, unknown>
  return {
    categories: toStringArray(o.categories),
    machines: toStringArray(o.machines),
    machines_excluded: toStringArray(o.machines_excluded),
  }
}

/** Normalize the stored equipment jsonb (flat array OR structured) into the full
 *  structured payload the editor round-trips. A legacy flat array becomes
 *  `{categories: [...], machines: [], machines_excluded: []}`. */
export function normalizeGymEquipment(v: unknown): GymEquipmentPayload {
  if (Array.isArray(v)) return { categories: toStringArray(v), machines: [], machines_excluded: [] }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return {
      categories: toStringArray(o.categories),
      machines: toStringArray(o.machines),
      machines_excluded: toStringArray(o.machines_excluded),
    }
  }
  return { categories: [], machines: [], machines_excluded: [] }
}

function mapGym(r: GymRowRaw): Gym {
  return {
    id: r.id,
    name: r.name,
    equipment: normalizeGymEquipment(r.equipment),
    notes: r.notes,
    isDefault: r.is_default,
    createdAt: r.created_at,
  }
}

/** All gyms, default first then newest. */
export async function listGyms(): Promise<Gym[]> {
  const rows = (
    await db.execute(sql`
      SELECT id, name, equipment, notes, is_default, created_at::text AS created_at
      FROM gyms
      ORDER BY is_default DESC, created_at DESC
    `)
  ).rows as unknown as GymRowRaw[]
  return rows.map(mapGym)
}

/** Sanitize an equipment payload: keep only vocab categories, trim machine strings,
 *  dedupe, drop empties. */
function cleanEquipment(input: Partial<GymEquipmentPayload> | undefined): GymEquipmentPayload {
  const categories = [...new Set(toStringArray(input?.categories).map((s) => s.trim().toLowerCase()))].filter(
    (s) => isEquipmentToken(s),
  )
  const machines = [...new Set(toStringArray(input?.machines).map((s) => s.trim()).filter(Boolean))]
  const machines_excluded = [
    ...new Set(toStringArray(input?.machines_excluded).map((s) => s.trim()).filter(Boolean)),
  ]
  return { categories, machines, machines_excluded }
}

export interface CreateGymInput {
  name: string
  equipment?: Partial<GymEquipmentPayload>
  notes?: string | null
  isDefault?: boolean
}

/**
 * Create a gym. When `isDefault` (or it's the first gym), it becomes the sole
 * default — clearing any other default in the SAME transaction so the invariant
 * "exactly one default" holds. Returns the created row.
 */
export async function createGym(input: CreateGymInput): Promise<Gym | null> {
  const name = input.name.trim()
  if (!name) return null
  const equipment = cleanEquipment(input.equipment)
  const notes = input.notes ?? null

  return db.transaction(async (tx) => {
    const existing = (await tx.execute(sql`SELECT count(*)::int AS n FROM gyms`)).rows as unknown as {
      n: number
    }[]
    const isFirst = (existing[0]?.n ?? 0) === 0
    const makeDefault = input.isDefault === true || isFirst
    if (makeDefault) {
      await tx.execute(sql`UPDATE gyms SET is_default = false WHERE is_default = true`)
    }
    const rows = (
      await tx.execute(sql`
        INSERT INTO gyms (name, equipment, notes, is_default)
        VALUES (${name}, ${JSON.stringify(equipment)}::jsonb, ${notes}, ${makeDefault})
        RETURNING id, name, equipment, notes, is_default, created_at::text AS created_at
      `)
    ).rows as unknown as GymRowRaw[]
    return rows[0] ? mapGym(rows[0]) : null
  })
}

export interface UpdateGymInput {
  name?: string
  equipment?: Partial<GymEquipmentPayload>
  notes?: string | null
  /** true → make this the sole default (clears others transactionally). false is a
   *  no-op (can't un-default without promoting another — set another as default). */
  isDefault?: boolean
}

/**
 * Patch a gym. Setting `isDefault:true` clears every other default first, in one
 * transaction (the exactly-one-default invariant). Returns the updated row, or null
 * when the id doesn't exist (rowcount-honest 404).
 */
export async function updateGym(id: string, input: UpdateGymInput): Promise<Gym | null> {
  return db.transaction(async (tx) => {
    if (input.isDefault === true) {
      await tx.execute(sql`UPDATE gyms SET is_default = false WHERE is_default = true AND id <> ${id}`)
    }
    const sets: SQL[] = []
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (name) sets.push(sql`name = ${name}`)
    }
    if (input.equipment !== undefined) {
      sets.push(sql`equipment = ${JSON.stringify(cleanEquipment(input.equipment))}::jsonb`)
    }
    if (input.notes !== undefined) sets.push(sql`notes = ${input.notes}`)
    if (input.isDefault === true) sets.push(sql`is_default = true`)

    if (sets.length === 0) {
      const rows = (
        await tx.execute(sql`
          SELECT id, name, equipment, notes, is_default, created_at::text AS created_at
          FROM gyms WHERE id = ${id} LIMIT 1
        `)
      ).rows as unknown as GymRowRaw[]
      return rows[0] ? mapGym(rows[0]) : null
    }
    const rows = (
      await tx.execute(sql`
        UPDATE gyms SET ${sql.join(sets, sql`, `)}
        WHERE id = ${id}
        RETURNING id, name, equipment, notes, is_default, created_at::text AS created_at
      `)
    ).rows as unknown as GymRowRaw[]
    return rows[0] ? mapGym(rows[0]) : null
  })
}

/**
 * Delete a gym. If it was the default and others remain, the newest remaining gym
 * is promoted to default (keeps the invariant) — all in one transaction. Returns
 * true when a row was removed.
 */
export async function deleteGym(id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = (
      await tx.execute(sql`DELETE FROM gyms WHERE id = ${id} RETURNING is_default`)
    ).rows as unknown as { is_default: boolean }[]
    if (deleted.length === 0) return false
    if (deleted[0]!.is_default) {
      // Promote the newest remaining gym so exactly-one-default holds.
      await tx.execute(sql`
        UPDATE gyms SET is_default = true
        WHERE id = (SELECT id FROM gyms ORDER BY created_at DESC LIMIT 1)
      `)
    }
    return true
  })
}

/**
 * Append an exercise NAME to the DEFAULT gym's `machines_excluded` (the logger's
 * "Not available here" reason chip). No-op (returns false) when there's no default
 * gym. Idempotent — a name already excluded isn't duplicated. Migrates a legacy
 * flat-array equipment shape to the structured shape on write.
 */
export async function excludeExerciseAtDefaultGym(exerciseName: string): Promise<boolean> {
  const name = exerciseName.trim()
  if (!name) return false
  const [row] = (
    await db.execute(sql`
      SELECT id, equipment FROM gyms WHERE is_default = true ORDER BY created_at DESC LIMIT 1
    `)
  ).rows as unknown as { id: string; equipment: unknown }[]
  if (!row) return false
  const equipment = normalizeGymEquipment(row.equipment)
  if (equipment.machines_excluded.some((n) => n.toLowerCase() === name.toLowerCase())) return true
  equipment.machines_excluded.push(name)
  const updated = (
    await db.execute(sql`
      UPDATE gyms SET equipment = ${JSON.stringify(equipment)}::jsonb WHERE id = ${row.id} RETURNING id
    `)
  ).rows as unknown as { id: string }[]
  return updated.length > 0
}
