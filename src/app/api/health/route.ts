import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * Liveness, plus which build is answering.
 *
 * `build` is the commit SHA baked into the image at build time (Dockerfile
 * `ARG APP_BUILD`, set by CI). It is here because "the deploy succeeded" and
 * "the new code is serving" are different claims: a failed apply leaves the
 * previous container running and healthy, so without a build stamp there is no
 * way to tell the two apart from outside. The deploy seam polls this field.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    build: process.env.APP_BUILD ?? null,
    at: new Date().toISOString(),
  })
}
