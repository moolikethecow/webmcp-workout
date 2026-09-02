/**
 * Rest-timer push notifications.
 *
 * The logger's rest timer runs in the tab and rings through `lib/timers/chime`,
 * so there is no server-side push service here. These stay as the named hooks
 * the write paths call, and do nothing.
 */

/** Cancel any pending rest push for a workout (finish / un-complete a set). */
export function cancelPushForWorkout(_workoutId: string): void {}

/** Schedule the rest-end push after a batch of sets flipped to completed. */
export async function onSetsCompleted(
  _workoutId: string,
  _completedExerciseIds: string[],
): Promise<void> {}
