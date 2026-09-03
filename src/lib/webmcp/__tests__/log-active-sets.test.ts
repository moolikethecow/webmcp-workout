import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockAgentFetch } = vi.hoisted(() => ({ mockAgentFetch: vi.fn() }))

vi.mock('../fetch', () => ({ agentFetch: mockAgentFetch }))

import { logActiveSets } from '../tools/log-active-sets'

const ACTIVE = {
  id: 'workout-1',
  revision: 7,
  weightUnit: 'lb',
  exercises: [
    {
      workoutExerciseId: 'exercise-1',
      name: 'Cable Middle Fly',
      tracks: 'weight_reps',
      sets: [
        {
          clientSetId: 'set-1',
          logicalSetId: '11111111-1111-4111-8111-111111111111',
          setNumber: 1,
          setType: 'normal',
          weight: null,
          weightUnit: 'lb',
          reps: null,
          distanceM: null,
          durationS: null,
          rpe: null,
          restSeconds: 60,
          side: null,
          completed: false,
        },
      ],
    },
  ],
}

beforeEach(() => {
  mockAgentFetch.mockReset()
})

describe('log_active_sets', () => {
  it('records the actual values with the active workout revision', async () => {
    mockAgentFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: ACTIVE })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { revision: 8, byExercise: {} } })

    const result = await logActiveSets.execute({
      expected_revision: 7,
      sets: [{ exercise_name: 'Cable Middle Fly', set_number: 1, weight: 35, weight_unit: 'lb', reps: 12 }],
    })

    expect(result.isError).toBeUndefined()
    expect(mockAgentFetch).toHaveBeenNthCalledWith(1, '/api/gym/workouts/active')
    const [path, init] = mockAgentFetch.mock.calls[1] as [string, { method: string; body: string }]
    expect(path).toBe('/api/gym/workouts/workout-1/sets')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toMatchObject({
      expectedRevision: 7,
      deleteClientSetIds: [],
      sets: [
        {
          clientSetId: 'set-1',
          workoutExerciseId: 'exercise-1',
          weight: 35,
          reps: 12,
          completed: true,
        },
      ],
    })
  })

  it('refuses to guess a missing performance value', async () => {
    mockAgentFetch.mockResolvedValueOnce({ ok: true, status: 200, json: ACTIVE })

    const result = await logActiveSets.execute({
      expected_revision: 7,
      sets: [{ exercise_name: 'Cable Middle Fly', set_number: 1, reps: 12 }],
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toMatch(/weight is required/i)
    expect(mockAgentFetch).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the workout changed after the agent read it', async () => {
    mockAgentFetch.mockResolvedValueOnce({ ok: true, status: 200, json: { ...ACTIVE, revision: 8 } })

    const result = await logActiveSets.execute({
      expected_revision: 7,
      sets: [{ exercise_name: 'Cable Middle Fly', set_number: 1, weight: 35, reps: 12 }],
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toMatch(/changed since get_active_workout/i)
    expect(mockAgentFetch).toHaveBeenCalledTimes(1)
  })
})
