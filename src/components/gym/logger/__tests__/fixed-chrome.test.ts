import { describe, expect, it } from 'vitest'

import {
  chromeBoundsFromRects,
  workoutContentBottomReserve,
  WORKOUT_FINISH_BAR_RESERVE_PX,
  WORKOUT_REST_TIMER_RESERVE_PX,
} from '../fixed-chrome'

describe('chromeBoundsFromRects', () => {
  it('keeps fixed workout controls between desktop navigation and ChatRail', () => {
    expect(
      chromeBoundsFromRects(
        { width: 1440, height: 900 },
        { left: 224, right: 1080 },
        null,
      ),
    ).toEqual({ left: 224, right: 360, bottom: 0 })
  })

  it('lifts controls above the full mobile tab bar including its safe area', () => {
    expect(
      chromeBoundsFromRects(
        { width: 390, height: 844 },
        { left: 0, right: 390 },
        { top: 724, height: 120 },
      ),
    ).toEqual({ left: 0, right: 0, bottom: 120 })
  })

  it('reserves the exact stacked fixed-bar height only while a rest timer exists', () => {
    expect(workoutContentBottomReserve(false)).toBe(WORKOUT_FINISH_BAR_RESERVE_PX)
    expect(workoutContentBottomReserve(true)).toBe(
      WORKOUT_FINISH_BAR_RESERVE_PX + WORKOUT_REST_TIMER_RESERVE_PX,
    )
  })
})
