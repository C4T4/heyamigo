import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { config } from '../config.js'
import fastq from 'fastq'
import type { queueAsPromised } from 'fastq'
import { initiate } from '../gateway/outgoing.js'
import { logger } from '../logger.js'
import { logPrompt } from '../promptlog.js'

export type AsyncTask = {
  id: string
  jid: string
  senderNumber: string
  senderName?: string
  description: string
  originatingMessage: string
  allowedTools: string[] | 'all'
  startedAt: number
}

type ClaudeJsonOutput = {
  type?: string
  subtype?: string
  result?: string
  is_error?: boolean
}

// Concurrency: how many async Claude workers can run simultaneously.
// Start conservative — each process is expensive (Playwright, multi-minute runs).
// Tune via config.asyncTasks.concurrency once we have real usage data.
const CONCURRENCY = 3

// In-memory registry of tasks currently executing. Not persisted across
// restarts — on reboot, any in-flight async work is silently dropped.
// We expose listInProgress() so the chat preamble can show "in progress"
// hints to the main Claude.
const inProgress = new Map<string, AsyncTask>()

const queue: queueAsPromised<AsyncTask, void> = fastq.promise<
  unknown,
  AsyncTask,
  void
>(async (task) => {
  inProgress.set(task.id, task)
  try {
    await runTask(task)
  } catch (err) {
    logger.error(
      { err, id: task.id, jid: task.jid },
      'async task failed unexpectedly',
    )
  } finally {
    inProgress.delete(task.id)
  }
}, CONCURRENCY)

export function enqueueAsyncTask(
  input: Omit<AsyncTask, 'id' | 'startedAt'>,
): AsyncTask {
  const task: AsyncTask = {
    ...input,
    id: `async-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Math.floor(Date.now() / 1000),
  }
  logger.info(
    {
      id: task.id,
      jid: task.jid,
      description: task.description.slice(0, 200),
    },
    'async task enqueued',
  )
  queue.push(task).catch((err) =>
    logger.error({ err, id: task.id }, 'async queue push failed'),
  )
  return task
}

export function listAsyncTasks(jid?: string): AsyncTask[] {
  const all = Array.from(inProgress.values())
  if (!jid) return all
  return all.filter((t) => t.jid === jid)
}

// ---------- task runner ----------

let cachedSystemPrompt: string | null = null

function systemPrompt(): string {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt
  const personality = readFileSync(
    resolve(process.cwd(), config.claude.personalityFile),
    'utf-8',
  )
  let memoryInstructions = ''
  try {
    memoryInstructions = readFileSync(
      resolve(process.cwd(), config.memory.instructionsFile),
      'utf-8',
    )
  } catch {
    // optional
  }
  cachedSystemPrompt = memoryInstructions
    ? `${personality}\n\n---\n\n${memoryInstructions}`
    : personality
  return cachedSystemPrompt
}

export function reloadAsyncSystemPrompt(): void {
  cachedSystemPrompt = null
}

function buildPrompt(task: AsyncTask): string {
  const lines = [
    `You are running a BACKGROUND TASK for the owner. The chat already got your ack reply. Your only job now is to do the work and output the final message to send them.`,
    ``,
    `TASK:`,
    task.description,
    ``,
    `ORIGINAL USER MESSAGE (for reference):`,
    task.originatingMessage,
    ``,
    `Sender: ${task.senderName ?? task.senderNumber}`,
    ``,
    `RULES:`,
    `- Stay fully in character (personality file). This is not customer service.`,
    `- Do the real work. Use tools (browser, etc.) as needed.`,
    `- When done, output ONLY the message to send the user. No preamble, no "here's what I found:" framing unless that's the message itself.`,
    `- Do NOT emit any [DIGEST:...], [JOURNAL:...], [ASYNC:...], or other markers. This is the final output.`,
    `- Start the message with a short reference to what you were working on so the user knows which task this is about (e.g. "About the TikTok scrape: ..."). They may have asked for multiple things.`,
    `- If the task is impossible or the tools failed, say so honestly and briefly. Don't fabricate.`,
    ``,
    `Output the final user-facing message now.`,
  ]
  return lines.join('\n')
}

