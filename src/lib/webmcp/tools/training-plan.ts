import { agentFetch } from '../fetch'
import type { WebMcpTool } from '../types'
import { failFrom, ok } from './shared'

/**
 * The sequencer, readable.
 *
 * A plan is an ordered cycle of days — Upper A → Lower A → … — and it is the
 * thing that answers "what's next". Until this tool existed the app could run a
 * plan while no agent could see it: `get_training_context` reported the active
 * workout, the draft, the constraints and the equipment, and said nothing about
 * the programme. An agent asked what to train had only readiness and history to
 * reason from, so it improvised — naming whichever day looked least recently
 * trained, or had never been done, while the plan sat there with the answer.
 *
 * The failure mode is worth naming because it is quiet: the improvised answer is
 * fluent and specific and wrong, and nothing in the response says "I guessed".
 */
export const getTrainingPlan: WebMcpTool = {
  name: 'get_training_plan',
  description:
    'ANSWERS "what\'s next up" / "what am I training today". Returns the active training plan — its ' +
    'ordered days and which one comes next — plus how many sessions have been completed. When a plan is ' +
    'active it DECIDES the next session: report its next day rather than choosing one from muscle ' +
    'readiness, from whichever template was performed least recently, or from what has never been done. ' +
    'Readiness explains why a day suits; it does not choose. Do not just NAME the next session — the ' +
    'person cannot see a name: stage it with draft_workout mode "tune" and the returned ' +
    'nextDay.templateId so it appears in the app as a reviewable draft, then start_workout from "plan" ' +
    'when they say go. If no plan is active it says so, and only then is a fresh draft_workout the ' +
    'right next step. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  async execute() {
    const result = await agentFetch('/api/gym/plans')
    if (!result.ok) return failFrom(result, 'Could not load training plans')

    const plans = Array.isArray(result.json.plans) ? (result.json.plans as PlanRow[]) : []
    const active = plans.find((plan) => plan.status === 'active') ?? null
    if (!active) {
      return ok({
        activePlan: null,
        note:
          plans.length === 0
            ? 'No training plans exist. There is no programme deciding the next session, so draft_workout is the right way to pick today.'
            : `No plan is currently active (${plans.length} on record, none running). draft_workout is the right way to pick today.`,
      })
    }

    return ok({
      activePlan: {
        name: active.name,
        goal: active.goal,
        scheduleMode: active.scheduleMode,
        completedSessions: active.completedSessions,
        days: (active.days ?? []).map((day) => ({
          name: day.name,
          templateId: day.templateId,
          templateName: day.templateName,
          exerciseCount: day.exerciseCount,
        })),
        nextDay: active.nextDay
          ? {
              dayId: active.nextDay.id,
              name: active.nextDay.name,
              // The id, not just the name: staging the day is
              // draft_workout(mode:"tune", templateId), and a read tool that
              // returns only a name leaves that call undrivable — the agent can
              // describe the session it cannot put on screen.
              templateId: active.nextDay.templateId,
              templateName: active.nextDay.templateName,
              available: active.nextDay.available,
            }
          : null,
      },
      note: active.nextDay
        ? `"${active.name}" is running and its next session is ${active.nextDay.name}. ` +
          'Put it on screen before talking about it: draft_workout with mode "tune" and templateId ' +
          `"${active.nextDay.templateId}" stages it in the app as a reviewable draft the person can see ` +
          'and adjust. start_workout from "plan" begins it live instead, once they have said go.'
        : `"${active.name}" is running but has no next day available; say so rather than substituting one.`,
    })
  },
}

interface PlanDayRow {
  id: string
  name: string
  templateId: string
  templateName: string | null
  exerciseCount?: number
  available?: boolean
}

interface PlanRow {
  id: string
  name: string
  goal: string | null
  status: string
  scheduleMode: string
  completedSessions: number
  days?: PlanDayRow[]
  nextDay?: PlanDayRow | null
}
