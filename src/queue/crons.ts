// Cron table helpers. Orchestrator polls `listDueCrons()` each tick;
// each due row gets its `payload` enqueued into its target queue,
// then `markCronFired()` updates `lastRunAt` and recomputes
// `nextRunAt` (or deletes if one-shot).
//
// Recurrence: standard 5-field POSIX cron + croner's @every / @daily
// shorthand. Croner handles parsing, timezone, DST.
//
//   '0 9 * * *'      daily at 9am sender-tz
//   '0 9 * * 1-5'    weekdays at 9am
//   '0 9 1 * *'      first of every month at 9am
//   '0 9 25 12 *'    every Dec 25 at 9am
//   '*/30 * * * *'   every 30 minutes
//   '0 9 * * 1#1'    first Monday of every month at 9am
//   '@every 5m'      every 5 minutes (croner extension)
//   '@daily'         croner alias for '0 0 * * *' (use full cron for sub-hour times)
//
// Day-of-week: 0-6 (Sun-Sat) or names MON..SUN. Both work.

import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { Cron } from 'croner'
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { logger } from '../logger.js'
import { crons } from '../db/schema.js'

export type CronTarget =
  | 'inbound'
  | 'async'
  | 'browser'
  | 'outbound'
  | 'memory_writes'
  | 'internal'              // in-process handler registry (cron-handlers.ts)

export type EnqueueCronInput = {
  name: string
  enqueueInto: CronTarget
  payload: unknown               // serialized to JSON on insert
  recurrence: string | null      // null = one-shot
  // For one-shots / first run of recurrings, when to fire (unix seconds).
  // If omitted, computed from recurrence (must be set for one-shots).
  firstRunAt?: number
  enabled?: boolean              // default true
  // IANA timezone for resolving @daily HH:MM / @weekly DOW HH:MM.
  // Defaults to config.owner.timezone if omitted. Per-user crons
  // should pass the sender's tz so "9am" means user's 9am, not the
  // server's.
  timezone?: string
}

export type CronRow = typeof crons.$inferSelect

// Idempotent for named recurring crons: re-inserting the same name
// updates the recurrence/payload but leaves nextRunAt alone (so we
// don't reset the firing schedule on every boot).
export function enqueueCron(input: EnqueueCronInput): CronRow {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const enabled = (input.enabled ?? true) ? 1 : 0
  const tz = input.timezone ?? config.owner.timezone

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
          timezone:    tz,
          enabled,
        })
        .where(eq(crons.name, input.name))
        .returning()
        .get()
      return updated!
    }
  }

  const firstRunAt = input.firstRunAt ?? computeNextRun(input.recurrence, now, tz)
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
      timezone:    tz,
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
// one-shots get deleted. Always bumps fire_count for visibility.
export function markCronFired(row: CronRow): void {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  if (row.recurrence === null) {
    // One-shot. Bump fire_count first (in case anything else queries
    // before delete), then delete.
    db.update(crons)
      .set({ fireCount: sql`${crons.fireCount} + 1` })
      .where(eq(crons.id, row.id))
      .run()
    db.delete(crons).where(eq(crons.id, row.id)).run()
    return
  }
  const tz = row.timezone ?? config.owner.timezone
  const next = computeNextRun(row.recurrence, now, tz)
  if (next === null) {
    logger.error(
      { id: row.id, name: row.name, recurrence: row.recurrence },
      'cron has unparseable recurrence after firing; disabling',
    )
    db.update(crons)
      .set({
        enabled: 0,
        lastRunAt: now,
        fireCount: sql`${crons.fireCount} + 1`,
      })
      .where(eq(crons.id, row.id))
      .run()
    return
  }
  db.update(crons)
    .set({
      lastRunAt: now,
      nextRunAt: next,
      fireCount: sql`${crons.fireCount} + 1`,
    })
    .where(eq(crons.id, row.id))
    .run()
}

// Attribution: called by the chat / async / browser workers after an
// AI-backed firing completes. Increments running totals on the cron
// row so /crons can show cumulative cost. Safe to call concurrently —
// the SQL `col + ?` form is atomic.
export function addCronUsage(
  id: number,
  inputTokens: number,
  outputTokens: number,
): void {
  if (!id || (inputTokens <= 0 && outputTokens <= 0)) return
  const db = getDb()
  db.update(crons)
    .set({
      totalInputTokens:  sql`${crons.totalInputTokens}  + ${inputTokens}`,
      totalOutputTokens: sql`${crons.totalOutputTokens} + ${outputTokens}`,
    })
    .where(eq(crons.id, id))
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
// Recurrence — hybrid: @every Nu shortcut + croner for the rest
// ──────────────────────────────────────────────────────────────────

// Croner handles cron expressions + @hourly/@daily/@weekly/@monthly/
// @yearly aliases, but does NOT support @every Nu shorthand (custom
// extension some libs ship). We keep our own tiny @every parser so
// users can write "@every 5m" / "@every 30s" / "@every 3h" — useful
// for short intervals where the 5-field cron equivalent is awkward
// (or impossible, for sub-minute intervals).
const EVERY_RE = /^@every\s+(\d+)\s*([smhd])$/i
const UNIT_SEC: Record<string, number> = {
  s: 1, m: 60, h: 3600, d: 86400,
}

// Returns the next-run timestamp (unix seconds), or null when the
// expression doesn't parse.
export function computeNextRun(
  recurrence: string | null,
  nowSec: number,
  tz: string = config.owner.timezone,
): number | null {
  if (!recurrence) return null

  // Fast path: @every Nu shorthand (croner doesn't grok this).
  const everyMatch = EVERY_RE.exec(recurrence.trim())
  if (everyMatch) {
    const n = parseInt(everyMatch[1]!, 10)
    const unit = everyMatch[2]!.toLowerCase()
    const mult = UNIT_SEC[unit]
    if (!mult || n <= 0) return null
    return nowSec + n * mult
  }

  // Everything else → croner. Handles 5-field POSIX cron,
  // @hourly/@daily/@weekly/@monthly/@yearly aliases, DST math.
  try {
    const c = new Cron(recurrence, { timezone: tz })
    const nextDate = c.nextRun(new Date(nowSec * 1000))
    if (!nextDate) return null
    return Math.floor(nextDate.getTime() / 1000)
  } catch (err) {
    logger.warn(
      { recurrence, err: (err as Error).message },
      'computeNextRun: unparseable recurrence',
    )
    return null
  }
}
