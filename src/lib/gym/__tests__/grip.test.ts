/**
 * Grip and attachment (2026-08-31).
 *
 * The load-bearing rule here is inheritance: a NULL on a SET means "inherit
 * from the exercise", never "explicitly no grip". Everything else is
 * vocabulary and labels.
 */
import { describe, expect, it } from 'vitest'

import {
  ATTACHMENTS,
  EMPTY_GRIP,
  GRIP_ORIENTATIONS,
  GRIP_WIDTHS,
  attachmentLabel,
  gripKey,
  gripLabel,
  isAttachment,
  isEmptyGrip,
  isGripOrientation,
  isGripWidth,
  resolveGrip,
  toGripSpec,
  type GripSpec,
} from '../grip'

const spec = (over: Partial<GripSpec> = {}): GripSpec => ({ ...EMPTY_GRIP, ...over })

describe('vocabulary', () => {
  // The user: "make sure that every type of hardware is an option. I know there are
  // more than 5 no?"
  it('carries a real hardware list, not a token five', () => {
    expect(ATTACHMENTS.length).toBeGreaterThanOrEqual(20)
    expect(ATTACHMENTS).toContain('mag')
    expect(ATTACHMENTS).toContain('rope')
    expect(ATTACHMENTS).toContain('v_bar')
  })

  // The implement is already `exercises.equipment`. Attachment is only what can
  // be swapped WITHOUT changing exercise — which is why it can't be in the name.
  it.each(['barbell', 'dumbbell', 'kettlebell', 'cable'])(
    'does not list %s, which is the implement not the attachment',
    (v) => {
      expect(ATTACHMENTS).not.toContain(v)
    },
  )

  it('every value has a label', () => {
    for (const a of ATTACHMENTS) expect(attachmentLabel(a)).toBeTruthy()
  })

  it.each([
    ['width', isGripWidth, GRIP_WIDTHS],
    ['orientation', isGripOrientation, GRIP_ORIENTATIONS],
    ['attachment', isAttachment, ATTACHMENTS],
  ] as const)('%s guards accept their own values and reject junk', (_l, guard, values) => {
    for (const v of values) expect(guard(v)).toBe(true)
    expect(guard('nonsense')).toBe(false)
    expect(guard(null)).toBe(false)
    expect(guard(42)).toBe(false)
  })
})

describe('toGripSpec drops values the vocabulary does not know', () => {
  it('keeps valid values and nulls the rest', () => {
    expect(
      toGripSpec({ grip_width: 'wide', grip_orientation: 'banana', attachment: 'mag' }),
    ).toEqual({ gripWidth: 'wide', gripOrientation: null, attachment: 'mag' })
  })

  it('reads an all-null row as empty', () => {
    expect(isEmptyGrip(toGripSpec({}))).toBe(true)
  })
})

describe('resolveGrip — a set NULL means inherit, not "none"', () => {
  const exercise = spec({ gripWidth: 'wide', gripOrientation: 'pronated', attachment: 'lat_bar' })

  it('a set that specifies nothing performs the exercise grip', () => {
    expect(resolveGrip({}, exercise)).toEqual(exercise)
  })

  // Per FIELD, not all-or-nothing: switching to a close grip on the SAME handle
  // is an ordinary thing to do mid-exercise, and would be unloggable if
  // overriding one field silently blanked the others.
  it('inherits field by field, so overriding width keeps the attachment', () => {
    expect(resolveGrip({ gripWidth: 'close' }, exercise)).toEqual({
      gripWidth: 'close',
      gripOrientation: 'pronated',
      attachment: 'lat_bar',
    })
  })

  it('a full override wins on every field', () => {
    const drop = spec({ gripWidth: 'close', gripOrientation: 'neutral', attachment: 'v_bar' })
    expect(resolveGrip(drop, exercise)).toEqual(drop)
  })

  it('inherits nothing when the exercise specifies nothing', () => {
    expect(resolveGrip({}, EMPTY_GRIP)).toEqual(EMPTY_GRIP)
  })
})

describe('gripLabel', () => {
  it.each([
    [spec({ gripWidth: 'wide', gripOrientation: 'pronated', attachment: 'mag' }), 'Wide overhand · MAG'],
    [spec({ gripOrientation: 'neutral', attachment: 'rope' }), 'Neutral · Rope'],
    [spec({ attachment: 'mag' }), 'MAG'],
    [spec({ gripWidth: 'close' }), 'Close'],
  ])('renders %o as %s', (g, expected) => {
    expect(gripLabel(g)).toBe(expected)
  })

  // Most sets carry no grip at all. A dangling separator on every row is worse
  // than no label, so the caller gets null and omits the line.
  it('returns null when nothing is set', () => {
    expect(gripLabel(EMPTY_GRIP)).toBeNull()
  })
})

describe('gripKey groups "the same way of doing it"', () => {
  it('is stable for the same spec and different across specs', () => {
    const a = spec({ attachment: 'mag', gripOrientation: 'neutral' })
    const b = spec({ attachment: 'mag', gripOrientation: 'neutral' })
    const c = spec({ attachment: 'rope', gripOrientation: 'neutral' })
    expect(gripKey(a)).toBe(gripKey(b))
    expect(gripKey(a)).not.toBe(gripKey(c))
  })

  // Everything logged before this shipped collapses here — real history that
  // stays in the overall trend but cannot be compared handle-to-handle.
  it('collapses an unrecorded grip onto one bucket', () => {
    expect(gripKey(EMPTY_GRIP)).toBe('unspecified')
  })

  // A partially-specified grip is NOT the same as an unspecified one: "MAG,
  // width unrecorded" is a different thing from "nothing recorded".
  it('keeps a partial spec distinct from unspecified', () => {
    expect(gripKey(spec({ attachment: 'mag' }))).not.toBe('unspecified')
  })
})
