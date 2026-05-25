import { setBaileysSocket } from './channels/index.js'
import { closeDb, initDb } from './db/index.js'
import { syncIdentitiesFromAccess } from './db/identity-sync.js'
import { attachIncoming } from './gateway/incoming.js'
import { handleReply } from './gateway/outgoing.js'
import { logger } from './logger.js'
import { startScheduler } from './memory/scheduler.js'
import { replayPending } from './queue/queue.js'
import { startSenderWorker, stopSenderWorker } from './queue/sender-worker.js'
import { startSocket } from './wa/socket.js'

async function main(): Promise<void> {
  logger.info('heyamigo starting')
  // Migrations + drift check first; refuses to start on schema mismatch.
  initDb()
  // Derived view: populate persons + identities from access.json.
  syncIdentitiesFromAccess()
  // Sender worker drains outbound queue → channel adapters. Started
  // before the socket so it's ready when handleReply enqueues rows.
  startSenderWorker()
  startScheduler()
  await startSocket((sock) => {
    attachIncoming(sock)
    // Point the Baileys adapter at the live socket. Called on each
    // reconnect with a fresh sock; the adapter just keeps the latest.
    setBaileysSocket(sock)
  })

  // Replay any jobs left from a previous crash (no original WAMessage
  // available, so replies are sent as plain messages, not quoted).
  void replayPending(async (job, result) => {
    await handleReply(job, result, {} as never)
  }).catch((err) => logger.error({ err }, 'replay failed'))
}

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down')
  stopSenderWorker()
  closeDb()
  process.exit(0)
})

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down')
  stopSenderWorker()
  closeDb()
  process.exit(0)
})

main().catch((err) => {
  logger.error({ err }, 'fatal error during boot')
  process.exit(1)
})
