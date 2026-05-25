// Memory worker. Single concurrency by design: serializes ALL memory
// mutations into one writer thread so parallel chat / async workers
// can't race on file edits (full-file rewrites in particular).
//
// Dispatches by `op` to the existing handlers in src/memory/. The
// handlers themselves stay synchronous file writes — only the
// orchestration moved.

import { hostname } from 'os'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { workers } from '../db/schema.js'
import { logger } from '../logger.js'
import {
  claimNextMemoryWrite,
  markMemoryWriteDone,
  markMemoryWriteRetryOrDlq,
  type MemoryWriteRow,
} from './memory-writes.js'

const HEARTBEAT_INTERVAL_MS = 5_000
const IDLE_POLL_INTERVAL_MS = 250

let workerId: string | null = null
let stopping = false
let heartbeatTimer: NodeJS.Timeout | null = null

function newWorkerId(): string {
  return `${hostname()}-${process.pid}-memory-0`
}

function registerWorker(id: string): void {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.insert(workers)
    .values({
      id,
      kind:       'memory',
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

async function applyOp(row: MemoryWriteRow): Promise<void> {
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  switch (row.op) {
    case 'append_journal': {
      const { appendEntry } = await import('../memory/journals.js')
      const slug = payload.slug as string
      const entry = payload.entry as Parameters<typeof appendEntry>[1]
      const ok = appendEntry(slug, entry)
      if (!ok) {
        // Unknown slug — log + treat as done (no point retrying).
        logger.warn({ slug }, 'memory_writes: append_journal slug not found, dropped')
      }
      return
    }
    case 'create_journal': {
      const { createJournal, getJournal, isValidSlug } = await import('../memory/journals.js')
      const slug = payload.slug as string
      if (!isValidSlug(slug)) {
        logger.warn({ slug }, 'memory_writes: create_journal invalid slug, dropped')
        return
      }
      if (getJournal(slug)) {
        logger.info({ slug }, 'memory_writes: create_journal for existing slug, ignored')
        return
      }
      createJournal({
        slug,
        name: payload.name as string,
        purpose: payload.purpose as string,
      })
      logger.info({ slug }, 'journal created via memory_writes')
      return
    }
    case 'trigger_digest': {
      const { scheduleDigest } = await import('../memory/scheduler.js')
      scheduleDigest({
        jid: payload.jid as string,
        number: payload.number as string | undefined,
        reason: payload.reason as string,
      })
      return
    }
    case 'mark_compressed_dirty': {
      const { markCompressedDirty } = await import('../memory/compressed.js')
      markCompressedDirty()
      return
    }
    default:
      throw new Error(`unknown memory_writes op: ${row.op}`)
  }
}

async function processOne(workerId: string, row: MemoryWriteRow): Promise<void> {
  setWorkerStatus(workerId, 'busy', `memory_writes:${row.id}`)
  try {
    await applyOp(row)
    const ok = markMemoryWriteDone(row.id, workerId)
    if (!ok) {
      logger.warn(
        { id: row.id, workerId },
        'memory_writes markDone failed (claim lost?). op already applied.',
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const result = markMemoryWriteRetryOrDlq(row.id, workerId, msg)
    if (result.deadLettered) {
      logger.error({ err, id: row.id, op: row.op }, 'memory_writes dead-lettered')
    } else if (result.retried) {
      logger.warn({ err, id: row.id, op: row.op }, 'memory_writes transient fail, will retry')
    }
  } finally {
    setWorkerStatus(workerId, 'idle')
  }
}

async function loop(workerId: string): Promise<void> {
  while (!stopping) {
    let processed = false
    try {
      const row = claimNextMemoryWrite(workerId)
      if (row) {
        await processOne(workerId, row)
        processed = true
      }
    } catch (err) {
      logger.error({ err, workerId }, 'memory worker loop error')
    }
    if (!processed) {
      await new Promise<void>((res) => setTimeout(res, IDLE_POLL_INTERVAL_MS))
    } else {
      await new Promise<void>((res) => setImmediate(res))
    }
  }
  setWorkerStatus(workerId, 'dead')
}

export function startMemoryWorker(): void {
  if (workerId) {
    logger.warn('memory worker already started; ignoring')
    return
  }
  workerId = newWorkerId()
  registerWorker(workerId)
  heartbeatTimer = setInterval(
    () => workerId && heartbeat(workerId),
    HEARTBEAT_INTERVAL_MS,
  )
  void loop(workerId).catch((err) =>
    logger.fatal({ err }, 'memory worker loop crashed'),
  )
  logger.info({ workerId }, 'memory worker started')
}

export function stopMemoryWorker(): void {
  stopping = true
  if (heartbeatTimer) clearInterval(heartbeatTimer)
}
