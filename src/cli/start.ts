import { execFileSync } from 'child_process'
import { bootBot, installShutdownSignals } from '../boot.js'
import { config } from '../config.js'
import { logger } from '../logger.js'

function requiredCli(): { bin: string; install: string } {
  switch (config.ai.provider) {
    case 'claude':
      return {
        bin: 'claude',
        install: 'npm install -g @anthropic-ai/claude-code',
      }
    case 'codex':
      return {
        bin: 'codex',
        install: 'npm install -g @openai/codex',
      }
    case 'grok':
      return {
        bin: config.grok.bin,
        install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
      }
  }
}

export async function main(): Promise<void> {
  const cli = requiredCli()
  try {
    execFileSync('which', [cli.bin], { stdio: 'pipe' })
  } catch {
    console.error(
      `${config.ai.provider} CLI not found. Install it first:\n\n` +
        `  ${cli.install}\n`,
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
