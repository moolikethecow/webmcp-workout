'use client'

/**
 * ConfirmModal — the app-wide explicit confirmation dialog for permanent /
 * destructive actions. Centered over a scrim, it replaces the native
 * window.confirm() dialogs (which block browser automation and can't be
 * styled).
 */

import { useEffect } from 'react'

import { Button } from '@/components/ui/Button'

export function ConfirmModal({
  title,
  description,
  note,
  confirmLabel,
  loading,
  onConfirm,
  onCancel,
}: {
  title: string
  description?: string
  note?: string
  confirmLabel: string
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'color-mix(in oklch, var(--bg) 60%, transparent)',
        backdropFilter: 'blur(2px)',
        padding: 16,
      }}
    >
      <div
        role="alertdialog"
        aria-label={title}
        style={{
          padding: '14px 16px',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          background: 'var(--bg-elevated)',
          boxShadow: 'var(--shadow-floating)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          maxWidth: '420px',
          width: '100%',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: 'var(--radius-full)',
              background: 'var(--accent)',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--fg-subtle)',
            }}
          >
            Action required
          </span>
        </div>

        <p style={{ fontSize: '14px', fontWeight: 500, color: 'var(--fg)', margin: 0, lineHeight: 1.35 }}>
          {title}
        </p>

        {description && (
          <p
            style={{
              fontSize: '13px',
              color: 'var(--fg-muted)',
              margin: 0,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: '240px',
              overflowY: 'auto',
            }}
          >
            {description}
          </p>
        )}

        {note && (
          <p
            style={{
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              fontSize: '13px',
              color: 'var(--fg-subtle)',
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {note}
          </p>
        )}

        <div style={{ display: 'flex', gap: '8px', paddingTop: '2px' }}>
          <Button size="sm" variant="primary" loading={loading} onClick={onConfirm} aria-label={confirmLabel}>
            {loading ? 'Working…' : confirmLabel}
          </Button>
          <Button size="sm" variant="ghost" disabled={loading} onClick={onCancel} aria-label="Cancel">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
