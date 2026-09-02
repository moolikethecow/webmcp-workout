'use client'

/**
 * ExercisesTab — the Gym "Exercises" tab (GYM_PLAN §4). Rendered by the gym
 * page shell inside /gym?tab=exercises with NO props (it self-fetches via
 * lib/gym-client). Mobile-first, one-handed at the gym: search, a horizontal
 * muscle-region chip row, an equipment dropdown + filter chips, and a tappable
 * result list that opens ExerciseDetailSheet.
 *
 * Empty-state "create «query»" row when a search misses → POST create →
 * optimistic insert + open detail.
 */
import { useCallback, useMemo, useState } from 'react'
import { Plus, Search, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'

import { MUSCLE_REGIONS, REGION_LABELS, type MuscleRegion } from '@/lib/fitness/muscles'
import { HCard } from '@/components/health/primitives'
import {
  createGymExercise,
  useDebounced,
  useGymExercises,
} from '@/lib/gym-client/fetch'
import type {
  ExerciseDetail,
  ExerciseFilter,
  ExerciseListItem,
  ExerciseQuery,
} from '@/lib/gym-client/types'
import { ExerciseDetailSheet } from './ExerciseDetailSheet'
import { ExerciseImage } from './ExerciseImage'
import { relTime, setCount, titleCase } from './format'
import { displayExerciseName } from '@/lib/gym/display-name'

const PAGE = 50

/** FEDB's canonical equipment vocabulary (stable, public-domain). */
const EQUIPMENT_OPTIONS = [
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

const FILTERS: Array<{ id: ExerciseFilter; label: string }> = [
  { id: 'custom', label: 'Custom' },
  { id: 'disliked', label: 'Disliked' },
  { id: 'tracked', label: 'Tracked' },
]

/** A detail-open target: either an id to fetch, or a freshly-created exercise to
 *  seed the sheet with (so the panel opens instantly, no round-trip). */
type OpenTarget = { id: string; seed?: ExerciseDetail; aiPending?: boolean } | null

export function ExercisesTab() {
  const [searchInput, setSearchInput] = useState('')
  const q = useDebounced(searchInput.trim(), 250)
  const [muscle, setMuscle] = useState<MuscleRegion | null>(null)
  const [equipment, setEquipment] = useState<string>('')
  const [filter, setFilter] = useState<ExerciseFilter | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<OpenTarget>(null)
  const [creating, setCreating] = useState(false)

  // Reset pagination whenever the query narrows/changes.
  const resetPage = useCallback(() => setLimit(PAGE), [])

  const query = useMemo<ExerciseQuery>(
    () => ({ q: q || undefined, muscle, equipment: equipment || null, filter, limit, offset: 0 }),
    [q, muscle, equipment, filter, limit],
  )
  const { data, loading, error } = useGymExercises(query)

  const rows = data?.exercises ?? []
  const total = data?.total ?? 0
  const canLoadMore = rows.length < total

  async function handleCreate() {
    const name = q.trim()
    if (!name || creating) return
    setCreating(true)
    try {
      const res = await createGymExercise(name)
      toast.success(`Added "${displayExerciseName(res.exercise.name)}"`)
      // Open the detail sheet immediately, seeded with the created exercise so
      // the panel doesn't wait on a re-fetch; flag the AI shimmer if it's still
      // filling metadata in.
      setOpen({ id: res.exercise.id, seed: res.exercise, aiPending: res.aiFilled })
    } catch {
      toast.error("Couldn't create that exercise")
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{SHIMMER_CSS}</style>

      {/* ── Search ── */}
      <div style={{ position: 'relative' }}>
        <Search
          size={15}
          strokeWidth={1.8}
          style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-subtle)', pointerEvents: 'none' }}
        />
        <input
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value)
            resetPage()
          }}
          placeholder="Search exercises…"
          aria-label="Search exercises"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '11px 34px 11px 34px',
            fontSize: 15,
            fontFamily: 'var(--font-sans)',
            color: 'var(--fg)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-muted)',
            borderRadius: 10,
            outline: 'none',
          }}
        />
        {searchInput && (
          <button
            type="button"
            onClick={() => {
              setSearchInput('')
              resetPage()
            }}
            aria-label="Clear search"
            style={clearBtnStyle}
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        )}
      </div>

      {/* ── Muscle-region chip row (horizontal scroll on mobile) ── */}
      <div className="gym-chip-row" style={chipRowStyle} role="group" aria-label="Filter by muscle region">
        <Chip active={muscle === null} onClick={() => { setMuscle(null); resetPage() }}>
          All
        </Chip>
        {MUSCLE_REGIONS.map((r) => (
          <Chip
            key={r}
            active={muscle === r}
            onClick={() => { setMuscle((cur) => (cur === r ? null : r)); resetPage() }}
          >
            {REGION_LABELS[r]}
          </Chip>
        ))}
      </div>

      {/* ── Equipment dropdown + filter chips ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select
          value={equipment}
          onChange={(e) => { setEquipment(e.target.value); resetPage() }}
          aria-label="Filter by equipment"
          style={selectStyle}
        >
          <option value="">All equipment</option>
          {EQUIPMENT_OPTIONS.map((eq) => (
            <option key={eq} value={eq}>
              {titleCase(eq)}
            </option>
          ))}
        </select>
        <div style={{ display: 'flex', gap: 6 }}>
          {FILTERS.map((f) => (
            <Chip
              key={f.id}
              active={filter === f.id}
              onClick={() => { setFilter((cur) => (cur === f.id ? null : f.id)); resetPage() }}
            >
              {f.label}
            </Chip>
          ))}
        </div>
      </div>

      {/* ── Results ── */}
      {error && <p style={noteStyle}>Couldn&rsquo;t load exercises.</p>}

      {!error && loading && rows.length === 0 && <p style={noteStyle}>Loading exercises…</p>}

      {!error && !loading && rows.length === 0 && (
        <EmptyState query={q} creating={creating} onCreate={handleCreate} />
      )}

      {rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((ex) => (
            <ExerciseRow key={ex.id} ex={ex} onOpen={() => setOpen({ id: ex.id })} />
          ))}
        </div>
      )}

      {/* Load-more (paginate at 50) */}
      {canLoadMore && (
        <button type="button" onClick={() => setLimit((l) => l + PAGE)} style={loadMoreStyle}>
          Load more — {rows.length} of {total}
        </button>
      )}

      {/* Also offer create even when there ARE partial matches, if a real query
          is typed (Strong-style "can't find it? make it"). */}
      {rows.length > 0 && q.length > 1 && (
        <button type="button" onClick={handleCreate} disabled={creating} style={createInlineStyle}>
          <Plus size={13} strokeWidth={2} /> {creating ? 'Creating…' : `Create "${q}"`}
        </button>
      )}

      {open && (
        <ExerciseDetailSheet
          id={open.id}
          seed={open.seed}
          aiPending={open.aiPending}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

// ── row ──────────────────────────────────────────────────────────────────────
function ExerciseRow({ ex, onOpen }: { ex: ExerciseListItem; onOpen: () => void }) {
  const meta: string[] = []
  if (ex.sets > 0) meta.push(setCount(ex.sets))
  if (ex.lastPerformed) meta.push(relTime(ex.lastPerformed))

  return (
    <HCard pad={10} onClick={onOpen} hover ariaLabel={`Open ${displayExerciseName(ex.name)}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <ExerciseImage
          imagePath={ex.imagePath}
          regions={ex.regions}
          alt={displayExerciseName(ex.name)}
          size={44}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 14.5,
                color: 'var(--fg)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {displayExerciseName(ex.name)}
            </span>
            {ex.aiFilled && <Sparkles size={11} strokeWidth={1.8} style={{ color: 'var(--accent)', flexShrink: 0 }} aria-label="AI-filled" />}
            {ex.disliked && <span style={miniTag('var(--danger)')}>disliked</span>}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 4 }}>
            {ex.primaryMuscle && <span style={chipTiny}>{titleCase(ex.primaryMuscle)}</span>}
            {ex.equipment && <span style={chipTiny}>{titleCase(ex.equipment)}</span>}
          </div>
          {meta.length > 0 && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-subtle)', marginTop: 5 }}>
              {meta.join(' · ')}
            </div>
          )}
        </div>
      </div>
    </HCard>
  )
}

// ── empty state ────────────────────────────────────────────────────────────
function EmptyState({ query, creating, onCreate }: { query: string; creating: boolean; onCreate: () => void }) {
  if (!query) {
    return <p style={noteStyle}>No exercises match those filters.</p>
  }
  return (
    <HCard pad={16}>
      <p style={{ ...noteStyle, marginBottom: 12 }}>
        No exercise called &ldquo;{query}&rdquo; yet.
      </p>
      <button type="button" onClick={onCreate} disabled={creating} style={createBigStyle}>
        <Plus size={15} strokeWidth={2} /> {creating ? 'Creating…' : `Create "${query}"`}
      </button>
    </HCard>
  )
}

// ── chip ─────────────────────────────────────────────────────────────────────
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        flexShrink: 0,
        padding: '6px 12px',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.04em',
        borderRadius: 999,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-muted)'}`,
        background: active ? 'var(--accent)' : 'var(--bg-elevated)',
        color: active ? 'var(--accent-fg)' : 'var(--fg-muted)',
        transition: 'background .12s, color .12s, border-color .12s',
      }}
    >
      {children}
    </button>
  )
}

// ── styles ─────────────────────────────────────────────────────────────────
const SHIMMER_CSS = `
.gym-chip-row { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; -webkit-overflow-scrolling: touch; }
.gym-chip-row::-webkit-scrollbar { display: none; }
@keyframes gym-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
`
const chipRowStyle: React.CSSProperties = { scrollbarWidth: 'none' }
const clearBtnStyle: React.CSSProperties = {
  position: 'absolute',
  right: 8,
  top: '50%',
  transform: 'translateY(-50%)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  borderRadius: 6,
  background: 'none',
  border: 'none',
  color: 'var(--fg-subtle)',
  cursor: 'pointer',
}
const selectStyle: React.CSSProperties = {
  padding: '7px 10px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.03em',
  color: 'var(--fg-muted)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  cursor: 'pointer',
  outline: 'none',
}
const noteStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13,
  color: 'var(--fg-subtle)',
  padding: '6px 0',
}
const chipTiny: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-muted)',
  borderRadius: 5,
  padding: '2px 6px',
}
function miniTag(color: string): React.CSSProperties {
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 9,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color,
    border: `1px solid color-mix(in oklch, ${color} 40%, transparent)`,
    borderRadius: 5,
    padding: '1px 5px',
    flexShrink: 0,
  }
}
const loadMoreStyle: React.CSSProperties = {
  padding: '10px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.05em',
  color: 'var(--fg-muted)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
  cursor: 'pointer',
}
const createInlineStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  alignSelf: 'flex-start',
  padding: '8px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  color: 'var(--accent)',
  background: 'transparent',
  border: '1px dashed color-mix(in oklch, var(--accent) 40%, transparent)',
  borderRadius: 10,
  cursor: 'pointer',
}
const createBigStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '11px 16px',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  border: 'none',
  borderRadius: 10,
  cursor: 'pointer',
}
