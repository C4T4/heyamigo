// Sender worker. Drains the outbound queue and pushes each row to the
// matching channel adapter. One per process (no concurrency) so
// per-address ordering is preserved naturally and rate-limiting lives
// in one place.

import { hostname } from 'os'
import { resolve } from 'path'
import { eq } from 'drizzle-orm'
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { parseAddress } from '../db/address.js'
import { workers } from '../db/schema.js'
import {
  getChannelAdapter,
  PermanentChannelError,
  TransientChannelError,
  type OutboundMessage,
} from '../channels/index.js'
import { logger } from '../logger.js'
import {
  claimNextOutbound,
  markOutboundDone,
  markOutboundFailed,
  markOutboundRetryOrDlq,
  type OutboundRow,
} from './outbound.js'
import { afterSend } from './outbound-postsend.js'

const HEARTBEAT_INTERVAL_MS = 5_000
const IDLE_POLL_INTERVAL_MS = 500   // when queue empty
const BUSY_POLL_INTERVAL_MS = 50    // immediately fetch next after a successful send

let workerId: string | null = null
let stopping = false
let heartbeatTimer: NodeJS.Timeout | null = null

function newWorkerId(): string {
  return `${hostname()}-${process.pid}-sender-0`
}

function registerWorker(id: string): void {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.insert(workers)
    .values({
      id,
      kind:       'sender',
      status:     'idle',
      currentJob: null,
      lastSeen:   now,
      startedAt:  now,
    })
    .onConflictDoUpdate({
      target: workers.id,
      set: { status: 'idle', currentJob: null, lastSeen: now, startedAt: now },
    })
    .run()
}

function setWorkerStatus(
  id: string,
  status: 'idle' | 'busy' | 'draining' | 'dead',
  currentJob: string | null = null,
): void {
  const db = getDb()
  db.update(workers)
    .set({
      status,
      currentJob,
      lastSeen: Math.floor(Date.now() / 1000),
    })
    .where(eq(workers.id, id))
    .run()
}

function heartbeat(id: string): void {
  const db = getDb()
  db.update(workers)
    .set({ lastSeen: Math.floor(Date.now() / 1000) })
    .where(eq(workers.id, id))
    .run()
}

// Translate an outbound row into the channel-agnostic message shape.
// Media paths are stored relative to the project root in the row;
// resolved to absolute here so the adapter can readFileSync directly.
function rowToMessage(row: OutboundRow): OutboundMessage {
  return {
    kind:       row.kind as OutboundMessage['kind'],
    text:       row.text ?? undefined,
    mediaPath:  row.mediaPath ? resolve(process.cwd(), row.mediaPath) : undefined,
    mediaMime:  row.mediaMime ?? undefined,
    quoteMsgId: row.quoteMsgId ?? undefined,
  }
}

// Enforce media-size cap. mediaBytes is stored on the row by the
// producer; if missing, we trust the channel to enforce its own limit.
function tooLarge(row: OutboundRow): string | null {
  const cap = config.reply.maxOutboundMediaBytes ?? null
  if (cap === null) return null
  if (row.mediaBytes !== null && row.mediaBytes > cap) {
    return `media too large: ${row.mediaBytes} > ${cap} bytes`
  }
  return null
}

async function processOne(id: string, row: OutboundRow): Promise<void> {
  setWorkerStatus(id, 'busy', `outbound:${row.id}`)

  // Size cap → permanent fail; no point retrying same payload.
  const sizeError = tooLarge(row)
  if (sizeError) {
    markOutboundFailed(row.id, id, sizeError)
    logger.warn({ id: row.id, address: row.address }, sizeError)
    setWorkerStatus(id, 'idle')
    return
  }

  let address
  try {
    address = parseAddress(row.address)
  } catch (err) {
    markOutboundFailed(row.id, id, `bad address: ${row.address}`)
    logger.warn({ id: row.id, err }, 'outbound row has unparseable address')
    setWorkerStatus(id, 'idle')
    return
  }

  // system:* addresses are bot-internal; not real channels. Drop them
  // with a friendly log so future cron-emitted system messages don't
  // accidentally try to "send" anywhere.
  if (address.channel === 'system') {
    markOutboundFailed(row.id, id, 'system addresses are not sendable')
    logger.warn({ id: row.id, address: row.address }, 'system address routed to sender')
    setWorkerStatus(id, 'idle')
    return
  }

  let adapter
  try {
    adapter = getChannelAdapter(address.channel)
  } catch (err) {
    markOutboundFailed(row.id, id, (err as Error).message)
    logger.error({ id: row.id, channel: address.channel }, 'no adapter for channel')
    setWorkerStatus(id, 'idle')
    return
  }

  try {
    const result = await adapter.send(address.externalId, rowToMessage(row))
    const ok = markOutboundDone(row.id, id)
    if (!ok) {
      // Lost the claim — orchestrator reclaimed it as stuck, or
      // status changed under us. The send already happened though
      // (channel returned a msg_id), so we just log and move on. The
      // reclaimed copy may re-send → that's why idempotency_key
      // matters at the producer side.
      logger.warn(
        { id: row.id, msgId: result.msgId },
        'outbound sent but markDone failed (claim lost?)',
      )
    } else {
      await afterSend(row, result.msgId).catch((err) => {
        logger.error({ err, id: row.id }, 'afterSend hook failed')
      })
      logger.info(
        { id: row.id, address: row.address, kind: row.kind, msgId: result.msgId },
        'outbound sent',
      )
    }
  } catch (err) {
    if (err instanceof PermanentChannelError) {
      markOutboundFailed(row.id, id, err.message)
      logger.error({ id: row.id, err: err.message }, 'outbound permanent failure')
    } else if (err instanceof TransientChannelError) {
      const result = markOutboundRetryOrDlq(row.id, id, err.message)
      if (result.deadLettered) {
        logger.error({ id: row.id }, 'outbound dead-lettered after max attempts')
      } else if (result.retried) {
        logger.warn({ id: row.id, err: err.message }, 'outbound transient fail, will retry')
      }
    } else {
      // Unexpected throw — treat as transient (safer to retry than to
      // give up on something we don't understand).
      const result = markOutboundRetryOrDlq(
        row.id,
        id,
        `unexpected error: ${(err as Error).message}`,
      )
      logger.error(
        { id: row.id, err, retried: result.retried, dlq: result.deadLettered },
        'outbound unexpected error',
      )
    }
  } finally {
    setWorkerStatus(id, 'idle')
  }
}

async function loop(id: string): Promise<void> {
  while (!stopping) {
    let processed = false
    try {
      const row = claimNextOutbound(id)
      if (row) {
        await processOne(id, row)
        processed = true
      }
    } catch (err) {
      logger.error({ err }, 'sender worker loop error')
    }
    const delay = processed ? BUSY_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS
    await new Promise<void>((res) => setTimeout(res, delay))
  }
  setWorkerStatus(id, 'dead')
}

export function startSenderWorker(): void {
  if (workerId) {
    logger.warn('sender worker already started; ignoring')
    return
  }
  workerId = newWorkerId()
  registerWorker(workerId)
  heartbeatTimer = setInterval(
    () => workerId && heartbeat(workerId),
    HEARTBEAT_INTERVAL_MS,
  )
  void loop(workerId).catch((err) =>
    logger.fatal({ err }, 'sender worker loop crashed'),
  )
  logger.info({ workerId }, 'sender worker started')
}

export function stopSenderWorker(): void {
  stopping = true
  if (heartbeatTimer) clearInterval(heartbeatTimer)
}
