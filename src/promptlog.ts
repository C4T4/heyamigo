import { appendFile, mkdir, readdir, unlink } from 'fs/promises'
import { resolve } from 'path'
import { config } from './config.js'

export type PromptLogEntry = {
  ts: number
  caller: 'worker' | 'digester' | 'importer'
  args: string[]
  input: string
  output?: string
  sessionId?: string
  usage?: unknown
  durationMs?: number
  error?: string
}

let dirReady = false

function promptsDir(): string {
  return resolve(process.cwd(), 'storage/prompts')
}

async function ensureDir(): Promise<void> {
  if (dirReady) return
  await mkdir(promptsDir(), { recursive: true })
  dirReady = true
}

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10)
  return resolve(promptsDir(), `${date}.jsonl`)
}

export async function logPrompt(entry: PromptLogEntry): Promise<void> {
  try {
    await ensureDir()
    await appendFile(logFilePath(), JSON.stringify(entry) + '\n', 'utf-8')
  } catch {
    // logging must never break the main flow
  }
}

/**
 * Delete prompt log files older than promptRetentionDays (counted inclusive of today).
 * Safe to call frequently; failures are swallowed.
 */
export async function prunePrompts(): Promise<void> {
  const days = config.logging.promptRetentionDays
  if (days <= 0) return
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1))
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  try {
    const names = await readdir(promptsDir())
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const fileDate = name.slice(0, 10)
      if (fileDate < cutoffStr) {
        await unlink(resolve(promptsDir(), name)).catch(() => undefined)
      }
    }
  } catch {
    // no dir yet, nothing to prune
  }
}
