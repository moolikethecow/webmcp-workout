/**
 * Every tool's contract, checked structurally.
 *
 * A malformed `inputSchema` is rejected by the browser at registration time and
 * the tool silently does not exist — a failure mode that is invisible in the
 * app and only shows up when an agent cannot find the tool. Catch it here.
 */
import { describe, expect, it } from 'vitest'

import { ALL_TOOLS, DECLARATIVE_FALLBACKS, toolsForPage } from '../tools'

/** Everything an agent can ever be handed, form stand-in included. */
const EVERY_TOOL = [...ALL_TOOLS, ...DECLARATIVE_FALLBACKS]
import type { JsonSchemaObject } from '../types'

/** Walk every nested schema object so array `items` are checked too. */
function nestedObjectSchemas(schema: unknown, out: JsonSchemaObject[] = []): JsonSchemaObject[] {
  if (!schema || typeof schema !== 'object') return out
  const node = schema as Record<string, unknown>
  if (node.type === 'object') out.push(node as JsonSchemaObject)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((entry) => nestedObjectSchemas(entry, out))
    else if (value && typeof value === 'object') nestedObjectSchemas(value, out)
  }
  return out
}

describe('tool definitions', () => {
  it('exposes sixteen tools plus the form stand-in, with unique snake_case names', () => {
    expect(ALL_TOOLS).toHaveLength(16)
    expect(DECLARATIVE_FALLBACKS).toHaveLength(1)
    const names = EVERY_TOOL.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it.each(EVERY_TOOL.map((tool) => [tool.name, tool] as const))(
    '%s has a valid draft-07 object schema',
    (_name, tool) => {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties).toBeTypeOf('object')

      for (const schema of nestedObjectSchemas(tool.inputSchema)) {
        const properties = (schema.properties ?? {}) as Record<string, unknown>
        expect(properties).toBeTypeOf('object')
        const required = schema.required ?? []
        expect(Array.isArray(required)).toBe(true)
        // required ⊆ properties — a required key with no property is the
        // classic schema that registers nowhere.
        for (const key of required) expect(Object.keys(properties)).toContain(key)
        // Every property must declare a type the browser understands.
        for (const [key, value] of Object.entries(properties)) {
          expect(value, `${_name}.${key}`).toBeTypeOf('object')
          expect((value as { type?: string }).type, `${_name}.${key}`).toBeTruthy()
        }
      }
    },
  )

  it.each(EVERY_TOOL.map((tool) => [tool.name, tool] as const))(
    '%s describes when to use it',
    (_name, tool) => {
      // Descriptions are the only guidance an agent gets. Short ones are a bug.
      expect(tool.description.length).toBeGreaterThan(80)
      expect(typeof tool.execute).toBe('function')
    },
  )

  it('marks every read-only tool and no mutating tool as readOnlyHint', () => {
    const readOnly = EVERY_TOOL.filter((tool) => tool.annotations?.readOnlyHint === true).map((t) => t.name)
    expect(readOnly.sort()).toEqual(
      [
        'get_active_workout',
        'get_exercise_progress',
        'get_muscle_readiness',
        'get_training_constraints',
        'get_training_context',
        'get_training_plan',
        'get_workout_history',
        'list_gyms',
        'search_exercises',
      ].sort(),
    )
  })

  it('registers the live editor only where a live session is visible', () => {
    const gym = toolsForPage('gym').map((tool) => tool.name)
    const dashboard = toolsForPage('dashboard').map((tool) => tool.name)
    const history = toolsForPage('history').map((tool) => tool.name)

    expect(gym).toContain('edit_active_workout')
    expect(gym).toContain('log_active_sets')
    expect(dashboard).not.toContain('edit_active_workout')
    expect(dashboard).not.toContain('log_active_sets')
    expect(history).not.toContain('edit_active_workout')
    expect(dashboard).toContain('draft_workout')
    expect(history).not.toContain('draft_workout')
    // Orientation and reads are available everywhere.
    for (const page of ['gym', 'dashboard', 'history'] as const) {
      expect(toolsForPage(page).map((tool) => tool.name)).toContain('get_training_context')
    }
  })

  it('uses the public vocabulary — "training constraint", never "injury"', () => {
    // The one sanctioned exception is the non-medical disclaimer, which has to
    // say the word in order to disclaim it.
    const DISCLAIMER = 'This does not diagnose an injury or prescribe rehabilitation.'
    for (const tool of EVERY_TOOL) {
      expect(tool.name).not.toMatch(/injur/i)
      expect(tool.description.replace(DISCLAIMER, ''), tool.name).not.toMatch(/injur/i)
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/injur/i)
    }
    const setter = ALL_TOOLS.find((tool) => tool.name === 'set_training_constraint')!
    expect(setter.description).toContain(DISCLAIMER)
    const reporter = DECLARATIVE_FALLBACKS.find((tool) => tool.name === 'report_training_constraint')!
    expect(reporter.description).toContain(DISCLAIMER)
    // The surprising part has to be in the description: nothing is recorded
    // by the call itself, and the button is not the agent's.
    expect(reporter.description).toMatch(/nothing is recorded until the person presses Add/i)
    expect(reporter.description).toMatch(/do not click it for them/i)
  })
})
