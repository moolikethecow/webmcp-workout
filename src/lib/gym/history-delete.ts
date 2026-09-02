import { sql } from 'drizzle-orm'

import { dropQueuedRetain } from '@/lib/ai/retain-queue'
import { db } from '@/lib/db/client'
import { reconcileHabitAfterLogMutation } from '@/lib/habits'
import { deleteDocument } from '@/lib/memory/store'
import { workoutRetainDocumentId } from '@/lib/memory/document-id'
import { invalidateCoachContext } from './coach-context'

export interface DeleteWorkoutResult {
  deleted: boolean
  habitCompletionRemoved: boolean
}

interface HabitLink {
  habit_id: string
  habit_log_id: string
  habit_date: string
  gym_managed: boolean
}

/**
 * Permanently remove a completed session. This is deliberately narrower than
 * active-workout discard: active/discarded rows return null. A linked habit tick
 * is removed only when it was gym-created and this was its final workout owner;
 * a manual tick is never claimed and never touched.
 */
export async function deleteCompletedWorkout(id: string): Promise<DeleteWorkoutResult | null> {
  const result = await db.transaction(async (tx) => {
    const [workout] = (
      await tx.execute(sql`SELECT id FROM workouts WHERE id = ${id} AND status = 'completed' FOR UPDATE`)
    ).rows as unknown as Array<{ id: string }>
    if (!workout) return null

    const [link] = (
      await tx.execute(sql`
        SELECT habit_id, habit_log_id, habit_date::text AS habit_date, gym_managed
        FROM gym_habit_log_links
        WHERE workout_id = ${id}
        LIMIT 1
      `)
    ).rows as unknown as HabitLink[]

    let removeHabit = false
    if (link?.gym_managed) {
      // Serialize against another finish joining the same gym-managed tick.
      await tx.execute(sql`SELECT id FROM habit_log WHERE id = ${link.habit_log_id} FOR UPDATE`)
      const [other] = (
        await tx.execute(sql`
          SELECT count(*)::int AS count
          FROM gym_habit_log_links
          WHERE habit_log_id = ${link.habit_log_id}
            AND workout_id <> ${id}
            AND gym_managed = true
        `)
      ).rows as unknown as Array<{ count: number }>
      removeHabit = (other?.count ?? 0) === 0
    }

    await tx.execute(sql`DELETE FROM workouts WHERE id = ${id}`)
    if (removeHabit && link) {
      await tx.execute(sql`DELETE FROM habit_log WHERE id = ${link.habit_log_id}`)
    }
    return { link: link ?? null, removeHabit }
  })

  if (!result) return null

  // Recompute streak/routine state and delete the retained habit fact after the
  // atomic DB mutation. This helper never issues another DELETE: a second
  // deletion here could erase a completion re-created after the commit.
  if (result.removeHabit && result.link) {
    try {
      await reconcileHabitAfterLogMutation({
        habit_id: result.link.habit_id,
        date: result.link.habit_date,
      })
    } catch (err) {
      console.warn('[gym/history-delete] habit recompute failed:', err instanceof Error ? err.message : err)
    }
  }

  const documentId = workoutRetainDocumentId(id)
  dropQueuedRetain(documentId)
  void deleteDocument('health', documentId).catch(() => {})
  invalidateCoachContext()
  return { deleted: true, habitCompletionRemoved: result.removeHabit }
}
