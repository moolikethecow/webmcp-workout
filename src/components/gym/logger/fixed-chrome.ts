'use client'

import { useEffect, useState } from 'react'

export interface AppChromeBounds {
  left: number
  right: number
  bottom: number
}

/** Fixed workout chrome reserves. Keep the content spacer and the fixed-bar
 * offsets on the same source of truth so one bar cannot cover the final set. */
export const WORKOUT_FINISH_BAR_RESERVE_PX = 76
export const WORKOUT_REST_TIMER_RESERVE_PX = 56

export function workoutContentBottomReserve(hasRestTimer: boolean): number {
  return (
    WORKOUT_FINISH_BAR_RESERVE_PX +
    (hasRestTimer ? WORKOUT_REST_TIMER_RESERVE_PX : 0)
  )
}

const ZERO: AppChromeBounds = { left: 0, right: 0, bottom: 0 }

/** Fixed workout controls live in viewport coordinates, while the app's main
 * flexes around the pinned icon rail and the optional ChatRail. Measure those
 * real bounds rather than copying either rail's width into gym code. */
export function chromeBoundsFromRects(
  viewport: { width: number; height: number },
  main: Pick<DOMRect, 'left' | 'right'> | null,
  mobileNav: Pick<DOMRect, 'top' | 'height'> | null,
): AppChromeBounds {
  return {
    left: Math.max(0, Math.round(main?.left ?? 0)),
    right: Math.max(0, Math.round(viewport.width - (main?.right ?? viewport.width))),
    bottom:
      mobileNav && mobileNav.height > 0
        ? Math.max(0, Math.round(viewport.height - mobileNav.top))
        : 0,
  }
}

export function useAppChromeBounds(): AppChromeBounds {
  const [bounds, setBounds] = useState<AppChromeBounds>(ZERO)

  useEffect(() => {
    const main = document.querySelector<HTMLElement>('.app-main')
    const mobileNav = document.querySelector<HTMLElement>('.mobile-tabbar')
    const update = () => {
      const next = chromeBoundsFromRects(
        { width: window.innerWidth, height: window.innerHeight },
        main?.getBoundingClientRect() ?? null,
        mobileNav?.getBoundingClientRect() ?? null,
      )
      setBounds((current) =>
        current.left === next.left && current.right === next.right && current.bottom === next.bottom
          ? current
          : next,
      )
    }

    update()
    window.addEventListener('resize', update)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (main) observer?.observe(main)
    if (mobileNav) observer?.observe(mobileNav)
    return () => {
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [])

  return bounds
}
