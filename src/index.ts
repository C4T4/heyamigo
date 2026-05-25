import { closeDb, initDb } from './db/index.js'
import { attachIncoming } from './gateway/incoming.js'
import { handleReply } from './gateway/outgoing.js'
import { logger } from './logger.js'
import { startScheduler } from './memory/scheduler.js'
import { replayPending } from './queue/queue.js'
import { startSocket } from './wa/socket.js'

async function main(): Promise<void> {
  logger.info('heyamigo starting')
  // Migrations + drift check first; refuses to start on schema mismatch.
  // Additive — flat-file storage (sessions.json, memory files,
  // access.json) still authoritative until later phases swap them.
  initDb()
  startScheduler()
  await startSocket((sock) => {
    attachIncoming(sock)
  })

  // Replay any jobs left from a previous crash (no original WAMessage
  // available, so replies are sent as plain messages, not quoted).
  void replayPending(async (job, result) => {
    await handleReply(job, result, {} as never)
  }).catch((err) => logger.error({ err }, 'replay failed'))
}

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down')
  closeDb()
  process.exit(0)
})

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down')
  closeDb()
  process.exit(0)
})

main().catch((err) => {
  logger.error({ err }, 'fatal error during boot')
  process.exit(1)
})
