import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const execute = vi.hoisted(() => vi.fn())
const ensureApp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const ensureGym = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const getGymUnits = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db/client', () => ({ db: { execute } }))
vi.mock('@/lib/auth', () => ({ authenticateRequest: () => true }))
vi.mock('@/lib/db/ensure-app-settings', () => ({ ensureAppSettingsSchema: ensureApp }))
vi.mock('@/lib/db/ensure-fitness', () => ({ ensureGymSchema: ensureGym }))
vi.mock('@/lib/gym/unit-preferences', () => ({ getGymUnitPreferences: getGymUnits }))

const { GET, PATCH } = await import('../route')

function patchReq(body: object) {
  return new NextRequest('http://localhost/api/gym/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The SQL text of the Nth db.execute call, params inlined as `$n` markers. */
function sqlText(call = 0): string {
  const arg = execute.mock.calls[call]![0] as { queryChunks?: unknown[] }
  return JSON.stringify(arg)
}

beforeEach(() => {
  vi.clearAllMocks()
  getGymUnits.mockResolvedValue({
    system: 'metric',
    appWeightUnit: 'kg',
    appDistanceUnit: 'km',
    weightOverride: null,
    distanceOverride: null,
    weightUnit: 'kg',
    distanceUnit: 'km',
    bodyLengthUnit: 'cm',
  })
})

describe('/api/gym/settings unit overrides', () => {
  it('follows the app-wide units when no gym override is set', async () => {
    execute.mockResolvedValue({ rows: [{ weight_unit: 'kg', gym_default_unit: 'lb' }] })
    const res = await GET(new NextRequest('http://localhost/api/gym/settings'))
    expect((await res.json()).gym_default_unit).toBe('kg')
    expect(ensureApp).toHaveBeenCalledOnce()
    expect(ensureGym).toHaveBeenCalledOnce()
  })

  it('stores a gym-only override without mutating the app-wide unit', async () => {
    getGymUnits.mockResolvedValue({
      system: 'imperial',
      appWeightUnit: 'lb',
      appDistanceUnit: 'mi',
      weightOverride: 'kg',
      distanceOverride: 'km',
      weightUnit: 'kg',
      distanceUnit: 'km',
      bodyLengthUnit: 'in',
    })
    execute.mockResolvedValue({
      rows: [{ gym_weight_unit_override: 'kg', gym_distance_unit_override: 'km' }],
    })
    const res = await PATCH(patchReq({ gym_weight_unit_override: 'kg', gym_distance_unit_override: 'km' }))

    expect(res.status).toBe(200)
    // The upsert names only the gym_* columns it was given — never the
    // app-wide unit columns.
    const written = sqlText(0)
    expect(written).toContain('gym_weight_unit_override')
    expect(written).toContain('gym_distance_unit_override')
    expect(written).not.toContain('"weight_unit"')
    expect(await res.json()).toMatchObject({
      app_weight_unit: 'lb',
      gym_default_unit: 'kg',
      gym_distance_unit: 'km',
    })
  })
})
