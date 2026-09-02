'use client'

/**
 * /gym — the Gym section (GYM_PLAN §2.1). Thin page wrapper: the shell
 * reads `?tab=` via useSearchParams, which requires a <Suspense> boundary for
 * the App Router's client-side-rendering bailout (the build fails without it —
 * same rule as /finance and /health).
 */
import { Suspense } from 'react'

import GymShell from '@/components/gym/shell/GymShell'

export default function GymPage() {
  return (
    <Suspense fallback={<div className="page-fade" style={{ padding: '32px 28px' }} />}>
      <GymShell />
    </Suspense>
  )
}