function buildArgs(task: AsyncTask): string[] {
  const args: string[] = [
    '-p',
    '--output-format',
    'json',
    '--model',
    config.claude.model,
    '--permission-mode',
    'acceptEdits',
    '--append-system-prompt',
    systemPrompt(),
  ]
  for (const dir of config.claude.addDirs) {
    args.push('--add-dir', resolve(process.cwd(), dir))
  }
  args.push('--add-dir', resolve(process.cwd(), config.memory.dir))
  args.push('--add-dir', resolve(process.cwd(), config.storage.mediaDir))
  if (
    task.allowedTools &&
    task.allowedTools !== 'all' &&
    task.allowedTools.length > 0
  ) {
    args.push('--allowedTools', task.allowedTools.join(','))
  }
  return args
}

async function spawnClaudeForTask(
  task: AsyncTask,
  prompt: string,
): Promise<string> {
  const args = buildArgs(task)
  const startedAt = Date.now()

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8')
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8')
    })

    const logFail = (error: string) =>
      void logPrompt({
        ts: Math.floor(startedAt / 1000),
        caller: 'async-task',
        args,
        input: prompt,
        error,
        durationMs: Date.now() - startedAt,
      })

    child.on('error', (err) => {
      logFail(`spawn failed: ${err.message}`)
      rejectPromise(err)
    })

    child.on('close', (code) => {
      if (code !== 0) {
        logFail(`exit ${code}: ${stderr.slice(0, 300)}`)
        return rejectPromise(new Error(`async task exit ${code}`))
      }
      try {
        const parsed = JSON.parse(stdout) as ClaudeJsonOutput
        if (
          parsed.is_error ||
          parsed.subtype !== 'success' ||
          !parsed.result
        ) {
          logFail(`bad output: ${parsed.result ?? stderr.slice(0, 200)}`)
          return rejectPromise(new Error('async task bad output'))
        }
        const output = parsed.result.trim()
        void logPrompt({
          ts: Math.floor(startedAt / 1000),
          caller: 'async-task',
          args,
          input: prompt,
          output,
          durationMs: Date.now() - startedAt,
        })
        resolvePromise(output)
      } catch (err) {
        logFail(`parse failed: ${(err as Error).message}`)
        rejectPromise(err as Error)
      }
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })
}

async function runTask(task: AsyncTask): Promise<void> {
  const prompt = buildPrompt(task)
  const elapsedLog = () =>
    `${Math.round((Date.now() - task.startedAt * 1000) / 1000)}s`
  let output: string
  try {
    output = await spawnClaudeForTask(task, prompt)
  } catch (err) {
    logger.error(
      { err, id: task.id, jid: task.jid, elapsed: elapsedLog() },
      'async task claude call failed',
    )
    await initiate({
      jid: task.jid,
      text: `Heads up: the background task "${truncate(
        task.description,
        80,
      )}" failed. Ask me again and I'll retry.`,
    })
    return
  }

  // Strip any accidental trailing markers Claude emitted despite instructions.
  // Import lazily to avoid an import cycle (digest-flag already stands alone,
  // but being explicit here keeps this module independent).
  const { extractFlags } = await import('../memory/digest-flag.js')
  const { clean } = extractFlags(output)
  if (!clean.trim()) {
    logger.warn(
      { id: task.id, jid: task.jid },
      'async task produced empty output after flag strip',
    )
    return
  }
  const sent = await initiate({ jid: task.jid, text: clean })
  logger.info(
    {
      id: task.id,
      jid: task.jid,
      sent,
      elapsed: elapsedLog(),
      chars: clean.length,
    },
    'async task completed',
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
