// memory_writes queue helpers. Producers (chat workers, async
// workers, journal observer, etc.) call enqueueMemoryWrite. The
// single memory worker drains. Op is a discriminator; payload is
// op-specific JSON.

import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { memoryWrites } from '../db/schema.js'

export type MemoryOp =
  | 'append_journal'
  | 'create_journal'
  | 'trigger_digest'
  | 'mark_compressed_dirty'

export type MemoryWriteRow = typeof memoryWrites.$inferSelect

export type EnqueueMemoryWriteInput<P = unknown> = {
  op: MemoryOp
  payload: P
  idempotencyKey?: string
}

export function enqueueMemoryWrite(
  input: EnqueueMemoryWriteInput,
): { inserted: boolean; row: MemoryWriteRow } {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  if (input.idempotencyKey) {
    const found = db
      .select()
      .from(memoryWrites)
      .where(eq(memoryWrites.idempotencyKey, input.idempotencyKey))
      .get()
    if (found) return { inserted: false, row: found }
  }

  const row = db
    .insert(memoryWrites)
    .values({
      op:             input.op,
      payload:        JSON.stringify(input.payload),
      idempotencyKey: input.idempotencyKey ?? null,
      status:         'pending',
      attempts:       0,
      nextAttemptAt:  null,
      lastError:      null,
      claimedBy:      null,
      claimedAt:      null,
      createdAt:      now,
      updatedAt:      now,
    })
    .returning()
    .get()
  return { inserted: true, row }
}

export function claimNextMemoryWrite(workerId: string): MemoryWriteRow | null {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  return db.transaction((tx) => {
    const target = tx
      .select({ id: memoryWrites.id })
      .from(memoryWrites)
      .where(
        and(
          eq(memoryWrites.status, 'pending'),
          or(
            isNull(memoryWrites.nextAttemptAt),
            lte(memoryWrites.nextAttemptAt, now),
          ),
        ),
      )
      .orderBy(asc(memoryWrites.id))
      .limit(1)
      .get()
    if (!target) return null
    const claimed = tx
      .update(memoryWrites)
      .set({
        status:    'claimed',
        claimedBy: workerId,
        claimedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(memoryWrites.id, target.id),
          eq(memoryWrites.status, 'pending'),
        ),
      )
      .returning()
      .get()
    return claimed ?? null
  })
}

export function markMemoryWriteDone(id: number, workerId: string): boolean {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const result = db
    .update(memoryWrites)
    .set({ status: 'done', updatedAt: now })
    .where(
      and(
        eq(memoryWrites.id, id),
        eq(memoryWrites.status, 'claimed'),
        eq(memoryWrites.claimedBy, workerId),
      ),
    )
    .returning({ id: memoryWrites.id })
    .all()
  return result.length > 0
}

// Memory mutations are cheap; if one fails we don't want to bury it
// in long backoffs. Quick retries, fast DLQ.
const BACKOFF_SECONDS = [1, 5, 30]
const MAX_ATTEMPTS = BACKOFF_SECONDS.length

export function markMemoryWriteRetryOrDlq(
  id: number,
  workerId: string,
  errorMessage: string,
): { retried: boolean; deadLettered: boolean } {
  const db = getDb()
  return db.transaction((tx) => {
    const row = tx.select().from(memoryWrites).where(eq(memoryWrites.id, id)).get()
    if (!row || row.status !== 'claimed' || row.claimedBy !== workerId) {
      return { retried: false, deadLettered: false }
    }
    const now = Math.floor(Date.now() / 1000)
    const nextAttempts = row.attempts + 1
    if (nextAttempts > MAX_ATTEMPTS) {
      tx.update(memoryWrites)
        .set({
          status: 'dlq',
          attempts: nextAttempts,
          lastError: errorMessage,
          claimedBy: null,
          claimedAt: null,
          updatedAt: now,
        })
        .where(eq(memoryWrites.id, id))
        .run()
      return { retried: false, deadLettered: true }
    }
    const backoff = BACKOFF_SECONDS[Math.min(row.attempts, BACKOFF_SECONDS.length - 1)]!
    tx.update(memoryWrites)
      .set({
        status: 'pending',
        attempts: nextAttempts,
        nextAttemptAt: now + backoff,
        lastError: errorMessage,
        claimedBy: null,
        claimedAt: null,
        updatedAt: now,
      })
      .where(eq(memoryWrites.id, id))
      .run()
    return { retried: true, deadLettered: false }
  })
}

const CLAIM_TTL_SECONDS = 60
export function reclaimStuckMemoryWrites(): number {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - CLAIM_TTL_SECONDS
  const result = db
    .update(memoryWrites)
    .set({
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
      updatedAt: sql`${memoryWrites.updatedAt}`,
    })
    .where(
      and(
        eq(memoryWrites.status, 'claimed'),
        lte(memoryWrites.claimedAt, cutoff),
      ),
    )
    .returning({ id: memoryWrites.id })
    .all()
  return result.length
}
