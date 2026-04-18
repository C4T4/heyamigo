import { appendFile, mkdir, readdir, unlink } from 'fs/promises'
import { resolve } from 'path'
import { config } from './config.js'

export type PromptLogEntry = {
  ts: number
  caller:
    | 'worker'
    | 'digester'
    | 'importer'
    | 'journal-observer'
    | 'journal-nudger'
    | 'async-task'
    | 'browser-task'
    | 'compressed'
  args: string[]
  input: string
  output?: string
  sessionId?: string
  usage?: unknown
  durationMs?: number
  error?: string
  // Verbose HTTP-layer debug logs from ANTHROPIC_LOG=debug (Claude SDK
  // internals). Truncated to STDERR_MAX_BYTES on write. Useful for
  // diagnosing API hangs, rate limits, retries.
  stderr?: string
  // Types of stream-json events observed during the turn, in order (e.g.
  // ["system", "assistant", "user", "assistant", "result"]). Gives
  // agent-loop shape without dumping full event payloads.
  eventTypes?: string[]
}

// Hard caps on fields that can grow unbounded. Prevents promptlog entries
// from exploding when a run produces huge stdout/stderr. prunePrompts
// still handles multi-day retention separately.
const STDOUT_MAX_BYTES = 100_000
const STDERR_MAX_BYTES = 50_000
const INPUT_MAX_BYTES = 200_000

function truncateWithMarker(s: string, maxBytes: number): string {
  if (!s) return s
  // Rough byte size via length — fine for mostly-ASCII prompt payloads.
  if (s.length <= maxBytes) return s
  const extra = s.length - maxBytes
  return s.slice(0, maxBytes) + `\n… [truncated ${extra} bytes]`
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
    const capped: PromptLogEntry = {
      ...entry,
      input: truncateWithMarker(entry.input, INPUT_MAX_BYTES),
    }
    if (entry.output !== undefined) {
      capped.output = truncateWithMarker(entry.output, STDOUT_MAX_BYTES)
    }
    if (entry.stderr !== undefined) {
      capped.stderr = truncateWithMarker(entry.stderr, STDERR_MAX_BYTES)
    }
    await appendFile(logFilePath(), JSON.stringify(capped) + '\n', 'utf-8')
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
