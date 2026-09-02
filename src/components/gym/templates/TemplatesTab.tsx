'use client'

/**
 * TemplatesTab (GYM_PLAN §4 "Tab: Templates") — folder-grouped template cards
 * with the builder. Each card: name, exercise count, last-performed, a folder tag,
 * an AI-source ✦ badge, and a preview of the first exercises. Actions: open the
 * editor, duplicate, archive/restore, and "Start" (deep-links to Train with
 * ?startTemplate=<id> — Train's mount effect starts the session immediately,
 * #1875; it used to only navigate and leave the user to start manually).
 * "New template" opens a fresh editor. A small "Archived" toggle reveals the
 * restore view.
 *
 * `?new=1` opens the fresh editor on arrival (#1381 — Train's "Build a template"
 * links here). The param is consumed once and stripped, so a reload or a Back
 * doesn't re-open the editor over the list.
 *
 * Self-fetches via templates-client (same primitives as the Exercises tab). All
 * mutations are optimistic-with-rollback at the toast level (the client bumps a
 * generation on success so the list refetches).
 */
import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Archive,
  ArchiveRestore,
  Copy,
  Dumbbell,
  Play,
  Plus,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'

import { HCard, MonoLabel } from '@/components/health/primitives'
import { relTime } from '@/components/gym/exercises/format'

import {
  archiveTemplate,
  duplicateTemplate,
  restoreTemplate,
  useTemplateCards,
} from './templates-client'
import { TemplateEditor } from './TemplateEditor'
import type { TemplateCard } from './types'

type EditorState = { templateId: string | null } | null

