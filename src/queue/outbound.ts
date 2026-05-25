// Outbound queue helpers. Producers (chat workers, async workers,
// crons, external triggers) call enqueueOutbound. The sender worker
// drains via claimNextOutbound + markOutbound{Done,Failed,Retry}.
//
// All mutations preserve the claimed_by safety check on completion:
// only the holder of a claim can mark it done/failed. A slow worker
// that comes back after TTL-reclaim will harmlessly no-op.

import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { outbound } from '../db/schema.js'

export type OutboundKind = 'text' | 'image' | 'video' | 'audio' | 'document'
export type OutboundStatus = 'pending' | 'sending' | 'done' | 'failed' | 'dlq'

export type EnqueueOutboundInput = {
  address: string                    // 'wa:dm:...' | 'wa:group:...' etc.
  kind: OutboundKind
  text?: string                      // body or caption
  mediaPath?: string                 // relative to storage/
  mediaMime?: string
  mediaBytes?: number
  quoteMsgId?: string
  idempotencyKey?: string            // dedupes; set to 'from-inbound-<id>' etc. when known
}

export type OutboundRow = typeof outbound.$inferSelect

export type EnqueueResult =
  | { inserted: true; row: OutboundRow }
  | { inserted: false; row: OutboundRow }   // existing row, looked up by idempotency_key

// Insert a row, or no-op when the same idempotency_key already exists.
// Returns the row either way so callers can log/observe.
export function enqueueOutbound(input: EnqueueOutboundInput): EnqueueResult {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  // Idempotency: look up first. SQLite has no INSERT ... ON CONFLICT
  // returning the previous row, so we serve it in two queries inside
  // a transaction.
  if (input.idempotencyKey) {
    const found = db
      .select()
      .from(outbound)
      .where(eq(outbound.idempotencyKey, input.idempotencyKey))
      .get()
    if (found) return { inserted: false, row: found }
  }

  const inserted = db
    .insert(outbound)
    .values({
      address:        input.address,
      kind:           input.kind,
      text:           input.text ?? null,
      mediaPath:      input.mediaPath ?? null,
      mediaMime:      input.mediaMime ?? null,
      mediaBytes:     input.mediaBytes ?? null,
      quoteMsgId:     input.quoteMsgId ?? null,
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
  return { inserted: true, row: inserted }
}

// Atomic claim. Returns the row or null if nothing's ready.
// Reserves rows whose nextAttemptAt is null (ready immediately) OR in
// the past (backoff elapsed). Single-statement so two workers can't
// claim the same row.
export function claimNextOutbound(workerId: string): OutboundRow | null {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  // SQLite supports UPDATE ... RETURNING since 3.35.
  return db.transaction((tx) => {
    const target = tx
      .select({ id: outbound.id })
      .from(outbound)
      .where(
        and(
          eq(outbound.status, 'pending'),
          or(isNull(outbound.nextAttemptAt), lte(outbound.nextAttemptAt, now)),
        ),
      )
      .orderBy(asc(outbound.id))
      .limit(1)
      .get()
    if (!target) return null

    const claimed = tx
      .update(outbound)
      .set({
        status:    'sending',
        claimedBy: workerId,
        claimedAt: now,
        updatedAt: now,
      })
      .where(and(eq(outbound.id, target.id), eq(outbound.status, 'pending')))
      .returning()
      .get()
    return claimed ?? null
  })
}

// Mark done — succeeds only when the row is still owned by the caller.
// Returns whether the update actually applied.
export function markOutboundDone(id: number, workerId: string): boolean {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const result = db
    .update(outbound)
    .set({ status: 'done', updatedAt: now })
    .where(
      and(
        eq(outbound.id, id),
        eq(outbound.status, 'sending'),
        eq(outbound.claimedBy, workerId),
      ),
    )
    .returning({ id: outbound.id })
    .all()
  return result.length > 0
}

// Backoff schedule: 1s, 5s, 30s, 2min, give up.
const BACKOFF_SECONDS = [1, 5, 30, 120]
const MAX_ATTEMPTS = BACKOFF_SECONDS.length

// Transient failure: return to pending with next_attempt_at set, or
// move to DLQ if attempts exceeded. Caller-owned check applies.
export function markOutboundRetryOrDlq(
  id: number,
  workerId: string,
  errorMessage: string,
): { retried: boolean; deadLettered: boolean } {
  const db = getDb()
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(outbound)
      .where(eq(outbound.id, id))
      .get()
    if (!row || row.status !== 'sending' || row.claimedBy !== workerId) {
      return { retried: false, deadLettered: false }
    }
    const now = Math.floor(Date.now() / 1000)
    const nextAttempts = row.attempts + 1
    if (nextAttempts > MAX_ATTEMPTS) {
      tx.update(outbound)
        .set({
          status:    'dlq',
          attempts:  nextAttempts,
          lastError: errorMessage,
          claimedBy: null,
          claimedAt: null,
          updatedAt: now,
        })
        .where(eq(outbound.id, id))
        .run()
      return { retried: false, deadLettered: true }
    }
    const backoff = BACKOFF_SECONDS[Math.min(row.attempts, BACKOFF_SECONDS.length - 1)]!
    tx.update(outbound)
      .set({
        status:        'pending',
        attempts:      nextAttempts,
        nextAttemptAt: now + backoff,
        lastError:     errorMessage,
        claimedBy:     null,
        claimedAt:     null,
        updatedAt:     now,
      })
      .where(eq(outbound.id, id))
      .run()
    return { retried: true, deadLettered: false }
  })
}

// Permanent failure (no retry). Used when the error is unrecoverable
// — e.g. media file missing, malformed address.
export function markOutboundFailed(
  id: number,
  workerId: string,
  errorMessage: string,
): boolean {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const result = db
    .update(outbound)
    .set({
      status:    'failed',
      lastError: errorMessage,
      claimedBy: null,
      claimedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(outbound.id, id),
        eq(outbound.status, 'sending'),
        eq(outbound.claimedBy, workerId),
      ),
    )
    .returning({ id: outbound.id })
    .all()
  return result.length > 0
}

// Orchestrator helper: reclaim rows whose worker died mid-send.
// "Stuck in sending past TTL" → return to pending so another worker
// can pick them up. attempts NOT incremented (the worker may have
// died before even talking to the channel).
const CLAIM_TTL_SECONDS = 60

export function reclaimStuckOutbound(): number {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - CLAIM_TTL_SECONDS
  const result = db
    .update(outbound)
    .set({
      status:    'pending',
      claimedBy: null,
      claimedAt: null,
      // intentionally leaving updatedAt as-is so observability can spot reclaims
      updatedAt: sql`${outbound.updatedAt}`,
    })
    .where(and(eq(outbound.status, 'sending'), lte(outbound.claimedAt, cutoff)))
    .returning({ id: outbound.id })
    .all()
  return result.length
}
