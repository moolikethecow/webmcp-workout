/**
 * Habit-tracker seam.
 *
 * Habits are not part of this app — a finished workout can be linked to one via
 * `app_settings.gym_linked_habit_id` upstream, and the gym engine calls these
 * when that link is set. With no habit tracker there is never a link, so these
 * are inert.
 */
export interface HabitLogRow {
  id: string
  habit_id: string
  date: string
  completion_state: string
  current_streak: number | null
}

/** Record a habit completion for a day. No-op without a habit tracker. */
export async function logHabitForDate(args: {
  habit_id: string
  date?: string
  completion_state: string
  note?: string | null
  occurred_at?: Date
  logged_via?: string
}): Promise<HabitLogRow> {
  return {
    id: '',
    habit_id: args.habit_id,
    date: args.date ?? '',
    completion_state: args.completion_state,
    current_streak: null,
  }
}

/** Recompute a habit's streak after a log was added or removed. No-op here. */
export async function reconcileHabitAfterLogMutation(args: {
  habit_id: string
  date: string
}): Promise<{ habit_id: string; date: string; current_streak: number | null }> {
  return { habit_id: args.habit_id, date: args.date, current_streak: null }
}
