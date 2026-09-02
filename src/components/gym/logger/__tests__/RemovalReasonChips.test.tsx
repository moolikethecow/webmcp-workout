/**
 * @vitest-environment jsdom
 *
 * RemovalReasonChips (P3-A3) — the reason-chip routing table (GYM_PLAN §4/§6). The
 * load-bearing assertion: each chip fires the RIGHT write, and ONLY "Don't like it"
 * writes a hard dislike. `fetch` is mocked; the self-mounting host is torn down
 * between cases.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  fireRemovalReason,
  showRemovalReason,
  __resetRemovalReasonHostForTests,
} from '../RemovalReasonChips'

// createRoot needs the act environment flag set for React to batch/flush cleanly.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  __resetRemovalReasonHostForTests()
  vi.unstubAllGlobals()
})

const info = { exerciseId: 'ex-1', exerciseName: 'Leg Press' }

// ── The routing table (each chip → the right call) ───────────────────────────
describe('fireRemovalReason — routing table', () => {
  it('Don\'t like it → PATCH exercises/{id} {disliked:true} (the ONLY dislike write)', async () => {
    await fireRemovalReason(info, 'dislike')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/gym/exercises/ex-1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ disliked: true })
  })

  it('Bored of it → PATCH exercises/{id} {snoozeDays:14} (soft cooldown, no dislike)', async () => {
    await fireRemovalReason(info, 'bored')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/gym/exercises/ex-1')
    expect(init.method).toBe('PATCH')
    const body = JSON.parse(init.body)
    expect(body.snoozeDays).toBe(14)
    expect(body.disliked).toBeUndefined() // NOT a dislike
  })

  it('Not available here → POST gyms {excludeExercise:name}', async () => {
    await fireRemovalReason(info, 'unavailable')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/gym/gyms')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ excludeExercise: 'Leg Press' })
  })

  it('Tweaked → POST injuries {tweak:{region,days}} using the exercise primary region', async () => {
    // "Leg Press" resolves to quads primary via the muscle mapper.
    await fireRemovalReason(info, 'tweaked')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/gym/injuries')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.tweak.region).toBe('quads')
    expect(body.tweak.days).toBe(7)
  })

  it('Tweaked with no resolvable region → no write', async () => {
    await fireRemovalReason({ exerciseId: 'x', exerciseName: 'Zzz Nonsense' }, 'tweaked')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Skip → does nothing', async () => {
    await fireRemovalReason(info, 'skip')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // #1876 — marks the REPLACEMENT exercise preferred, not the one that left.
  it('Preferred it → PATCH exercises/{replacementId} {preferred:true}', async () => {
    await fireRemovalReason(
      { ...info, replaced: true, replacementExerciseId: 'ex-2', replacementExerciseName: 'Lever Row' },
      'preference',
    )
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/gym/exercises/ex-2')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ preferred: true })
  })

  it('Preferred it with no replacement on the info → no write', async () => {
    await fireRemovalReason(info, 'preference')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a failed write only warns — never throws (removal already committed)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(fireRemovalReason(info, 'dislike')).resolves.toBeUndefined()
  })
})

// ── Self-mounting toast smoke test ───────────────────────────────────────────
describe('showRemovalReason — self-mounting toast', () => {
  it('mounts a chip row into <body> with all five chips', async () => {
    await act(async () => {
      showRemovalReason(info)
    })
    const host = document.querySelector('[data-removal-reason-host]')
    expect(host).not.toBeNull()
    const buttons = host!.querySelectorAll('button')
    const labels = [...buttons].map((b) => b.textContent)
    expect(labels).toEqual(["Don't like it", 'Bored of it', 'Not available here', 'Tweaked', 'Skip'])
  })

  it('tapping a chip fires the corresponding write', async () => {
    await act(async () => {
      showRemovalReason(info)
    })
    const host = document.querySelector('[data-removal-reason-host]')!
    const boredBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Bored of it')!
    await act(async () => {
      boredBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/gym/exercises/ex-1', expect.objectContaining({ method: 'PATCH' }))
  })

  it('shows "Preferred it" only when the toast carries a replacement (#1876)', async () => {
    await act(async () => {
      showRemovalReason({
        ...info,
        replaced: true,
        replacementExerciseId: 'ex-2',
        replacementExerciseName: 'Lever Row',
      })
    })
    const host = document.querySelector('[data-removal-reason-host]')!
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toEqual([
      "Don't like it",
      'Bored of it',
      'Not available here',
      'Tweaked',
      'Preferred it',
      'Skip',
    ])
  })
})
