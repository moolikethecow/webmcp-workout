'use client'

/**
 * Recording how an exercise is being held, from inside the live logger.
 *
 * Collapsed to a single line by default — most exercises have no grip worth
 * recording, and three pickers on every card would be clutter on the one screen
 * that has to stay fast mid-set. Tapping the line opens the three lists.
 *
 * Set on the EXERCISE, not per set: one handle for all three sets is how this
 * is actually trained. Every set inherits it, and a set that needs to differ
 * can still be overridden from the completed-session editor.
 *
 * "Grip" reads as one idea and is two controls (width and orientation) because
 * those vary independently — a MAG handle is still held wide or narrow, and one
 * combined list would force throwing away whichever you didn't pick.
 */
import { useState } from 'react'

import {
  ATTACHMENTS,
  EMPTY_GRIP,
  GRIP_ORIENTATIONS,
  GRIP_WIDTHS,
  attachmentLabel,
  gripLabel,
  gripOrientationLabel,
  gripWidthLabel,
  type Attachment,
  type GripOrientation,
  type GripSpec,
  type GripWidth,
} from '@/lib/gym/grip'

export interface GripPatchInput {
  gripWidth?: GripWidth | null
  gripOrientation?: GripOrientation | null
  attachment?: Attachment | null
}

export function GripPicker({
  grip: rawGrip,
  onChange,
  disabled = false,
}: {
  grip: GripSpec | null | undefined
  onChange: (patch: GripPatchInput) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  // A client mid-deploy can still be holding a workout payload from the build
  // before grip existed. Treating that as "nothing recorded" keeps the logger
  // rendering rather than blanking the screen for the length of a deploy.
  const grip = rawGrip ?? EMPTY_GRIP
  const label = gripLabel(grip)

  return (
    <div style={wrap}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ ...summary, color: label ? 'var(--fg)' : 'var(--fg-subtle)' }}
        disabled={disabled}
      >
        <span style={summaryLabel}>Grip</span>
        <span style={summaryValue}>{label ?? 'Add'}</span>
      </button>

      {open && (
        <div style={panel}>
          <Row
            label="Width"
            values={GRIP_WIDTHS}
            selected={grip.gripWidth}
            render={gripWidthLabel}
            onPick={(v) => onChange({ gripWidth: v })}
            disabled={disabled}
          />
          <Row
            label="Palms"
            values={GRIP_ORIENTATIONS}
            selected={grip.gripOrientation}
            render={gripOrientationLabel}
            onPick={(v) => onChange({ gripOrientation: v })}
            disabled={disabled}
          />
          <Row
            label="Attachment"
            values={ATTACHMENTS}
            selected={grip.attachment}
            render={attachmentLabel}
            onPick={(v) => onChange({ attachment: v })}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  )
}

/**
 * One row of chips. Tapping the selected chip CLEARS it — there is no separate
 * clear button, because the common mistake is picking the wrong one and the
 * common fix is un-picking it.
 */
function Row<T extends string>({
  label,
  values,
  selected,
  render,
  onPick,
  disabled,
}: {
  label: string
  values: readonly T[]
  selected: T | null
  render: (v: T) => string
  onPick: (v: T | null) => void
  disabled: boolean
}) {
  return (
    <div style={row}>
      <div style={rowLabel}>{label}</div>
      <div style={chips}>
        {values.map((v) => {
          const on = selected === v
          return (
            <button
              key={v}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onPick(on ? null : v)}
              style={{
                ...chip,
                background: on ? 'var(--accent-soft)' : 'var(--bg-subtle)',
                borderColor: on ? 'var(--accent)' : 'var(--border-muted)',
                color: on ? 'var(--fg)' : 'var(--fg-subtle)',
              }}
            >
              {render(v)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const wrap: React.CSSProperties = { marginTop: 6 }

const summary: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  background: 'none',
  border: 'none',
  padding: '2px 0',
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'left',
}

const summaryLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}

const summaryValue: React.CSSProperties = { fontSize: 12.5 }

const panel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 8,
  paddingTop: 8,
  borderTop: '1px solid var(--border-muted)',
}

const row: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }

const rowLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}

const chips: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4 }

const chip: React.CSSProperties = {
  borderRadius: 999,
  border: '1px solid',
  padding: '3px 9px',
  fontSize: 11.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
