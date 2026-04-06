import { execSync } from 'child_process'
import { attachIncoming } from '../gateway/incoming.js'
import { handleReply } from '../gateway/outgoing.js'
import { logger } from '../logger.js'
import { startScheduler } from '../memory/scheduler.js'
import { replayPending } from '../queue/queue.js'
import { startSocket } from '../wa/socket.js'

export async function main(): Promise<void> {
  try {
    execSync('which claude', { stdio: 'pipe' })
  } catch {
    console.error(
      'Claude CLI not found. Install it first:\n\n' +
        '  npm install -g @anthropic-ai/claude-code\n',
    )
    process.exit(1)
  }

  logger.info('heyamigo starting')
  startScheduler()
  await startSocket((sock) => {
    attachIncoming(sock)
  })

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
