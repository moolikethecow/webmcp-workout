import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  dismissProposal,
  draftPlan,
  fetchAlternatives,
  fetchTodayProposal,
  generatePlan,
  shufflePlan,
  startProposal,
  tunePlan,
} from '../plan-client'

// ── fetch mock ────────────────────────────────────────────────────────────────
type Call = { url: string; init?: RequestInit }
let calls: Call[]

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** The parsed JSON body of the Nth fetch call. */
function bodyOf(n = 0): Record<string, unknown> {
  return JSON.parse(String(calls[n]!.init!.body))
}

beforeEach(() => {
  calls = []
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchTodayProposal', () => {
  it('GETs /api/gym/plan and unwraps { proposal }', async () => {
    mockFetch(200, { proposal: { id: 'p1' } })
    const p = await fetchTodayProposal()
    expect(calls[0]!.url).toBe('/api/gym/plan')
    expect(calls[0]!.init).toBeUndefined() // plain GET (no init)
    expect(p).toEqual({ id: 'p1' })
  })

  it('null proposal → null', async () => {
    mockFetch(200, { proposal: null })
    expect(await fetchTodayProposal()).toBeNull()
  })

  it('throws on a non-ok response', async () => {
    mockFetch(500, {})
    await expect(fetchTodayProposal()).rejects.toThrow(/500/)
  })
})

describe('generatePlan + mode helpers', () => {
  it('draftPlan POSTs mode:draft with a trimmed focus', async () => {
    mockFetch(200, { proposal: { id: 'd1' } })
    const p = await draftPlan('  push day  ')
    expect(calls[0]!.url).toBe('/api/gym/plan')
    expect(calls[0]!.init!.method).toBe('POST')
    expect(bodyOf()).toEqual({ mode: 'draft', focus: 'push day' })
    expect(p).toEqual({ id: 'd1' })
  })

  it('draftPlan with empty focus omits focus', async () => {
    mockFetch(200, { proposal: {} })
    await draftPlan('   ')
    expect(bodyOf()).toEqual({ mode: 'draft' })
  })

  it('tunePlan POSTs mode:tune + templateId', async () => {
    mockFetch(200, { proposal: {} })
    await tunePlan('tpl-9')
    expect(bodyOf()).toEqual({ mode: 'tune', templateId: 'tpl-9' })
  })

  it('shufflePlan POSTs mode:shuffle + proposalId', async () => {
    mockFetch(200, { proposal: {} })
    await shufflePlan('prop-3')
    expect(bodyOf()).toEqual({ mode: 'shuffle', proposalId: 'prop-3' })
  })

  it('generatePlan throws on non-ok', async () => {
    mockFetch(400, {})
    await expect(generatePlan({ mode: 'draft' })).rejects.toThrow(/draft/)
  })
})

describe('startProposal', () => {
  it('POSTs action:start and returns the workout on 200', async () => {
    mockFetch(200, { id: 'w1', exercises: [] })
    const res = await startProposal('p1')
    expect(bodyOf()).toEqual({ action: 'start', proposalId: 'p1' })
    expect(res.workout).toEqual({ id: 'w1', exercises: [] })
    expect(res.conflictActiveWorkoutId).toBeUndefined()
  })

  it('surfaces a 409 as conflictActiveWorkoutId (no throw)', async () => {
    mockFetch(409, { activeWorkoutId: 'w-existing' })
    const res = await startProposal('p1')
    expect(res.conflictActiveWorkoutId).toBe('w-existing')
    expect(res.workout).toBeUndefined()
  })

  it('throws on other non-ok statuses', async () => {
    mockFetch(404, {})
    await expect(startProposal('p1')).rejects.toThrow(/start/)
  })
})

describe('dismissProposal', () => {
  it('POSTs action:dismiss', async () => {
    mockFetch(200, { ok: true })
    await dismissProposal('p1')
    expect(bodyOf()).toEqual({ action: 'dismiss', proposalId: 'p1' })
  })
  it('throws on non-ok', async () => {
    mockFetch(404, {})
    await expect(dismissProposal('p1')).rejects.toThrow(/dismiss/)
  })
})

describe('fetchAlternatives', () => {
  it('GETs the alternatives endpoint with exerciseId + n', async () => {
    mockFetch(200, { region: 'chest', regionLabel: 'Chest', alternatives: [] })
    await fetchAlternatives('ex-1', 8)
    expect(calls[0]!.url).toBe('/api/gym/exercises/alternatives?exerciseId=ex-1&n=8')
  })

  it('omits n when not passed', async () => {
    mockFetch(200, { region: null, regionLabel: null, alternatives: [] })
    await fetchAlternatives('ex-2')
    expect(calls[0]!.url).toBe('/api/gym/exercises/alternatives?exerciseId=ex-2')
  })

  it('throws on non-ok', async () => {
    mockFetch(500, {})
    await expect(fetchAlternatives('ex-1')).rejects.toThrow(/alternatives/)
  })
})
