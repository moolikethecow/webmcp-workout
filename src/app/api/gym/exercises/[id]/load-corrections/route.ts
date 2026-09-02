import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { authenticateRequest } from '@/lib/auth'
import { ensureGymSchema } from '@/lib/db/ensure-fitness'
import {
  applyLoadCorrection,
  listLoadCorrections,
  LoadCorrectionError,
  previewLoadCorrection,
  revertLoadCorrection,
} from '@/lib/gym/load-corrections'

const Uuid = z.string().uuid()
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }, 'Invalid calendar date')

const BodySchema = z
  .object({
    action: z.enum(['preview', 'apply', 'revert']),
    startDate: IsoDate.nullable().optional(),
    endDate: IsoDate.nullable().optional(),
    divisor: z.number().finite().positive().max(1000).optional(),
    reason: z.string().trim().max(240).nullable().optional(),
    correctionId: Uuid.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.startDate && value.endDate && value.startDate > value.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'endDate must be on or after startDate',
      })
    }
    if (value.action === 'revert' && !value.correctionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correctionId'],
        message: 'correctionId is required for revert',
      })
    }
  })

type RouteContext = { params: Promise<{ id: string }> }

function serviceError(error: unknown): NextResponse | null {
  if (!(error instanceof LoadCorrectionError)) return null
  const status = error.code === 'overlap' || error.code === 'inactive' ? 409 : 404
  return NextResponse.json({ error: error.message, code: error.code }, { status })
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const parsedId = Uuid.safeParse((await params).id)
  if (!parsedId.success) {
    return NextResponse.json({ error: 'Invalid exercise id' }, { status: 400 })
  }

  try {
    await ensureGymSchema()
    const includeReverted = req.nextUrl.searchParams.get('includeReverted') === 'true'
    const corrections = await listLoadCorrections(parsedId.data, includeReverted)
    return NextResponse.json({
      corrections,
      summary: {
        active: corrections.filter((item) => item.active && item.revertedAt == null).length,
        affectedSets: corrections
          .filter((item) => item.active && item.revertedAt == null)
          .reduce((sum, item) => sum + item.affectedSets, 0),
      },
    })
  } catch (error) {
    console.error(
      '[gym/load-corrections] GET failed:',
      error instanceof Error ? error.message : error,
    )
    return NextResponse.json({ error: 'Failed to load corrections' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  if (!authenticateRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const parsedId = Uuid.safeParse((await params).id)
  if (!parsedId.success) {
    return NextResponse.json({ error: 'Invalid exercise id' }, { status: 400 })
  }

  const json = await req.json().catch(() => null)
  const parsed = BodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  try {
    await ensureGymSchema()
    if (parsed.data.action === 'revert') {
      return NextResponse.json(
        await revertLoadCorrection(parsedId.data, parsed.data.correctionId!),
      )
    }
    const input = {
      exerciseId: parsedId.data,
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
      divisor: parsed.data.divisor,
      reason: parsed.data.reason,
    }
    if (parsed.data.action === 'preview') {
      return NextResponse.json({ preview: await previewLoadCorrection(input) })
    }
    return NextResponse.json(await applyLoadCorrection(input), { status: 201 })
  } catch (error) {
    const known = serviceError(error)
    if (known) return known
    console.error(
      '[gym/load-corrections] POST failed:',
      error instanceof Error ? error.message : error,
    )
    return NextResponse.json({ error: 'Failed to update corrections' }, { status: 500 })
  }
}
