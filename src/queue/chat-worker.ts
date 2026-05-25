// Chat worker pool. N workers drain the inbound queue; per-address
// serialization ensures one in-flight job per chat while different
// chats run in parallel (Phase 4's headline feature).
//
// Each worker:
//   1. claimNextInbound (atomic, serialized per address)
//   2. deserialize the producer-built Job payload
//   3. call processJob (existing AI + marker handling, unchanged)
//   4. call handleReply (enqueues outbound rows)
//   5. markInboundDone — or markInboundRetryOrDlq on error
//
// Replaces the in-memory fastq queue (queue/queue.ts). The old
// queue + persistence files stay in place for now in case they're
// still referenced anywhere; clean removal lands after we confirm
// nothing breaks.

import { hostname } from 'os'
import { eq } from 'drizzle-orm'
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { workers } from '../db/schema.js'
import { handleReply } from '../gateway/outgoing.js'
import { logger } from '../logger.js'
import { processJob } from './worker.js'
import {
  claimNextInbound,
  markInboundDone,
  markInboundFailed,
  markInboundRetryOrDlq,
  type InboundRow,
} from './inbound.js'
import type { Job } from './types.js'

const HEARTBEAT_INTERVAL_MS = 5_000
const IDLE_POLL_INTERVAL_MS = 250
const BUSY_POLL_INTERVAL_MS = 0    // immediately try next after a successful claim

const activeWorkers: string[] = []
let stopping = false
let heartbeatTimer: NodeJS.Timeout | null = null

function newWorkerId(slot: number): string {
  return `${hostname()}-${process.pid}-chat-${slot}`
}

function registerWorker(id: string): void {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.insert(workers)
    .values({
      id,
      kind:       'chat',
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

function heartbeatAll(): void {
  if (activeWorkers.length === 0) return
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  for (const id of activeWorkers) {
    db.update(workers)
      .set({ lastSeen: now })
      .where(eq(workers.id, id))
      .run()
  }
}

// Reconstruct the Job from an inbound row's payload. The payload was
// built by the producer (gateway/incoming.ts) at enqueue time.
function jobFromRow(row: InboundRow): Job | null {
  if (!row.payload) {
    logger.warn({ id: row.id }, 'inbound row has no payload; cannot reconstruct Job')
    return null
  }
  try {
    return JSON.parse(row.payload) as Job
  } catch (err) {
    logger.error({ err, id: row.id }, 'inbound row payload is not JSON')
    return null
  }
}

async function processOne(workerId: string, row: InboundRow): Promise<void> {
  setWorkerStatus(workerId, 'busy', `inbound:${row.id}`)

  const job = jobFromRow(row)
  if (!job) {
    markInboundFailed(row.id, workerId, 'invalid payload')
    setWorkerStatus(workerId, 'idle')
    return
  }

  try {
    const result = await processJob(job)
    // handleReply's third arg was the original WAMessage (used for
    // group quoting). That regression was already deferred in Phase 1;
    // pass an empty stub here too. The compiler type is loose enough.
    await handleReply(job, result, {} as never)
    const ok = markInboundDone(row.id, workerId)
    if (!ok) {
      logger.warn(
        { id: row.id, workerId },
        'inbound markDone failed (claim lost?). reply was already enqueued.',
      )
    }
    logger.info(
      {
        id: row.id,
        address: row.address,
        chars: result.reply.length,
        dur: result.stats?.durationMs,
      },
      'inbound processed',
    )
  } catch (err) {
    const isTimeout =
      err instanceof Error && err.name === 'ClaudeTimeoutError'
    const msg = err instanceof Error ? err.message : String(err)
    const result = markInboundRetryOrDlq(row.id, workerId, msg)
    if (result.deadLettered) {
      logger.error(
        { err, id: row.id, address: row.address, isTimeout },
        'inbound dead-lettered after max attempts',
      )
      // Send a user-facing failure ack so the chat isn't left hanging.
      try {
        const failText = isTimeout
          ? 'That request timed out. The task was cancelled, queue is moving.'
          : config.reply.errorMessage
        await handleReply(job, { reply: failText }, {} as never)
      } catch (e) {
        logger.error({ err: e, id: row.id }, 'failed to send DLQ-ack reply')
      }
    } else if (result.retried) {
      logger.warn(
        { err, id: row.id, address: row.address, isTimeout },
        'inbound transient fail, will retry',
      )
    }
  } finally {
    setWorkerStatus(workerId, 'idle')
  }
}

async function loop(workerId: string): Promise<void> {
  while (!stopping) {
    let processed = false
    try {
      const row = claimNextInbound(workerId)
      if (row) {
        await processOne(workerId, row)
        processed = true
      }
    } catch (err) {
      logger.error({ err, workerId }, 'chat worker loop error')
    }
    const delay = processed ? BUSY_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS
    if (delay > 0) {
      await new Promise<void>((res) => setTimeout(res, delay))
    } else {
      // Yield without sleeping so other microtasks (heartbeat etc) run.
      await new Promise<void>((res) => setImmediate(res))
    }
  }
  setWorkerStatus(workerId, 'dead')
}

export function startChatWorkers(): void {
  if (activeWorkers.length > 0) {
    logger.warn('chat workers already started; ignoring')
    return
  }
  const pool = Math.max(1, config.chatPool?.size ?? 5)
  for (let i = 0; i < pool; i++) {
    const id = newWorkerId(i)
    activeWorkers.push(id)
    registerWorker(id)
    void loop(id).catch((err) =>
      logger.fatal({ err, workerId: id }, 'chat worker loop crashed'),
    )
  }
  heartbeatTimer = setInterval(heartbeatAll, HEARTBEAT_INTERVAL_MS)
  logger.info({ pool }, 'chat worker pool started')
}

export function stopChatWorkers(): void {
  stopping = true
  if (heartbeatTimer) clearInterval(heartbeatTimer)
}
