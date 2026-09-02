import { agentFetch, query } from '../fetch'
import type { WebMcpTool } from '../types'
import { failFrom, num, ok, str } from './shared'

export const getWorkoutHistory: WebMcpTool = {
  name: 'get_workout_history',
  description:
    'Completed sessions: a month calendar, the last eight weeks of session count and working volume, ' +
    'a page of sessions newest first (name, date, duration, exercise and set counts, volume, PRs, source ' +
    'template), and the template "eras" the training has moved through. Use it for "what did I do last ' +
    'week", for streaks and for volume trends. Only completed workouts appear here — the one in ' +
    'progress is get_active_workout. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      month: { type: 'string', description: 'Calendar month as YYYY-MM. Defaults to the current month.' },
      limit: { type: 'integer', description: 'Sessions per page.' },
      offset: { type: 'integer', description: 'Sessions to skip, for paging further back.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async execute(args) {
    const path =
      '/api/gym/history' +
      query({ month: str(args, 'month'), limit: num(args, 'limit'), offset: num(args, 'offset') })
    const result = await agentFetch(path)
    if (!result.ok) return failFrom(result, 'Could not load workout history')
    return ok(result.json)
  },
}
