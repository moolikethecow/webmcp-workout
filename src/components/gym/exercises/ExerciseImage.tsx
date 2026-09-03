'use client'

/**
 * ExerciseImage — the exercise's thumbnail: a muscle-map tile drawn from its
 * region hits. Nothing is fetched. The catalog's rows still carry the media
 * file names of the dataset they came from, but that media is © a third party
 * and is not served by this app (see README § Data and media), so the figure
 * is the one rendering, at every size, for catalog and custom exercises alike.
 *
 * Used both as the 44px list thumbnail and as the 200px detail-sheet hero.
 */
import type { ExerciseRegionHit } from '@/lib/gym-client/types'
import { MiniMuscleMap } from './MiniMuscleMap'

export function ExerciseImage({
  regions,
  alt,
  size = 44,
  radius = 10,
}: {
  /** Regions the figure highlights. */
  regions: ExerciseRegionHit[]
  alt: string
  size?: number
  radius?: number
}) {
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
