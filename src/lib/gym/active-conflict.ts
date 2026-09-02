const ACTIVE_WORKOUT_SINGLETON_CONSTRAINT = 'uq_workouts_one_active'

interface PostgresErrorLike {
  code?: unknown
  constraint?: unknown
  cause?: unknown
}

/**
 * postgres.js may surface the server error directly or wrapped as `cause`.
 * A missing constraint name is accepted because some adapters preserve only
 * SQLSTATE; a different named unique constraint must not be misreported as an
 * already-running workout.
 */
export function isActiveWorkoutSingletonViolation(error: unknown): boolean {
  let candidate = error
  let sawUnnamedUniqueViolation = false
  const seen = new Set<unknown>()

  while (candidate && typeof candidate === 'object' && !seen.has(candidate)) {
    seen.add(candidate)
    const postgresError = candidate as PostgresErrorLike
    if (postgresError.code === '23505') {
      if (typeof postgresError.constraint === 'string') {
        return postgresError.constraint === ACTIVE_WORKOUT_SINGLETON_CONSTRAINT
      }
      sawUnnamedUniqueViolation = true
    }
    candidate = postgresError.cause
  }

  return sawUnnamedUniqueViolation
}
