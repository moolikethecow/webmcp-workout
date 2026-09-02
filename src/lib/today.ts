/**
 * App-timezone-aware "today" helpers — the single source of truth for
 * time-bucket math.
 *
 * `new Date().toISOString()` is UTC: an 8pm ET log lands on "tomorrow" and the
 * next morning's screens read as zero. Every day boundary in the app goes
 * through here instead.
 *
 * The zone comes from the `APP_TIMEZONE` environment variable (default `UTC`).
 */
import { sql, type SQL } from 'drizzle-orm'

const APP_TZ = process.env.APP_TIMEZONE ?? 'UTC'

/** The app's IANA timezone. */
export async function getAppTimezone(): Promise<string> {
  return APP_TZ
}

/** YYYY-MM-DD for `ref` in `tz`. */
export function todayInZone(tz: string, ref: Date = new Date()): string {
  return ref.toLocaleDateString('en-CA', { timeZone: tz })
}

/** YYYY-MM-DD for `daysOffset` days from `ref` in `tz`. */
export function dateOffsetInZone(tz: string, daysOffset: number, ref: Date = new Date()): string {
  const d = new Date(ref.getTime() + daysOffset * 86_400_000)
  return d.toLocaleDateString('en-CA', { timeZone: tz })
}

/**
 * SQL fragment that converts a tz-aware timestamp column into the user-local
 * date, so logs bucket into "user days" in the DB.
 *   `WHERE ${dateInZoneSql(sql`occurred_at`, tz)} = ${todayInZone(tz)}`
 */
export function dateInZoneSql(column: SQL | string, tz: string): SQL {
  const col = typeof column === 'string' ? sql.raw(column) : column
  return sql`DATE(${col} AT TIME ZONE ${tz})`
}

/** Start of `dateStr` (YYYY-MM-DD) in `tz` as a UTC instant, in SQL. */
export function startOfDateSql(dateStr: string, tz: string): SQL {
  return sql`((${dateStr}::date AT TIME ZONE ${tz})::timestamptz)`
}