export default function TemplatesTab() {
  const [showArchived, setShowArchived] = useState(false)
  const { data, loading, error } = useTemplateCards(showArchived)
  const [editor, setEditor] = useState<EditorState>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // #1381: ?new=1 arrives from Train's "Build a template". Consume it once —
  // the ref guards against re-opening if this effect re-runs before the URL
  // rewrite lands, and stripping the param keeps reload/Back on the list.
  const router = useRouter()
  const searchParams = useSearchParams()
  const consumedNewParam = useRef(false)
  useEffect(() => {
    if (consumedNewParam.current || searchParams.get('new') !== '1') return
    consumedNewParam.current = true
    setEditor({ templateId: null })
    const params = new URLSearchParams(searchParams.toString())
    params.delete('new')
    router.replace(`/gym?${params.toString()}`)
  }, [router, searchParams])

  const folders = data?.folders ?? []
  const allFolders = data?.allFolders ?? []
  const isEmpty = !loading && folders.length === 0

  async function handleDuplicate(id: string) {
    setBusyId(id)
    try {
      await duplicateTemplate(id)
      toast.success('Template duplicated')
    } catch {
      toast.error("Couldn't duplicate — try again.")
    } finally {
      setBusyId(null)
    }
  }

  async function handleArchive(card: TemplateCard) {
    setBusyId(card.id)
    try {
      if (card.archived) {
        await restoreTemplate(card.id)
        toast.success('Template restored')
      } else {
        await archiveTemplate(card.id)
        toast.success('Template archived')
      }
    } catch {
      toast.error(card.archived ? "Couldn't restore — try again." : "Couldn't archive — try again.")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header row: title + new + archived toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <MonoLabel>Templates</MonoLabel>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          aria-pressed={showArchived}
          style={toggleBtn(showArchived)}
        >
          {showArchived ? 'Showing archived' : 'Archived'}
        </button>
        {!showArchived && (
          <button type="button" onClick={() => setEditor({ templateId: null })} style={newBtn}>
            <Plus size={14} strokeWidth={2} /> New template
          </button>
        )}
      </div>

      {error && <p style={note}>Couldn&rsquo;t load templates.</p>}

      {loading && folders.length === 0 && <p style={note}>Loading templates…</p>}

      {isEmpty && !error && (
        <HCard pad={20}>
          <p style={{ ...note, margin: '0 0 12px' }}>
            {showArchived
              ? 'No archived templates.'
              : 'No templates yet. Build a reusable workout skeleton — order, supersets, target sets and reps — that you tune for the day when you start one.'}
          </p>
          {!showArchived && (
            <button type="button" onClick={() => setEditor({ templateId: null })} style={newBigBtn}>
              <Plus size={15} strokeWidth={2} /> Build your first template
            </button>
          )}
        </HCard>
      )}

      {/* Folder groups */}
      {folders.map((group) => (
        <section key={group.folder ?? '__ungrouped__'}>
          {group.folder != null ? (
            <MonoLabel style={{ marginBottom: 8 }}>{group.folder}</MonoLabel>
          ) : folders.length > 1 ? (
            <MonoLabel style={{ marginBottom: 8, opacity: 0.7 }}>Ungrouped</MonoLabel>
          ) : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {group.templates.map((t) => (
              <Card
                key={t.id}
                card={t}
                busy={busyId === t.id}
                onOpen={() => setEditor({ templateId: t.id })}
                onDuplicate={() => handleDuplicate(t.id)}
                onArchive={() => handleArchive(t)}
              />
            ))}
          </div>
        </section>
      ))}

      {editor && (
        <TemplateEditor
          templateId={editor.templateId}
          folders={allFolders}
          onClose={() => setEditor(null)}
          onSaved={() => setEditor(null)}
        />
      )}
    </div>
  )
}

// ── one card ─────────────────────────────────────────────────────────────────
function Card({
  card,
  busy,
  onOpen,
  onDuplicate,
  onArchive,
}: {
  card: TemplateCard
  busy: boolean
  onOpen: () => void
  onDuplicate: () => void
  onArchive: () => void
}) {
  const meta: string[] = [`${card.exerciseCount} exercise${card.exerciseCount === 1 ? '' : 's'}`]
  if (card.lastPerformed) meta.push(relTime(card.lastPerformed))
  else meta.push('never run')

  return (
    <HCard pad={12}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={icon}>
          <Dumbbell size={15} strokeWidth={1.9} />
        </span>
        <button type="button" onClick={onOpen} aria-label={`Edit ${card.name}`} style={openArea}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={cardName}>{card.name}</span>
            {card.source === 'ai' && (
              <Sparkles size={12} strokeWidth={1.8} style={{ color: 'var(--accent)', flexShrink: 0 }} aria-label="AI-drafted" />
            )}
          </span>
          <span style={cardMeta}>{meta.join(' · ')}</span>
          {card.exercisePreview.length > 0 && (
            <span style={preview}>{card.exercisePreview.join(' · ')}</span>
          )}
        </button>
      </div>

      {/* Actions */}
      <div style={actions}>
        {!card.archived && (
          <a
            href={`/gym?tab=train&startTemplate=${card.id}`}
            style={startLink}
            aria-label={`Start ${card.name} in Train`}
          >
            <Play size={13} strokeWidth={2} /> Start
          </a>
        )}
        <div style={{ flex: 1 }} />
        {!card.archived && (
          <button type="button" onClick={onDuplicate} disabled={busy} aria-label="Duplicate" style={actionBtn}>
            <Copy size={13} strokeWidth={1.9} />
          </button>
        )}
        <button
          type="button"
          onClick={onArchive}
          disabled={busy}
          aria-label={card.archived ? 'Restore' : 'Archive'}
          style={actionBtn}
        >
          {card.archived ? <ArchiveRestore size={13} strokeWidth={1.9} /> : <Archive size={13} strokeWidth={1.9} />}
        </button>
      </div>
    </HCard>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────
const icon: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  borderRadius: 9,
  background: 'var(--bg-subtle)',
  color: 'var(--fg-muted)',
  border: '1px solid var(--border-muted)',
  flexShrink: 0,
}
const openArea: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  textAlign: 'left',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
}
const cardName: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 15,
  color: 'var(--fg)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const cardMeta: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-subtle)',
}
const preview: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 12,
  color: 'var(--fg-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  marginTop: 2,
}
const actions: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 10,
  paddingTop: 10,
  borderTop: '1px solid var(--border-muted)',
}
const startLink: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '6px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  borderRadius: 8,
  textDecoration: 'none',
}
const actionBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: 8,
  border: '1px solid var(--border-muted)',
  background: 'var(--bg-subtle)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
}
function toggleBtn(active: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    letterSpacing: '0.04em',
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-muted)'}`,
    background: active ? 'var(--accent)' : 'var(--bg-elevated)',
    color: active ? 'var(--accent-fg)' : 'var(--fg-muted)',
    cursor: 'pointer',
  }
}
const newBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: 'var(--accent-fg)',
  background: 'var(--accent)',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
}
const newBigBtn: React.CSSProperties = {
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
const note: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: 13,
  color: 'var(--fg-subtle)',
  lineHeight: 1.55,
}
