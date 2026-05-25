// Cron table helpers. Orchestrator polls `listDueCrons()` each tick;
// each due row gets its `payload` enqueued into its target queue,
// then `markCronFired()` updates `lastRunAt` and recomputes
// `nextRunAt` (or deletes if one-shot).
//
// Recurrence formats supported:
//   '@every <n><unit>'        n>0 integer; unit s|m|h|d
//   '@daily HH:MM'            owner-tz local
//   '@weekly DOW HH:MM'       owner-tz local; DOW = mon..sun
//
// No general cron expression parser — every existing setInterval in
// the bot maps to one of the three forms above. Adding cron parsing
// is straightforward later if we need it.

import { and, asc, eq, lte } from 'drizzle-orm'
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { logger } from '../logger.js'
import { crons } from '../db/schema.js'

export type CronTarget = 'inbound' | 'async' | 'outbound' | 'memory_writes'

export type EnqueueCronInput = {
  name: string
  enqueueInto: CronTarget
  payload: unknown               // serialized to JSON on insert
  recurrence: string | null      // null = one-shot
  // For one-shots / first run of recurrings, when to fire (unix seconds).
  // If omitted, computed from recurrence (must be set for one-shots).
  firstRunAt?: number
  enabled?: boolean              // default true
}

export type CronRow = typeof crons.$inferSelect

// Idempotent for named recurring crons: re-inserting the same name
// updates the recurrence/payload but leaves nextRunAt alone (so we
// don't reset the firing schedule on every boot).
export function enqueueCron(input: EnqueueCronInput): CronRow {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const enabled = (input.enabled ?? true) ? 1 : 0

  if (input.recurrence) {
    const existing = db
      .select()
      .from(crons)
      .where(eq(crons.name, input.name))
      .get()
    if (existing) {
      const updated = db
        .update(crons)
        .set({
          enqueueInto: input.enqueueInto,
          payload:     JSON.stringify(input.payload),
          recurrence:  input.recurrence,
          enabled,
        })
        .where(eq(crons.name, input.name))
        .returning()
        .get()
      return updated!
    }
  }

  const firstRunAt = input.firstRunAt ?? computeNextRun(input.recurrence, now)
  if (firstRunAt === null) {
    throw new Error(
      `enqueueCron(${input.name}): one-shot requires firstRunAt`,
    )
  }
  return db
    .insert(crons)
    .values({
      name:        input.name,
      enqueueInto: input.enqueueInto,
      payload:     JSON.stringify(input.payload),
      recurrence:  input.recurrence,
      nextRunAt:   firstRunAt,
      lastRunAt:   null,
      enabled,
      createdAt:   now,
    })
    .returning()
    .get()
}

export function listDueCrons(asOf: number = Math.floor(Date.now() / 1000)): CronRow[] {
  const db = getDb()
  return db
    .select()
    .from(crons)
    .where(and(eq(crons.enabled, 1), lte(crons.nextRunAt, asOf)))
    .orderBy(asc(crons.nextRunAt))
    .all()
}

// Called by orchestrator after the cron's payload has been enqueued
// into its target queue. Recurring crons get nextRunAt advanced;
// one-shots get deleted.
export function markCronFired(row: CronRow): void {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  if (row.recurrence === null) {
    db.delete(crons).where(eq(crons.id, row.id)).run()
    return
  }
  const next = computeNextRun(row.recurrence, now)
  if (next === null) {
    logger.error(
      { id: row.id, name: row.name, recurrence: row.recurrence },
      'cron has unparseable recurrence after firing; disabling',
    )
    db.update(crons)
      .set({ enabled: 0, lastRunAt: now })
      .where(eq(crons.id, row.id))
      .run()
    return
  }
  db.update(crons)
    .set({ lastRunAt: now, nextRunAt: next })
    .where(eq(crons.id, row.id))
    .run()
}

export function deleteCron(name: string): boolean {
  const db = getDb()
  const result = db
    .delete(crons)
    .where(eq(crons.name, name))
    .returning({ id: crons.id })
    .all()
  return result.length > 0
}

