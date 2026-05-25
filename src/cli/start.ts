import { execSync } from 'child_process'
import { bootBot, installShutdownSignals } from '../boot.js'
import { logger } from '../logger.js'

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

  installShutdownSignals()
  await bootBot()
}

main().catch((err) => {
  logger.error({ err }, 'fatal error during boot')
  process.exit(1)
})
