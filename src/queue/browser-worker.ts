// Browser worker pool. N workers (config.browser.maxWorkers, default
// 3) drain the browser_tasks SQLite table. Each task runs as a fresh
// agent with its own tab on the shared Chrome — same model as before
// the durability change, just claimable from the DB now.
//
// Differences vs in-memory fastq:
// - Tasks survive process crashes (durable rows).
// - Orchestrator reclaims stuck claims via reclaimStuckBrowserTasks.
// - Retry / DLQ semantics live in the queue helpers.

import { hostname } from 'os'
import { eq } from 'drizzle-orm'
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { addressToChatKey } from '../db/address.js'
import { workers } from '../db/schema.js'
import { logger } from '../logger.js'
import {
  claimNextBrowserTask,
  markBrowserTaskDone,
  markBrowserTaskRetryOrDlq,
  type BrowserTaskRow,
} from './browser-queue.js'
import { initiate } from '../gateway/outgoing.js'
import { runBrowserTask } from './async-tasks.js'
import type { AsyncTask } from './async-tasks.js'

const HEARTBEAT_INTERVAL_MS = 5_000
const IDLE_POLL_INTERVAL_MS = 500
const BUSY_POLL_INTERVAL_MS = 0

const activeWorkers: string[] = []
let stopping = false
let heartbeatTimer: NodeJS.Timeout | null = null

function newWorkerId(slot: number): string {
  return `${hostname()}-${process.pid}-browser-${slot}`
}

function registerWorker(id: string): void {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.insert(workers)
    .values({
      id,
      kind:       'browser',
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

// Convert a row into the AsyncTask shape that runBrowserTask expects.
// The id field is a synthetic string for log lines; the real row id
// is used for queue bookkeeping.
function rowToAsyncTask(row: BrowserTaskRow): AsyncTask {
  let allowedTools: string[] | 'all' = 'all'
  if (row.allowedTools) {
    try {
      allowedTools = JSON.parse(row.allowedTools)
    } catch {
      // bad JSON → fall back to 'all'
    }
  }
  return {
    id: `browser-${row.id}`,
    jid: addressToChatKey(row.address),
    address: row.address,
    senderNumber: row.senderNumber,
    senderName: row.senderName ?? undefined,
    description: row.description,
    originatingMessage: row.originatingMessage,
    allowedTools,
    startedAt: row.claimedAt ?? row.createdAt,
  }
}

async function processOne(workerId: string, row: BrowserTaskRow): Promise<void> {
  setWorkerStatus(workerId, 'busy', `browser_tasks:${row.id}`)
  const task = rowToAsyncTask(row)
  try {
    await runBrowserTask(task)
    const ok = markBrowserTaskDone(row.id, workerId)
    if (!ok) {
      logger.warn(
        { id: row.id, workerId },
        'browser task markDone failed (claim lost?). work already done.',
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const result = markBrowserTaskRetryOrDlq(row.id, workerId, msg)
    if (result.deadLettered) {
      logger.error(
        { err, id: row.id, address: row.address },
        'browser task dead-lettered after max attempts',
      )
      // User-facing failure ack so the chat isn't left hanging.
      try {
        await initiate({
          jid: addressToChatKey(row.address),
          address: row.address,
          text: `Heads up: the browser task "${row.description.slice(0, 80)}" failed. Ask me again and I'll retry.`,
        })
      } catch (e) {
        logger.error({ err: e, id: row.id }, 'failed to send DLQ-ack reply')
      }
    } else if (result.retried) {
      logger.warn(
        { err, id: row.id, address: row.address },
        'browser task transient fail, will retry',
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
      const row = claimNextBrowserTask(workerId)
      if (row) {
        await processOne(workerId, row)
        processed = true
      }
    } catch (err) {
      logger.error({ err, workerId }, 'browser worker loop error')
    }
    const delay = processed ? BUSY_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS
    if (delay > 0) {
      await new Promise<void>((res) => setTimeout(res, delay))
    } else {
      await new Promise<void>((res) => setImmediate(res))
    }
  }
  setWorkerStatus(workerId, 'dead')
}

export function startBrowserWorkers(): void {
  if (activeWorkers.length > 0) {
    logger.warn('browser workers already started; ignoring')
    return
  }
  const pool = Math.max(1, config.browser?.maxWorkers ?? 3)
  for (let i = 0; i < pool; i++) {
    const id = newWorkerId(i)
    activeWorkers.push(id)
    registerWorker(id)
    void loop(id).catch((err) =>
      logger.fatal({ err, workerId: id }, 'browser worker loop crashed'),
    )
  }
  heartbeatTimer = setInterval(heartbeatAll, HEARTBEAT_INTERVAL_MS)
  logger.info({ pool }, 'browser worker pool started')
}

export function stopBrowserWorkers(): void {
  stopping = true
  if (heartbeatTimer) clearInterval(heartbeatTimer)
}
