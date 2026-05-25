import fastq from 'fastq'
import type { queueAsPromised } from 'fastq'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { prunePrompts } from '../promptlog.js'
import { registerInternalCronHandler } from '../queue/cron-handlers.js'
import { deleteCron, enqueueCron } from '../queue/crons.js'
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

const NUDGE_TICK_MS = 5 * 60 * 1000 // 5 minutes
let started = false

export function startScheduler(): void {
  if (started) return
  started = true
  ensureScaffold()
  void prunePrompts() // run once on boot

  // Rebuild the compressed memory view on boot so every session starts with
  // current state. Runs in background, don't block scheduler startup.
  void (async () => {
    try {
      const { ensureCompressedFresh } = await import('./compressed.js')
      await ensureCompressedFresh()
    } catch (err) {
      logger.error({ err }, 'compressed: boot rebuild failed')
    }
  })()

  // Memory sweep: migrated from setInterval to a cron entry. Same
  // cadence (config.memory.sweepIntervalMs); body runs as an internal
  // cron handler so the orchestrator drives the schedule.
  registerInternalCronHandler('memory-sweep', async () => {
    try {
      await sweep()
    } catch (err) {
      logger.error({ err }, 'sweep failed')
    }
  })
  enqueueCron({
    name:        'memory-sweep',
    enqueueInto: 'internal',
    payload:     { handler: 'memory-sweep' },
    recurrence:  `@every ${Math.floor(config.memory.sweepIntervalMs / 1000)}s`,
  })

  // Proactive journal nudges (check-ins, silent-nudges). Migrated from
  // setInterval to a cron row → orchestrator. Same cadence, same body;
  // benefits are: survives restarts, visible in `crons` table, can be
  // paused via control row without code change.
  registerInternalCronHandler('journal-nudge-tick', runNudgeTickSafe)
  enqueueCron({
    name:        'journal-nudge-tick',
    enqueueInto: 'internal',
    payload:     { handler: 'journal-nudge-tick' },
    recurrence:  `@every ${Math.floor(NUDGE_TICK_MS / 1000)}s`,
  })

  logger.info(
    {
      intervalMs: config.memory.sweepIntervalMs,
      nudgeTickMs: NUDGE_TICK_MS,
    },
    'memory scheduler started',
  )
}

async function runNudgeTickSafe(): Promise<void> {
  try {
    const { runNudgeTick } = await import('./journal-nudger.js')
    await runNudgeTick()
  } catch (err) {
    logger.error({ err }, 'nudge tick failed')
  }
}

export function stopScheduler(): void {
  // All recurring work is now in the crons table; orchestrator handles
  // its own shutdown. Just clear the in-process debounce timers (for
  // scheduleDigest's per-jid coalescing).
  for (const t of pendingTimers.values()) clearTimeout(t)
  pendingTimers.clear()
  started = false
}

// Exported for callers (CLI, /nudge command) that want to surgically
// disable nudges without editing config. Use `setCronEnabled` from
// crons.ts for the on/off switch; this is a hard delete (regenerated
// on next startScheduler call).
export function deleteNudgeCron(): boolean {
  return deleteCron('journal-nudge-tick')
}