export function setCronEnabled(name: string, enabled: boolean): boolean {
  const db = getDb()
  const result = db
    .update(crons)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(crons.name, name))
    .returning({ id: crons.id })
    .all()
  return result.length > 0
}

// ──────────────────────────────────────────────────────────────────
// Recurrence parser
// ──────────────────────────────────────────────────────────────────

const EVERY_RE = /^@every\s+(\d+)\s*([smhd])$/
const DAILY_RE = /^@daily\s+(\d{1,2}):(\d{2})$/
const WEEKLY_RE = /^@weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/i

const UNIT_SECONDS: Record<string, number> = {
  s: 1, m: 60, h: 3600, d: 86400,
}

const DOW_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

// Returns the next-run timestamp (unix seconds) for a recurrence, or
// null for an unparseable format.
export function computeNextRun(
  recurrence: string | null,
  nowSec: number,
): number | null {
  if (!recurrence) return null

  const everyMatch = EVERY_RE.exec(recurrence)
  if (everyMatch) {
    const n = parseInt(everyMatch[1]!, 10)
    const unit = everyMatch[2]!
    if (n <= 0) return null
    return nowSec + n * (UNIT_SECONDS[unit] ?? 0)
  }

  const dailyMatch = DAILY_RE.exec(recurrence)
  if (dailyMatch) {
    return nextLocalHourMinute(
      nowSec,
      parseInt(dailyMatch[1]!, 10),
      parseInt(dailyMatch[2]!, 10),
      null,
    )
  }

  const weeklyMatch = WEEKLY_RE.exec(recurrence)
  if (weeklyMatch) {
    const dow = DOW_INDEX[weeklyMatch[1]!.toLowerCase()]!
    return nextLocalHourMinute(
      nowSec,
      parseInt(weeklyMatch[2]!, 10),
      parseInt(weeklyMatch[3]!, 10),
      dow,
    )
  }

  return null
}

// Compute the next unix-seconds at HH:MM in the owner timezone,
// optionally constrained to a day-of-week. Always returns a moment
// strictly in the future (> nowSec).
function nextLocalHourMinute(
  nowSec: number,
  hour: number,
  minute: number,
  dayOfWeek: number | null,
): number {
  const tz = config.owner.timezone
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  })

  // Walk forward in 1-hour steps from now until we land on the right
  // (day, dow) and the candidate moment is in the future. Cheaper than
  // it sounds — at most 7*24 = 168 iterations.
  for (let step = 0; step < 24 * 8; step++) {
    const candidate = new Date((nowSec + step * 3600) * 1000)
    const parts = fmt.formatToParts(candidate)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    const cYear  = parseInt(get('year'), 10)
    const cMonth = parseInt(get('month'), 10) - 1
    const cDay   = parseInt(get('day'), 10)
    const wdName = get('weekday').toLowerCase()
    const cDow   = DOW_INDEX[wdName] ?? -1

    if (dayOfWeek !== null && cDow !== dayOfWeek) continue

    // Build a UTC instant for HH:MM on (cYear,cMonth,cDay) in the tz.
    // Easier path: format candidate at hour/minute and re-parse via
    // the timezone-offset trick.
    const candidateLocal = makeDateInTz(cYear, cMonth, cDay, hour, minute, tz)
    if (candidateLocal > nowSec) return candidateLocal
  }
  // Fallback (shouldn't be reachable): an hour from now.
  return nowSec + 3600
}

// Build a unix-seconds for a given Y/M/D HH:MM in a named timezone.
// Done by guess-and-correct: assume the input is UTC, see how the tz
// renders that instant, take the delta, apply it.
function makeDateInTz(
  year: number, month: number, day: number,
  hour: number, minute: number,
  tz: string,
): number {
  const guessUtcMs = Date.UTC(year, month, day, hour, minute, 0)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(guessUtcMs))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
  const renderedUtcMs = Date.UTC(
    parseInt(get('year'), 10),
    parseInt(get('month'), 10) - 1,
    parseInt(get('day'), 10),
    parseInt(get('hour'), 10),
    parseInt(get('minute'), 10),
    parseInt(get('second'), 10),
  )
  const offsetMs = guessUtcMs - renderedUtcMs
  return Math.floor((guessUtcMs + offsetMs) / 1000)
}
