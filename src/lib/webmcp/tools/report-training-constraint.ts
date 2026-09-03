import { INJURY_SITES, INJURY_SITE_LABELS, type InjurySite } from '@/lib/gym/injury-profile'

import { stageForm } from '../staged-form'
import type { WebMcpTool } from '../types'
import { fail, ok, str } from './shared'
import { canonicalRegion } from './training-constraints'

/**
 * The code-defined half of `report_training_constraint`.
 *
 * On the dashboard this tool *is* a `<form toolname="report_training_constraint">`
 * (components/gym/dashboard/ConstraintForm.tsx): Chrome derives the schema
 * from the controls, fills them for an agent, and holds the call open until a
 * person presses Add. ChatGPT's built-in browser does not implement the
 * declarative API, so there the form is not a tool at all.
 *
 * This is the same tool for that browser, registered in code and pointed at
 * the same form. It fills the controls on screen, marks the form as staged,
 * and waits for the person's press — exactly the property the form was chosen
 * for. It is registered only when the browser has not published the form
 * itself (lib/webmcp/register.ts, `registerDeclarativeFallbacks`), so a page
 * never carries two tools under one name.
 *
 * The description has to say the surprising part out loud: a successful call
 * has recorded nothing yet, and the button is not the agent's to press.
 */

const SEVERITIES = ['nagging', 'limiting', 'out'] as const

/** How long a call waits for the person before returning `awaiting_confirmation`. */
export const CONFIRMATION_WINDOW_MS = 20_000

export const FORM_SELECTOR = 'form[toolname="report_training_constraint"]'

export const reportTrainingConstraint: WebMcpTool = {
  name: 'report_training_constraint',
  description:
    'Stage a training limitation the person has stated, so exercise eligibility can exclude ' +
    'conflicting movements. This does not diagnose an injury or prescribe rehabilitation. ' +
    'This tool fills the constraint form on the dashboard and then waits: nothing is recorded until ' +
    'the person presses Add on the page, and the button is theirs to press — do not click it for them. ' +
    'The call returns "recorded" once they have, or "awaiting_confirmation" if they have not yet; in ' +
    'that case the values stay on screen and get_training_constraints will show the result after they ' +
    'do. Use it when someone says they cannot load something; read get_training_constraints first to ' +
    'avoid duplicating one already in force. For a limitation the agent may record on its own ' +
    'authority, use set_training_constraint instead.',
  inputSchema: {
    type: 'object',
    properties: {
      region: {
        type: 'string',
        enum: [...INJURY_SITES],
        description:
          'The body region that cannot be loaded. Canonical site; common words are accepted and mapped (shoulder → shoulder_joint, knee → knees, back → lower_back).',
      },
      severity: {
        type: 'string',
        enum: [...SEVERITIES],
        description:
          'nagging = noted, nothing excluded; limiting = movements that load the site are excluded from search, drafts and live edits; out = the site is unusable (same exclusion).',
      },
      label: { type: 'string', description: 'Short human label, e.g. "left shoulder".' },
      note: { type: 'string', description: 'What the person actually said, in their words.' },
    },
    required: ['region', 'severity'],
    additionalProperties: false,
  },
  async execute(args, context) {
    if (typeof document === 'undefined') return fail('No page to stage the form on.')
    const form = document.querySelector<HTMLFormElement>(FORM_SELECTOR)
    if (!form) {
      return fail(
        'The training-constraint form is on the dashboard at / and is not on this page. Open the ' +
          'dashboard and call again, or use set_training_constraint.',
      )
    }

    const region = canonicalRegion(str(args, 'region')) as InjurySite | undefined
    if (!region || !INJURY_SITES.includes(region)) {
      return fail(`region must be one of: ${INJURY_SITES.join(', ')}.`)
    }
    const severity = str(args, 'severity')
    if (!severity || !(SEVERITIES as readonly string[]).includes(severity)) {
      return fail(`severity must be one of: ${SEVERITIES.join(', ')}.`)
    }

    const values = {
      region,
      severity,
      label: str(args, 'label') ?? '',
      note: str(args, 'note') ?? '',
    }
    const outcome = await stageForm(form, values, {
      timeoutMs: CONFIRMATION_WINDOW_MS,
      signal: context?.signal,
    })
    const site = INJURY_SITE_LABELS[region]

    if (outcome.status === 'submitted') {
      if (outcome.result.startsWith('Error:')) return fail(outcome.result.slice('Error:'.length).trim())
      return ok({ status: 'recorded', staged: values, result: outcome.result })
    }
    return ok({
      status: 'awaiting_confirmation',
      staged: values,
      message:
        `The form on the dashboard now reads ${site} · ${severity}` +
        `${values.label ? ` · ${values.label}` : ''}. Nothing is recorded yet: the person has to press Add. ` +
        'Tell them it is ready, and call get_training_constraints afterwards to confirm.',
    })
  },
}
