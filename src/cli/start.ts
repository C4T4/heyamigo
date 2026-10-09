import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { resolve } from 'path'
import { bootBot, installShutdownSignals } from '../boot.js'
import { config } from '../config.js'
import { logger } from '../logger.js'

function requiredCli(): { bin: string; install: string } {
  switch (config.ai.provider) {
    case 'claude':
      return {
        bin: 'claude',
        install: 'curl -fsSL https://claude.ai/install.sh | bash',
      }
    case 'codex':
      return {
        bin: 'codex',
        install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      }
    case 'grok':
      return {
        bin: config.grok.bin,
        install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
      }
    case 'gemini':
      return {
        bin: config.gemini.bin,
        install: 'brew install gemini-cli',
      }
  }
}

function ensureLocalBinOnPath(): void {
  const localBin = resolve(homedir(), '.local/bin')
  const parts = (process.env.PATH ?? '').split(':').filter(Boolean)
  if (!parts.includes(localBin)) {
    process.env.PATH = [localBin, ...parts].join(':')
  }
}

export async function main(): Promise<void> {
  ensureLocalBinOnPath()
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
