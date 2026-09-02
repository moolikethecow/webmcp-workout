'use client'

/**
 * Shared "coming in a later ship" empty-state block for the P1 placeholder
 * tabs — one styled headline + one line of real copy (no lorem), consistent
 * with the app's serif-italic sub-copy voice.
 */
export function GymEmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ marginTop: 12 }}>
      <p
        style={{
          fontFamily: 'var(--font-serif)',
          fontStyle: 'italic',
          fontWeight: 400,
          fontSize: 17,
          letterSpacing: '-0.01em',
          color: 'var(--fg)',
          margin: '0 0 8px',
        }}
      >
        {title}
      </p>
      <p
        style={{
          fontSize: 13.5,
          lineHeight: 1.6,
          color: 'var(--fg-muted)',
          margin: 0,
          maxWidth: '52ch',
        }}
      >
        {body}
      </p>
    </div>
  )
}
