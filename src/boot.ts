// Shared bootstrap for both the library entry (src/index.ts) and the
// CLI start command (src/cli/start.ts). Single source of truth for
// startup order — there used to be two parallel main() functions that
// drifted; this prevents that.

import { setBaileysSocket } from './channels/index.js'
import { closeDb, initDb } from './db/index.js'
import { syncIdentitiesFromAccess } from './db/identity-sync.js'
import { attachIncoming } from './gateway/incoming.js'
import { logger } from './logger.js'
import { startScheduler } from './memory/scheduler.js'
import { startChatWorkers, stopChatWorkers } from './queue/chat-worker.js'
import {
  startMemoryWorker,
  stopMemoryWorker,
} from './queue/memory-worker.js'
import {
  requestShutdown,
  startOrchestrator,
  stopOrchestrator,
} from './queue/orchestrator.js'
import { startSenderWorker, stopSenderWorker } from './queue/sender-worker.js'
import { startSocket } from './wa/socket.js'

let booted = false

export async function bootBot(): Promise<void> {
  if (booted) {
    logger.warn('bootBot called twice; ignoring')
    return
  }
  booted = true

  logger.info('heyamigo starting')

  // Migrations + drift check first. Refuses to start on schema mismatch
  // — protects production data from a half-applied schema upgrade.
  initDb()

  // Derived view: persons + identities from access.json (idempotent).
  syncIdentitiesFromAccess()

  // Orchestrator first so workers see a control surface from the moment
  // they register. Drain hook stops everything in reverse order.
  startOrchestrator({
    onShutdownDrained: () => {
      stopChatWorkers()
      stopSenderWorker()
      stopMemoryWorker()
      stopOrchestrator()
      closeDb()
    },
  })

  // Workers next. Queue tables are the source of truth; anything left
  // from a previous crash gets claimed by the new pool automatically.
  // No separate replay step needed.
  startSenderWorker()
  startMemoryWorker()
  startChatWorkers()
  startScheduler()

  await startSocket((sock) => {
    attachIncoming(sock)
    // Point the Baileys adapter at the live socket. Called on each
    // reconnect with a fresh sock; the adapter just keeps the latest.
    setBaileysSocket(sock)
  })
}

// Install once. Both signals trigger the same graceful drain:
// orchestrator picks up the shutdown control row, waits for busy
// workers, then runs onShutdownDrained and exits.
let signalsInstalled = false
export function installShutdownSignals(): void {
  if (signalsInstalled) return
  signalsInstalled = true

  process.on('SIGINT', () => {
    logger.info('SIGINT received, requesting graceful shutdown')
    requestShutdown('SIGINT')
  })

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, requesting graceful shutdown')
    requestShutdown('SIGTERM')
  })
}
