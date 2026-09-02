'use client'

/**
 * AddExerciseSheet (GYM_PLAN §4 "[+ Add exercise] → search sheet") — the
 * bottom-sheet exercise picker reusing the P1 gym-client query contract.
 * Tapping a result adds it to the active workout (store.addExercise) and
 * closes. Mobile-first, one-handed.
 *
 * P2a scope: search + add an EXISTING catalog/custom exercise. Create-from-search
 * (LLM fill) already lives in the Exercises tab; keep this sheet focused on the
 * fast in-workout add.
 */

import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, X } from 'lucide-react'

import { createGymExercise, exercisesPath, useDebounced } from '@/lib/gym-client/fetch'
import type { ExerciseListItem, ExerciseListResponse } from '@/lib/gym-client/types'
import { titleCase } from '@/components/gym/exercises/format'
import { MUSCLE_REGIONS, REGION_LABELS, type MuscleRegion } from '@/lib/fitness/muscles'

const PAGE = 50

interface ExercisePageState {
  queryKey: string
  rows: ExerciseListItem[]
  total: number
  loading: boolean
  error: boolean
}

export function AddExerciseSheet({
  onAdd,
  onClose,
  inWorkoutIds,
}: {
  onAdd: (exerciseId: string) => void | Promise<void>
  onClose: () => void
  /** Exercises already in the active workout — tagged (not blocked): tapping
   *  one adds a SECOND instance, e.g. curls at the start and again at the end. */
  inWorkoutIds?: Set<string>
}) {
  const [input, setInput] = useState('')
  const q = useDebounced(input.trim(), 250)
  const [muscle, setMuscle] = useState<MuscleRegion | null>(null)
  const queryKey = useMemo(
    () => exercisesPath({ q: q || undefined, muscle, limit: PAGE, offset: 0 }),
    [q, muscle],
  )
  const [page, setPage] = useState<ExercisePageState>({
    queryKey,
    rows: [],
    total: 0,
    loading: true,
    error: false,
  })
  const [adding, setAdding] = useState<string | null>(null)

  // Fetch real pages instead of repeatedly raising `limit`: the API caps one
  // response at 200 rows, while the production catalog is much larger. Offset
  // paging keeps every eligible exercise reachable without re-downloading the
  // first page on every tap.
  useEffect(() => {
    const controller = new AbortController()
    setPage({ queryKey, rows: [], total: 0, loading: true, error: false })
    void fetchExercisePage(queryKey, controller.signal)
      .then((data) => {
        setPage((current) => current.queryKey === queryKey
          ? { queryKey, rows: data.exercises, total: data.total, loading: false, error: false }
          : current)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setPage((current) => current.queryKey === queryKey
          ? { ...current, loading: false, error: true }
          : current)
      })
    return () => controller.abort()
  }, [queryKey])

  const currentPage = page.queryKey === queryKey
    ? page
    : { queryKey, rows: [], total: 0, loading: true, error: false }
  const { rows, total, loading, error } = currentPage
  const hasMore = rows.length < total

  async function loadMore() {
    if (loading || !hasMore) return
    const offset = rows.length
    setPage((current) => current.queryKey === queryKey
      ? { ...current, loading: true, error: false }
      : current)
    try {
      const data = await fetchExercisePage(
        exercisesPath({ q: q || undefined, muscle, limit: PAGE, offset }),
      )
      setPage((current) => {
        if (current.queryKey !== queryKey) return current
        const known = new Set(current.rows.map((row) => row.id))
        const nextRows = data.exercises.filter((row) => !known.has(row.id))
        return {
          ...current,
          rows: [...current.rows, ...nextRows],
          total: data.total,
          loading: false,
          error: false,
        }
      })
    } catch {
      setPage((current) => current.queryKey === queryKey
        ? { ...current, loading: false, error: true }
        : current)
    }
  }

  async function add(id: string) {
    setAdding(id)
    try {
      await onAdd(id)
      onClose()
    } finally {
      setAdding(null)
    }
  }

  // Create-from-search (the Exercises-tab flow, inlined): mid-workout a missing
  // movement — "Triceps Pushdown (Rope)" — must not be a dead end.
  const [creating, setCreating] = useState(false)
  const [createFailed, setCreateFailed] = useState(false)
  const showCreate =
    q.length > 1 &&
    !loading &&
    !rows.some((row) => row.name.trim().toLowerCase() === q.toLowerCase())
  async function createAndAdd() {
    if (creating) return
    setCreating(true)
    setCreateFailed(false)
    try {
      const res = await createGymExercise(q)
      await onAdd(res.exercise.id)
      onClose()
    } catch {
      setCreateFailed(true)
      setCreating(false)
    }
  }

  return (
    <div role="presentation" style={scrim} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Add exercise" style={sheet} className="gym-add-sheet">
        <style>{ADD_CSS}</style>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={heading}>Add exercise</span>
          <button type="button" onClick={onClose} aria-label="Close" style={closeBtn}>
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        <div style={{ position: 'relative', marginBottom: 12 }}>
          <Search
            size={15}
            strokeWidth={1.8}
            style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-subtle)', pointerEvents: 'none' }}
          />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search exercises…"
            aria-label="Search exercises to add"
            autoFocus
            style={searchInput}
          />
        </div>

        <div className="gym-chip-row" style={chipRowStyle} role="group" aria-label="Filter by muscle region">
          <Chip active={muscle === null} onClick={() => setMuscle(null)}>
            All
          </Chip>
          {MUSCLE_REGIONS.map((r) => (
            <Chip
              key={r}
              active={muscle === r}
              onClick={() => setMuscle((cur) => (cur === r ? null : r))}
            >
              {REGION_LABELS[r]}
            </Chip>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto' }}>
          {loading && rows.length === 0 && <p style={note}>Searching…</p>}
          {error && rows.length === 0 && <p style={note}>Couldn&rsquo;t load exercises.</p>}
          {!error && !loading && rows.length === 0 && <p style={note}>No matches — try fewer or shorter words.</p>}
          {rows.map((ex) => (
            <button
              key={ex.id}
              type="button"
              onClick={() => add(ex.id)}
              disabled={adding != null}
              aria-label={`Add ${ex.name}${inWorkoutIds?.has(ex.id) ? ' (again — already in this workout)' : ''}`}
              style={resultRow}
            >
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, textAlign: 'left' }}>
                <span style={resultName}>{ex.name}</span>
                {(ex.primaryMuscle || ex.equipment || inWorkoutIds?.has(ex.id)) && (
                  <span style={resultMeta}>
                    {[
                      inWorkoutIds?.has(ex.id) ? 'In workout — adds again' : null,
                      ex.primaryMuscle && titleCase(ex.primaryMuscle),
                      ex.equipment && titleCase(ex.equipment),
                    ].filter(Boolean).join(' · ')}
                  </span>
                )}
              </span>
              <Plus size={16} strokeWidth={2} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            </button>
          ))}
          {!error && showCreate && (
            <button
              type="button"
              onClick={() => void createAndAdd()}
              disabled={creating || adding != null}
              aria-label={`Create "${q}" and add it`}
              style={resultRow}
            >
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, textAlign: 'left' }}>
                <span style={resultName}>{creating ? 'Creating…' : `Create “${q}”`}</span>
                <span style={resultMeta}>{createFailed ? "Couldn't create — try again" : 'New custom exercise, added to this workout'}</span>
              </span>
              <Plus size={16} strokeWidth={2} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            </button>
          )}
          {!error && hasMore && (
            <button type="button" onClick={() => void loadMore()} disabled={loading} style={loadMoreStyle}>
              {loading ? 'Loading…' : `Load more — ${rows.length} of ${total}`}
            </button>
          )}
          {error && rows.length > 0 && (
            <button type="button" onClick={() => void loadMore()} style={loadMoreStyle}>
              Retry loading more
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

async function fetchExercisePage(path: string, signal?: AbortSignal): Promise<ExerciseListResponse> {
  const response = await fetch(path, { signal })
  if (!response.ok) throw new Error(`exercise list → ${response.status}`)
  return response.json() as Promise<ExerciseListResponse>
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

const ADD_CSS = `
.gym-add-sheet { animation: gym-add-up .2s cubic-bezier(.16,1,.3,1); }
@keyframes gym-add-up { from { transform: translateY(28px); opacity: .6; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .gym-add-sheet { animation: none; } }
.gym-chip-row { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; -webkit-overflow-scrolling: touch; }
.gym-chip-row::-webkit-scrollbar { display: none; }
`
const chipRowStyle: React.CSSProperties = { scrollbarWidth: 'none', marginBottom: 12 }
const scrim: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 70,
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  background: 'color-mix(in oklch, var(--bg) 45%, transparent)',
  backdropFilter: 'blur(2px)',
}
const sheet: React.CSSProperties = {
  width: '100%',
  maxWidth: 520,
  maxHeight: '78vh',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '16px 16px 0 0',
  boxShadow: '0 -12px 40px rgba(0,0,0,.34)',
  padding: '16px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
}
const heading: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 18,
  color: 'var(--fg)',
}
const closeBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-elevated)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const searchInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '11px 12px 11px 34px',
  fontSize: 15,
  fontFamily: 'var(--font-sans)',
  color: 'var(--fg)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
  outline: 'none',
}
const resultRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '11px 12px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-muted)',
  borderRadius: 10,
  cursor: 'pointer',
}
const resultName: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 14.5,
  color: 'var(--fg)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const resultMeta: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.03em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const note: React.CSSProperties = {
  margin: '12px 0',
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13,
  color: 'var(--fg-subtle)',
  textAlign: 'center',
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
