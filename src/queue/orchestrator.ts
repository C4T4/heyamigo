// Bot-wide orchestrator. One process-wide instance. Polls every
// ~500ms and does the cross-cutting work no single worker should
// own:
//   - Read control table → apply shutdown/pause/reload signals.
//   - Reclaim stuck claims on outbound (and later: async, browser,
//     memory_writes).
//   - Mark dead workers (last_seen past threshold).
//   - Poll the cron table → enqueue due jobs (Phase 2.2; not yet).
//   - Log queue depths to a metrics buffer (Phase 7; not yet).
//
// Distinct from the sender worker: sender pulls from outbound and
// sends. Orchestrator pulls signals and metadata; it dispatches but
// doesn't do per-row work itself.

import { hostname } from 'os'
import { and, eq, lt, ne } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { workers } from '../db/schema.js'
import { logger } from '../logger.js'
import { reclaimStuckInbound } from './inbound.js'
import { reclaimStuckOutbound } from './outbound.js'
import { clearControl, readControl, requestControl } from './control.js'
import { listDueCrons, markCronFired } from './crons.js'
import { dispatchCron } from './cron-dispatch.js'

const TICK_INTERVAL_MS = 500
const HEARTBEAT_INTERVAL_MS = 5_000
const WORKER_DEAD_AFTER_SECONDS = 30
const SHUTDOWN_GRACE_MS = 30_000   // total drain window before force-exit

let workerId: string | null = null
let stopping = false
let draining = false
let tickTimer: NodeJS.Timeout | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let exitHook: (() => Promise<void> | void) | null = null

function newOrchestratorId(): string {
  return `${hostname()}-${process.pid}-orchestrator-0`
}

function registerSelf(id: string): void {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.insert(workers)
    .values({
      id,
      kind:       'orchestrator',
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

function heartbeat(id: string): void {
  const db = getDb()
  db.update(workers)
    .set({ lastSeen: Math.floor(Date.now() / 1000) })
    .where(eq(workers.id, id))
    .run()
}

// Mark workers as dead when their last_seen has aged past the
// threshold. Used as a liveness signal in observability queries and
// (eventually) to reclaim their claimed jobs across all queues.
function markDeadWorkers(): number {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - WORKER_DEAD_AFTER_SECONDS
  const result = db
    .update(workers)
    .set({ status: 'dead' })
    .where(
      and(
        lt(workers.lastSeen, cutoff),
        ne(workers.status, 'dead'),
      ),
    )
    .returning({ id: workers.id, kind: workers.kind })
    .all()
  for (const w of result) {
    logger.warn({ id: w.id, kind: w.kind }, 'worker marked dead (no heartbeat)')
  }
  return result.length
}

function busyWorkerCount(): number {
  const db = getDb()
  const row = db
    .select({ id: workers.id })
    .from(workers)
    .where(eq(workers.status, 'busy'))
    .all()
  return row.length
}

async function tick(id: string): Promise<void> {
  try {
    const ctl = readControl('shutdown')
    if (ctl && !draining) {
      logger.info({ requestedBy: ctl.requestedBy }, 'shutdown requested via control table')
      draining = true
      // Mark ourselves draining so observability shows it.
      const db = getDb()
      db.update(workers)
        .set({ status: 'draining' })
        .where(eq(workers.id, id))
        .run()
    }

    // Cross-queue housekeeping. More queues land in later phases.
    const reclaimedOutbound = reclaimStuckOutbound()
    if (reclaimedOutbound > 0) {
      logger.info({ reclaimed: reclaimedOutbound }, 'reclaimed stuck outbound rows')
    }
    const reclaimedInbound = reclaimStuckInbound()
    if (reclaimedInbound > 0) {
      logger.info({ reclaimed: reclaimedInbound }, 'reclaimed stuck inbound rows')
    }

    // Fire any due crons. Order: dispatch each in turn; if dispatch
    // throws (it shouldn't — dispatch swallows), the cron is NOT
    // marked fired and we'll retry on the next tick.
    if (!draining) {
      const due = listDueCrons()
      for (const row of due) {
        try {
          dispatchCron(row)
          markCronFired(row)
        } catch (err) {
          logger.error({ err, name: row.name }, 'cron dispatch crashed')
        }
      }
    }

    markDeadWorkers()

    if (draining) {
      const busy = busyWorkerCount()
      if (busy === 0) {
        logger.info('all workers idle, exiting cleanly')
        clearControl('shutdown')
        if (exitHook) {
          await exitHook()
        }
        process.exit(0)
      }
    }
  } catch (err) {
    logger.error({ err }, 'orchestrator tick error')
  }
}

export function startOrchestrator(opts: {
  onShutdownDrained?: () => Promise<void> | void
} = {}): void {
  if (workerId) {
    logger.warn('orchestrator already started; ignoring')
    return
  }
  workerId = newOrchestratorId()
  exitHook = opts.onShutdownDrained ?? null
  registerSelf(workerId)
  heartbeatTimer = setInterval(
    () => workerId && heartbeat(workerId),
    HEARTBEAT_INTERVAL_MS,
  )
  const id = workerId
  tickTimer = setInterval(() => {
    void tick(id)
  }, TICK_INTERVAL_MS)
  logger.info({ workerId }, 'orchestrator started')
}

export function stopOrchestrator(): void {
  stopping = true
  if (tickTimer) clearInterval(tickTimer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
}

// Public entry point for "begin graceful shutdown." Inserts the
// control row + sets a force-exit timer so we don't hang forever if
// some worker refuses to drain.
export function requestShutdown(by: string): void {
  if (draining) return
  requestControl('shutdown', 'requested', by)
  setTimeout(() => {
    if (!stopping) {
      logger.warn(
        { graceMs: SHUTDOWN_GRACE_MS },
        'graceful shutdown timed out, forcing exit',
      )
      process.exit(1)
    }
  }, SHUTDOWN_GRACE_MS).unref()
}

export function isDraining(): boolean {
  return draining
}
