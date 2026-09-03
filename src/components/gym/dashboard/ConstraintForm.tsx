'use client'

/**
 * ConstraintForm — section 04's add control, and the app's one declarative
 * WebMCP tool.
 *
 * Two attributes on the `<form>` (`toolname`, `tooldescription`) are the entire
 * registration: Chrome reads the controls and publishes `report_training_
 * constraint` with a schema derived from them. See `lib/webmcp/declarative.ts`
 * for the contract and for why this one is a form rather than a twelfth
 * imperative tool.
 *
 * The short version: recording a limit on your own body is a claim about you.
 * An agent can hear "my left shoulder is bad today" and put it in the fields —
 * canonical region, severity, your own words — but the call stays pending until
 * a person presses Add. Chrome enforces that; the app just has to honour it.
 *
 * Without WebMCP this is an ordinary form, and a useful one: before it, adding
 * a constraint meant digging into the settings sheet.
 *
 * One wart: Chrome puts every `<option>` in the derived enum, `hidden` and
 * `disabled` included, so the "Choose a region…" placeholder shows up as `""`.
 * Dropping it would mean a real region sitting pre-selected in a form about
 * someone's body, which is worse. The `title` on each select tells an agent not
 * to send it, `required` stops a person submitting it, and the route answers an
 * empty region with a 400 the form hands straight back.
 */
import { useCallback, useRef, useState } from 'react'

import { INJURY_SITES, INJURY_SITE_LABELS } from '@/lib/gym/injury-profile'
import { handleAgentSubmit, isAgentInvoked } from '@/lib/webmcp/declarative'
import { afterMutation } from '@/lib/webmcp/tools/shared'

/** Same three levels the settings editor and the eligibility gate use. */
const SEVERITIES = [
  { id: 'nagging', label: 'Nagging — noted, nothing excluded' },
  { id: 'limiting', label: 'Limiting — exclude movements that load it' },
  { id: 'out', label: 'Out — the site is unusable' },
] as const

/** The description an agent reads. It has to carry three things: what the tool
 *  does, the non-medical framing, and — because this is the surprising part —
 *  that filling it does not record anything until a person presses the button. */
const TOOL_DESCRIPTION =
  'Record a training limitation the person has stated, so exercise eligibility can exclude ' +
  'conflicting movements. This does not diagnose an injury or prescribe rehabilitation. ' +
  'Filling this form does not save anything on its own: the values appear on screen and the ' +
  'call completes only when the person presses Add. Use it when someone says they cannot load ' +
  'something; read get_training_constraints first to avoid duplicating one already in force.'

export default function ConstraintForm({ onAdded }: { onAdded: () => void | Promise<void> }) {
  const formRef = useRef<HTMLFormElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      const form = event.currentTarget
      const fromAgent = isAgentInvoked(event.nativeEvent as SubmitEvent)
      const values = Object.fromEntries(new FormData(form)) as Record<string, string>

      handleAgentSubmit(event.nativeEvent as SubmitEvent, async () => {
        setBusy(true)
        setError(null)
        try {
          const res = await fetch('/api/gym/injuries', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              region: values.region,
              severity: values.severity || null,
              label: values.label?.trim() || null,
              note: values.note?.trim() || null,
            }),
          })
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          if (!res.ok) {
            const message = body.error ?? `Could not record the constraint (HTTP ${res.status})`
            setError(message)
            throw new Error(message)
          }

          const site = INJURY_SITE_LABELS[values.region as keyof typeof INJURY_SITE_LABELS] ?? values.region
          const named = values.label?.trim() || site
          // Resetting the form while a declarative call is in flight makes
          // Chrome cancel it — "Tool execution cancelled by a form reset" —
          // and the agent is told the call failed even though the write
          // succeeded. So an agent-invoked submit leaves the values on screen,
          // which is also the better record of what was just confirmed. A
          // person who typed them gets a cleared form.
          if (!fromAgent) form.reset()
          await onAdded()
          if (fromAgent) {
            afterMutation('report_training_constraint', `Added a ${values.severity} constraint on ${named}.`)
          }
          return (
            `Recorded: ${named} — ${values.severity}. Movements that load ${site} are now excluded ` +
            `from search, drafts and live edits until it is resolved.`
          )
        } finally {
          setBusy(false)
        }
      })
    },
    [onAdded],
  )

  return (
    <form
      ref={formRef}
      toolname="report_training_constraint"
      tooldescription={TOOL_DESCRIPTION}
      onSubmit={submit}
      style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 12 }}
    >
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        <label style={field}>
          <span style={fieldLabel}>Region</span>
          <select name="region" required title="The body region that cannot be loaded. Pass a canonical value, never the empty placeholder." style={control} defaultValue="">
            <option value="" disabled>
              Choose a region…
            </option>
            {INJURY_SITES.map((site) => (
              <option key={site} value={site}>
                {INJURY_SITE_LABELS[site]}
              </option>
            ))}
          </select>
        </label>

        <label style={field}>
          <span style={fieldLabel}>Severity</span>
          <select
            name="severity"
            required
            title="How much this limits training: nagging is noted only; limiting and out both exclude conflicting movements. Never the empty placeholder."
            style={control}
            defaultValue=""
          >
            <option value="" disabled>
              Choose…
            </option>
            {SEVERITIES.map((severity) => (
              <option key={severity.id} value={severity.id}>
                {severity.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label style={{ ...field, flex: '1 1 100%' }}>
        <span style={fieldLabel}>Label</span>
        <input
          name="label"
          type="text"
          maxLength={60}
          placeholder="e.g. left shoulder"
          title="Short human label for this constraint, e.g. left shoulder"
          style={control}
        />
      </label>

      <label style={{ ...field, flex: '1 1 100%' }}>
        <span style={fieldLabel}>Note</span>
        <input
          name="note"
          type="text"
          maxLength={200}
          placeholder="what they actually said"
          title="What the person said about it, in their own words"
          style={control}
        />
      </label>

      {error ? (
        <p style={{ fontSize: 11.5, color: 'var(--danger)', margin: 0 }} role="alert">
          {error}
        </p>
      ) : null}

      <div>
        <button type="submit" disabled={busy} style={{ ...addButton, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Adding…' : 'Add constraint'}
        </button>
      </div>
    </form>
  )
}

// ── styles ────────────────────────────────────────────────────────────────────
const field: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  flex: '1 1 180px',
  minWidth: 0,
}
const fieldLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
}
const control: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: 'var(--fg)',
  background: 'var(--bg)',
  border: '1px solid var(--border-muted)',
  borderRadius: 8,
  padding: '7px 9px',
  minWidth: 0,
  width: '100%',
}
const addButton: React.CSSProperties = {
  padding: '7px 13px',
  fontFamily: 'var(--font-sans)',
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--accent-fg, #fff)',
  background: 'var(--accent)',
  border: '1px solid var(--accent)',
  borderRadius: 8,
  cursor: 'pointer',
}
