// Inbound queue helpers. Gateway (gateway/incoming.ts) calls
// enqueueInbound; chat workers (queue/chat-worker.ts) drain via
// claimNextInbound. Per-address serialization preserves reply order
// within a chat while different chats run in parallel.
//
// Same primitives as outbound (claim/done/retry/dlq) with the added
// `address NOT IN (claimed)` filter in the claim query.

import { and, asc, eq, isNull, lte, notInArray, or, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { inbound } from '../db/schema.js'

export type InboundStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'dlq'

export type EnqueueInboundInput = {
  address: string                       // chat-level address
  actorAddress?: string | null          // sender within chat (DM = same as address)
  personId?: string | null
  actorPersonId?: string | null
  externalMsgId?: string | null         // channel-native id for idempotency
  text: string                          // body or media tag
  mediaPath?: string | null
  mediaMime?: string | null
  mediaBytes?: number | null
  pushName?: string | null
  triggerReason?: string | null         // 'alias'|'mention'|'reply'|'owner'|...
  receivedAt?: number                   // unix sec; defaults to now
  // Producer-built worker payload (JSON-serialized by the helper).
  // Chat worker deserializes at claim time.
  payload?: unknown
}

export type InboundRow = typeof inbound.$inferSelect

export type EnqueueInboundResult =
  | { inserted: true; row: InboundRow }
  | { inserted: false; row: InboundRow }

// Idempotent on external_msg_id when set. Same channel message
// arriving twice (Baileys replay, network retransmit) returns the
// existing row instead of duplicating.
export function enqueueInbound(input: EnqueueInboundInput): EnqueueInboundResult {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  if (input.externalMsgId) {
    const found = db
      .select()
      .from(inbound)
      .where(eq(inbound.externalMsgId, input.externalMsgId))
      .get()
    if (found) return { inserted: false, row: found }
  }

  const row = db
    .insert(inbound)
    .values({
      address:        input.address,
      actorAddress:   input.actorAddress ?? null,
      personId:       input.personId ?? null,
      actorPersonId:  input.actorPersonId ?? null,
      externalMsgId:  input.externalMsgId ?? null,
      text:           input.text,
      mediaPath:      input.mediaPath ?? null,
      mediaMime:      input.mediaMime ?? null,
      mediaBytes:     input.mediaBytes ?? null,
      pushName:       input.pushName ?? null,
      triggerReason:  input.triggerReason ?? null,
      payload:        input.payload === undefined ? null : JSON.stringify(input.payload),
      status:         'pending',
      attempts:       0,
      nextAttemptAt:  null,
      lastError:      null,
      claimedBy:      null,
      claimedAt:      null,
      receivedAt:     input.receivedAt ?? now,
      createdAt:      now,
      updatedAt:      now,
    })
    .returning()
    .get()
  return { inserted: true, row }
}

// Atomic claim with per-address serialization. Skips any pending row
// whose address already has another row in `claimed` state →
// preserves reply order per chat while letting different chats run
// in parallel.
export function claimNextInbound(workerId: string): InboundRow | null {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  return db.transaction((tx) => {
    // Subquery: addresses currently claimed (= one in-flight per chat).
    const busyAddrs = tx
      .select({ address: inbound.address })
      .from(inbound)
      .where(eq(inbound.status, 'claimed'))
      .all()
      .map((r) => r.address)

    const conds = [
      eq(inbound.status, 'pending'),
      or(isNull(inbound.nextAttemptAt), lte(inbound.nextAttemptAt, now)),
    ]
    if (busyAddrs.length > 0) {
      conds.push(notInArray(inbound.address, busyAddrs))
    }

    const target = tx
      .select({ id: inbound.id })
      .from(inbound)
      .where(and(...conds))
      .orderBy(asc(inbound.id))
      .limit(1)
      .get()
    if (!target) return null

    const claimed = tx
      .update(inbound)
      .set({
        status:    'claimed',
        claimedBy: workerId,
        claimedAt: now,
        updatedAt: now,
      })
      .where(and(eq(inbound.id, target.id), eq(inbound.status, 'pending')))
      .returning()
      .get()
    return claimed ?? null
  })
}

export function markInboundDone(id: number, workerId: string): boolean {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const result = db
    .update(inbound)
    .set({ status: 'done', updatedAt: now })
    .where(
      and(
        eq(inbound.id, id),
        eq(inbound.status, 'claimed'),
        eq(inbound.claimedBy, workerId),
      ),
    )
    .returning({ id: inbound.id })
    .all()
  return result.length > 0
}

// Backoff: 5s, 30s, 2min, 5min, give up. Bigger gaps than outbound
// because chat replies are expensive (AI call); a faster retry loop
// would just burn tokens on transient errors.
const BACKOFF_SECONDS = [5, 30, 120, 300]
const MAX_ATTEMPTS = BACKOFF_SECONDS.length

export function markInboundRetryOrDlq(
  id: number,
  workerId: string,
  errorMessage: string,
): { retried: boolean; deadLettered: boolean } {
  const db = getDb()
  return db.transaction((tx) => {
    const row = tx.select().from(inbound).where(eq(inbound.id, id)).get()
    if (!row || row.status !== 'claimed' || row.claimedBy !== workerId) {
      return { retried: false, deadLettered: false }
    }
    const now = Math.floor(Date.now() / 1000)
    const nextAttempts = row.attempts + 1
    if (nextAttempts > MAX_ATTEMPTS) {
      tx.update(inbound)
        .set({
          status: 'dlq',
          attempts: nextAttempts,
          lastError: errorMessage,
          claimedBy: null,
          claimedAt: null,
          updatedAt: now,
        })
        .where(eq(inbound.id, id))
        .run()
      return { retried: false, deadLettered: true }
    }
    const backoff = BACKOFF_SECONDS[Math.min(row.attempts, BACKOFF_SECONDS.length - 1)]!
    tx.update(inbound)
      .set({
        status: 'pending',
        attempts: nextAttempts,
        nextAttemptAt: now + backoff,
        lastError: errorMessage,
        claimedBy: null,
        claimedAt: null,
        updatedAt: now,
      })
      .where(eq(inbound.id, id))
      .run()
    return { retried: true, deadLettered: false }
  })
}

export function markInboundFailed(
  id: number,
  workerId: string,
  errorMessage: string,
): boolean {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const result = db
    .update(inbound)
    .set({
      status: 'failed',
      lastError: errorMessage,
      claimedBy: null,
      claimedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(inbound.id, id),
        eq(inbound.status, 'claimed'),
        eq(inbound.claimedBy, workerId),
      ),
    )
    .returning({ id: inbound.id })
    .all()
  return result.length > 0
}

// Orchestrator helper. Chat workers run longer than sender workers
// (AI calls + memory writes), so the TTL is more generous. 300s
// matches the typical chat-track timeout (5min).
const CLAIM_TTL_SECONDS = 360

export function reclaimStuckInbound(): number {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - CLAIM_TTL_SECONDS
  const result = db
    .update(inbound)
    .set({
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
      updatedAt: sql`${inbound.updatedAt}`,
    })
    .where(and(eq(inbound.status, 'claimed'), lte(inbound.claimedAt, cutoff)))
    .returning({ id: inbound.id })
    .all()
  return result.length
}
