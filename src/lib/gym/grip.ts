/**
 * Grip and attachment — how a movement was actually held, and on what.
 *
 * ── Why this is an attribute, not a new exercise ───────────────────────────
 * A cable row on a rope, on a V-bar, and on a MAG handle are the same movement
 * done three ways. Modelling them as three catalog rows multiplies the catalog
 * and, worse, restarts the history at zero the day the user switches handles. So the
 * exercise stays one row and the hardware becomes an attribute of the SET.
 *
 * The user, 2026-08-31, on why this exists at all: he did pulldowns on the MAG
 * handle, had nowhere to record it, and wrote it in a free-text note — where it
 * was invisible to records and to every weight later suggested.
 *
 * ── Three columns, two ideas ───────────────────────────────────────────────
 * The user asked for "two fields", and the argument he agreed with was that folding
 * independent things into one list forces a false choice at logging time. That
 * argument applies once more inside grip itself: width (wide/close) and
 * orientation (over/under/neutral) are independent, and a single combined list
 * would mean logging "wide" throws away the orientation. So the DATA has three
 * columns; the UI presents two controls, one of which has two small pickers.
 *
 * Every value is optional at every level. Logging a set without touching any of
 * this is exactly as fast as it is today.
 */

/** Where the hands sit relative to the shoulders. */
export const GRIP_WIDTHS = ['wide', 'standard', 'close'] as const
export type GripWidth = (typeof GRIP_WIDTHS)[number]

/** Which way the palms face. */
export const GRIP_ORIENTATIONS = [
  'pronated',
  'supinated',
  'neutral',
  'mixed',
  'false',
  'hook',
] as const
export type GripOrientation = (typeof GRIP_ORIENTATIONS)[number]

/**
 * The interchangeable thing between the hands and the load.
 *
 * Deliberately NOT in here: barbell, dumbbell, kettlebell, cable. Those are the
 * implement, which the catalog already records in `exercises.equipment`.
 * Attachment is only what you swap WITHOUT changing exercise — which is the
 * whole reason it can't be part of the name.
 */
export const ATTACHMENTS = [
  'mag',
  'lat_bar',
  'straight_bar',
  'ez_bar',
  'v_bar',
  'rope',
  'single_handle',
  'dual_handles',
  'ankle_strap',
  'swiss_bar',
  'trap_bar',
  'safety_squat_bar',
  'landmine',
  'rings',
  'suspension_straps',
  'pull_up_bar',
  'parallel_bars',
  'fat_grips',
  'towel',
  'dip_belt',
  'machine_default',
] as const
export type Attachment = (typeof ATTACHMENTS)[number]

export interface GripSpec {
  gripWidth: GripWidth | null
  gripOrientation: GripOrientation | null
  attachment: Attachment | null
}

export const EMPTY_GRIP: GripSpec = {
  gripWidth: null,
  gripOrientation: null,
  attachment: null,
}

const WIDTHS = new Set<string>(GRIP_WIDTHS)
const ORIENTATIONS = new Set<string>(GRIP_ORIENTATIONS)
const ATTACHMENT_SET = new Set<string>(ATTACHMENTS)

export function isGripWidth(v: unknown): v is GripWidth {
  return typeof v === 'string' && WIDTHS.has(v)
}
export function isGripOrientation(v: unknown): v is GripOrientation {
  return typeof v === 'string' && ORIENTATIONS.has(v)
}
export function isAttachment(v: unknown): v is Attachment {
  return typeof v === 'string' && ATTACHMENT_SET.has(v)
}

/** Coerce a DB row's three loose columns into a GripSpec, dropping junk. */
export function toGripSpec(row: {
  grip_width?: unknown
  grip_orientation?: unknown
  attachment?: unknown
}): GripSpec {
  return {
    gripWidth: isGripWidth(row.grip_width) ? row.grip_width : null,
    gripOrientation: isGripOrientation(row.grip_orientation) ? row.grip_orientation : null,
    attachment: isAttachment(row.attachment) ? row.attachment : null,
  }
}

