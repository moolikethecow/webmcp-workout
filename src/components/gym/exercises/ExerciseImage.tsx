'use client'

/**
 * ExerciseImage — renders a FEDB demo frame through the image proxy route
 * (/api/gym/exercise-image/<path>). The proxy fetches raw.githubusercontent at
 * the pinned SHA on first view and caches it (GYM_PLAN §2.3). On any load error
 * — un-vendored path, network, custom exercise with no images — it falls back
 * to a muscle-SVG (MiniMuscleMap) so the surface never shows a broken image.
 *
 * Lazy: native `loading="lazy"` + `decoding="async"`. Used both as the 44px
 * list thumbnail and as one frame of the detail-sheet crossfade hero.
 */
import { useEffect, useState } from 'react'

import { exerciseImageUrl } from '@/lib/gym-client/fetch'
import type { ExerciseRegionHit } from '@/lib/gym-client/types'
import { MiniMuscleMap } from './MiniMuscleMap'

export function ExerciseImage({
  imagePath,
  regions,
  alt,
  size = 44,
  radius = 10,
  eager = false,
}: {
  /** A path from the exercise `images` array, or null to render the fallback directly. */
  imagePath: string | null
  /** Regions for the muscle-SVG fallback. */
  regions: ExerciseRegionHit[]
  alt: string
  size?: number
  radius?: number
  /** Skip lazy loading (for above-the-fold hero frames). */
  eager?: boolean
}) {
  const [errored, setErrored] = useState(false)

  // Reset the error state when the path changes (row recycling / new exercise).
  useEffect(() => {
    setErrored(false)
  }, [imagePath])

  const showFallback = !imagePath || errored

  if (showFallback) {
    return (
      <div
        aria-label={alt}
        role="img"
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: 'var(--bg-subtle)',
          border: '1px solid var(--border-muted)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        <MiniMuscleMap regions={regions} size={Math.round(size * 0.92)} showLabels={false} compact />
      </div>
    )
  }

  // Raw <img> (not next/image): the source is an API-proxied, path-validated,
  // ephemerally-cached route (GYM_PLAN §2.3) that next/image can't optimize, and
  // the onError→muscle-SVG fallback needs the native <img> error event. Single-
  // user PWA — no LCP concern.
  return (
    // eslint-disable-next-line @next/next/no-img-element -- proxied dynamic source; see note above
    <img
      src={exerciseImageUrl(imagePath)}
      alt={alt}
      width={size}
      height={size}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setErrored(true)}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        objectFit: 'cover',
        background: 'var(--bg-subtle)',
        border: '1px solid var(--border-muted)',
        flexShrink: 0,
        display: 'block',
      }}
    />
  )
}
