import { attachIncoming } from './gateway/incoming.js'
import { handleReply } from './gateway/outgoing.js'
import { logger } from './logger.js'
import { startScheduler } from './memory/scheduler.js'
import { replayPending } from './queue/queue.js'
import { startSocket } from './wa/socket.js'

async function main(): Promise<void> {
  logger.info('heyamigo starting')
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
  process.exit(0)
})

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down')
  process.exit(0)
})

main().catch((err) => {
  logger.error({ err }, 'fatal error during boot')
  process.exit(1)
})
