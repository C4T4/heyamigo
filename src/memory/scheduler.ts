import fastq from 'fastq'
import type { queueAsPromised } from 'fastq'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { prunePrompts } from '../promptlog.js'
import { pruneMedia } from '../store/media.js'
import { runDigest } from './digest.js'
import {
  ensureScaffold,
  getLastDigestedAt,
  jsonlMtimeFor,
  loadDigestState,
} from './store.js'

type DigestTask = {
  jid: string
  number?: string
  reason: string
}

const digestQueue: queueAsPromised<DigestTask, void> = fastq.promise<
  unknown,
  DigestTask,
  void
>(async (task) => {
  await runDigest({
    jid: task.jid,
    number: task.number,
    reason: task.reason,
  })
}, 1)

// Debounce: coalesce rapid-fire flags for the same jid into a single digest
const pendingTimers = new Map<string, NodeJS.Timeout>()

export function scheduleDigest(params: {
  jid: string
  number?: string
  reason: string
}): void {
  const key = params.number ? `${params.jid}#${params.number}` : params.jid
  const existing = pendingTimers.get(key)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    pendingTimers.delete(key)
    digestQueue
      .push({
        jid: params.jid,
        number: params.number,
        reason: params.reason,
      })
      .catch((err) =>
        logger.error({ err, key }, 'digest queue push failed'),
      )
  }, config.memory.digestDebounceMs)
  pendingTimers.set(key, timer)
}

export async function runDigestNow(params: {
  jid: string
  number?: string
  reason: string
}): Promise<void> {
  const existing = pendingTimers.get(
    params.number ? `${params.jid}#${params.number}` : params.jid,
  )
  if (existing) clearTimeout(existing)
  await digestQueue.push({
    jid: params.jid,
    number: params.number,
    reason: params.reason,
  })
}

async function sweep(): Promise<void> {
  await prunePrompts()
  await pruneMedia()
  const state = loadDigestState()
  for (const jid of Object.keys(state.jids).concat()) {
    // placeholder: we only sweep jids we've seen; real discovery
    // would walk storage/messages/ for all jids. Keep simple for v1.
  }
  // Iterate all sessions as a source of active jids
  const { listSessions } = await import('../ai/sessions.js')
  const sessions = listSessions()
  for (const jid of Object.keys(sessions)) {
    const mtime = jsonlMtimeFor(jid)
    const last = getLastDigestedAt(state, 'jid', jid)
    if (mtime > last) {
      logger.info({ jid }, 'interval sweep: jid has new activity, digesting')
      digestQueue
        .push({ jid, reason: 'interval sweep' })
        .catch((err) =>
          logger.error({ err, jid }, 'sweep digest push failed'),
        )
    }
  }

  // Journal observer pass: scans recent messages per active journal for
  // entries Claude missed (i.e. when the bot wasn't mentioned). Runs once
  // per sweep cycle; each journal maintains its own last-scanned-ts.
  try {
    const { runJournalObserverSweep } = await import(
      './journal-observer.js'
    )
    await runJournalObserverSweep()
  } catch (err) {
    logger.error({ err }, 'journal observer sweep failed')
  }
}

let sweepTimer: NodeJS.Timeout | null = null

export function startScheduler(): void {
  if (sweepTimer) return
  ensureScaffold()
  void prunePrompts() // run once on boot
  sweepTimer = setInterval(() => {
    void sweep().catch((err) =>
      logger.error({ err }, 'sweep failed'),
    )
  }, config.memory.sweepIntervalMs)
  logger.info(
    { intervalMs: config.memory.sweepIntervalMs },
    'memory scheduler started',
  )
}

export function stopScheduler(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  for (const t of pendingTimers.values()) clearTimeout(t)
  pendingTimers.clear()
}