/** True when nothing at all is specified. */
export function isEmptyGrip(g: GripSpec): boolean {
  return g.gripWidth === null && g.gripOrientation === null && g.attachment === null
}

/**
 * The grip a set was actually performed with.
 *
 * ⚠️ A null on the SET means "inherit from the exercise", NOT "explicitly no
 * grip". That distinction is the whole reason starting a workout must not copy
 * the exercise's grip down onto every set: if it did, changing your mind at set
 * one would leave sets two and three holding a stale copy. Reading null as
 * "ask the exercise" is the only version where editing upward behaves the way
 * anyone expects.
 *
 * Inheritance is PER FIELD, not all-or-nothing — a set that overrides only the
 * width still inherits the attachment, because switching to a close grip on the
 * same handle is a normal thing to do mid-exercise.
 */
export function resolveGrip(set: Partial<GripSpec>, exercise: GripSpec): GripSpec {
  return {
    gripWidth: set.gripWidth ?? exercise.gripWidth,
    gripOrientation: set.gripOrientation ?? exercise.gripOrientation,
    attachment: set.attachment ?? exercise.attachment,
  }
}

const WIDTH_LABELS: Record<GripWidth, string> = {
  wide: 'Wide',
  standard: 'Standard',
  close: 'Close',
}

const ORIENTATION_LABELS: Record<GripOrientation, string> = {
  pronated: 'Overhand',
  supinated: 'Underhand',
  neutral: 'Neutral',
  mixed: 'Mixed',
  false: 'Thumbless',
  hook: 'Hook',
}

const ATTACHMENT_LABELS: Record<Attachment, string> = {
  mag: 'MAG',
  lat_bar: 'Lat bar',
  straight_bar: 'Straight bar',
  ez_bar: 'EZ bar',
  v_bar: 'V-bar',
  rope: 'Rope',
  single_handle: 'Single handle',
  dual_handles: 'Dual handles',
  ankle_strap: 'Ankle strap',
  swiss_bar: 'Swiss bar',
  trap_bar: 'Trap bar',
  safety_squat_bar: 'Safety squat bar',
  landmine: 'Landmine',
  rings: 'Rings',
  suspension_straps: 'Suspension straps',
  pull_up_bar: 'Pull-up bar',
  parallel_bars: 'Parallel bars',
  fat_grips: 'Fat grips',
  towel: 'Towel',
  dip_belt: 'Dip belt',
  machine_default: 'Machine handles',
}

export function gripWidthLabel(v: GripWidth): string {
  return WIDTH_LABELS[v]
}
export function gripOrientationLabel(v: GripOrientation): string {
  return ORIENTATION_LABELS[v]
}
export function attachmentLabel(v: Attachment): string {
  return ATTACHMENT_LABELS[v]
}

/**
 * A short human label: "Wide overhand · MAG", "Neutral · rope", "MAG".
 *
 * Returns null when nothing is set, so a caller can omit the line entirely
 * rather than print an empty one — most sets will carry no grip at all, and a
 * dangling separator on every row is worse than no label.
 */
export function gripLabel(g: GripSpec): string | null {
  const hand = [
    g.gripWidth ? WIDTH_LABELS[g.gripWidth] : null,
    g.gripOrientation ? ORIENTATION_LABELS[g.gripOrientation].toLowerCase() : null,
  ]
    .filter(Boolean)
    .join(' ')
  const parts = [hand || null, g.attachment ? ATTACHMENT_LABELS[g.attachment] : null].filter(
    Boolean,
  )
  if (parts.length === 0) return null
  // Capitalize when the hand part is missing and the attachment leads.
  const label = parts.join(' · ')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/**
 * A stable key for grouping sets by "same way of doing it".
 *
 * Sets logged before this shipped carry no grip at all and all collapse onto
 * `unspecified` — real history that stays in the overall trend but cannot be
 * compared handle-to-handle, because nobody wrote down which handle it was.
 */
export function gripKey(g: GripSpec): string {
  if (isEmptyGrip(g)) return 'unspecified'
  return [g.gripWidth ?? '-', g.gripOrientation ?? '-', g.attachment ?? '-'].join('|')
}
