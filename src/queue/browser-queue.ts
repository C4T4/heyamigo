// Browser tasks queue helpers. Producers call enqueueBrowserJob;
// the browser worker pool drains via claimNextBrowserTask. Same
// primitives as inbound/outbound — claim is atomic, retry uses
// per-task backoff, claimed_by safety check on completion.
//
// No per-address serialization: multiple browser tasks for the same
// originating chat CAN run concurrently (each opens its own tab on
// the shared Chrome). Reply order isn't a concern because each browser
// task ends with an outbound row, and the sender worker serializes
// per-address there.

import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { browserTasks } from '../db/schema.js'
import { logger } from '../logger.js'

export type BrowserTaskRow = typeof browserTasks.$inferSelect

export type EnqueueBrowserJobInput = {
  address: string
  actorPersonId?: string | null
  description: string
  originatingMessage: string
  senderNumber: string
  senderName?: string | null
  allowedTools?: string[] | 'all'
}

export function enqueueBrowserJob(input: EnqueueBrowserJobInput): BrowserTaskRow {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const row = db
    .insert(browserTasks)
    .values({
      address:            input.address,
      actorPersonId:      input.actorPersonId ?? null,
      description:        input.description,
      originatingMessage: input.originatingMessage,
      senderNumber:       input.senderNumber,
      senderName:         input.senderName ?? null,
      allowedTools:       input.allowedTools
        ? JSON.stringify(input.allowedTools)
        : null,
      status:             'pending',
      attempts:           0,
      nextAttemptAt:      null,
      lastError:          null,
      claimedBy:          null,
      claimedAt:          null,
      createdAt:          now,
      updatedAt:          now,
    })
    .returning()
    .get()
  logger.info(
    {
      id: row.id,
      address: row.address,
      senderNumber: row.senderNumber,
      chars: row.description.length,
    },
    'browser job added to queue',
  )
  return row
}

export function claimNextBrowserTask(workerId: string): BrowserTaskRow | null {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const claimed = db.transaction((tx) => {
    const target = tx
      .select({ id: browserTasks.id })
      .from(browserTasks)
      .where(
        and(
          eq(browserTasks.status, 'pending'),
          or(
            isNull(browserTasks.nextAttemptAt),
            lte(browserTasks.nextAttemptAt, now),
          ),
        ),
      )
      .orderBy(asc(browserTasks.id))
      .limit(1)
      .get()
    if (!target) return null
    const claimed = tx
      .update(browserTasks)
      .set({
        status:    'claimed',
        claimedBy: workerId,
        claimedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(browserTasks.id, target.id),
          eq(browserTasks.status, 'pending'),
        ),
      )
      .returning()
      .get()
    return claimed ?? null
  })
  if (claimed) {
    logger.info(
      {
        id: claimed.id,
        address: claimed.address,
        workerId,
        attempts: claimed.attempts,
      },
      'browser job claimed from queue',
    )
  }
  return claimed
}

export function markBrowserTaskDone(id: number, workerId: string): boolean {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const result = db
    .update(browserTasks)
    .set({ status: 'done', updatedAt: now })
    .where(
      and(
        eq(browserTasks.id, id),
        eq(browserTasks.status, 'claimed'),
        eq(browserTasks.claimedBy, workerId),
      ),
    )
    .returning({ id: browserTasks.id })
    .all()
  return result.length > 0
}

// Browser tasks are expensive (multi-minute Playwright sessions) so
// retries are sparse: 30s, 5min, give up (DLQ after 2 attempts past
// the first). Most browser failures are deterministic (login wall,
// bot detection) and won't benefit from rapid retries.
const BACKOFF_SECONDS = [30, 300]
const MAX_ATTEMPTS = BACKOFF_SECONDS.length

export function markBrowserTaskRetryOrDlq(
  id: number,
  workerId: string,
  errorMessage: string,
): { retried: boolean; deadLettered: boolean } {
  const db = getDb()
  return db.transaction((tx) => {
    const row = tx.select().from(browserTasks).where(eq(browserTasks.id, id)).get()
    if (!row || row.status !== 'claimed' || row.claimedBy !== workerId) {
      return { retried: false, deadLettered: false }
    }
    const now = Math.floor(Date.now() / 1000)
    const nextAttempts = row.attempts + 1
    if (nextAttempts > MAX_ATTEMPTS) {
      tx.update(browserTasks)
        .set({
          status: 'dlq',
          attempts: nextAttempts,
          lastError: errorMessage,
          claimedBy: null,
          claimedAt: null,
          updatedAt: now,
        })
        .where(eq(browserTasks.id, id))
        .run()
      return { retried: false, deadLettered: true }
    }
    const backoff = BACKOFF_SECONDS[Math.min(row.attempts, BACKOFF_SECONDS.length - 1)]!
    tx.update(browserTasks)
      .set({
        status: 'pending',
        attempts: nextAttempts,
        nextAttemptAt: now + backoff,
        lastError: errorMessage,
        claimedBy: null,
        claimedAt: null,
        updatedAt: now,
      })
      .where(eq(browserTasks.id, id))
      .run()
    return { retried: true, deadLettered: false }
  })
}

// MUST exceed TIMEOUT_MS.async (60min as of the /goal-friendly bump)
// so live browser workers don't get reclaimed mid-spawn. 5min headroom
// past the spawn cap so the orchestrator only catches truly dead
// workers. Browser tasks legitimately run 30-45min for deep scrapes.
const CLAIM_TTL_SECONDS = 65 * 60

export function reclaimStuckBrowserTasks(): number {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - CLAIM_TTL_SECONDS
  const result = db
    .update(browserTasks)
    .set({
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
      updatedAt: sql`${browserTasks.updatedAt}`,
    })
    .where(and(eq(browserTasks.status, 'claimed'), lte(browserTasks.claimedAt, cutoff)))
    .returning({ id: browserTasks.id })
    .all()
  return result.length
}
