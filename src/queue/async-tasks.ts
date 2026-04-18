import { readFileSync } from 'fs'
import { resolve } from 'path'
import { runClaude, TIMEOUT_MS } from '../ai/spawn.js'
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
    `You are a BACKGROUND WORKER. The chat already got its ack ("on it, will report back"). Your output does NOT go to chat by default — it routes through markers to memory files, same way the main chat Claude routes things.`,
    ``,
    `TASK:`,
    task.description,
    ``,
    `ORIGINAL USER MESSAGE (for reference):`,
    task.originatingMessage,
    ``,
    `Sender: ${task.senderName ?? task.senderNumber}`,
    ``,
    `HOW TO ROUTE YOUR FINDINGS (markers, at the END of your output, one per line):`,
    `- [JOURNAL:<slug> — <one-line finding>] for each distinct finding that belongs in a journal. ONE marker per finding — ten findings = ten markers, not one long paragraph. Only use slugs that already exist (check the Journals list in your preamble), or emit [JOURNAL-NEW:<slug> — <purpose>] first to create one in the same output.`,
    `- [JOURNAL-NEW:<slug> — <one-line purpose>] to create a new journal when the task clearly needs tracking but no journal covers it yet. Propose the slug yourself, conservatively.`,
    `- [DIGEST: <one-line reason>] if you learned something durable about the owner or chat that should update the profile/brief.`,
    ``,
    `CONSTRAINTS:`,
    `- Do NOT emit [ASYNC:...]. No recursive delegation.`,
    `- Do NOT frame your output as a chat message. No "here's what I found:", no "About the task:". The markers ARE the output.`,
    `- Keep any pre-marker text SHORT — one sentence max, or empty. Long pre-marker prose is suppressed and not sent to chat. Put the real content inside markers.`,
    `- If the task failed or the tools didn't produce a usable result (login wall, empty page, bot-detection, timeout), output a short clean message (no markers) explaining what happened. That short text IS sent to chat so the owner knows. Do not fabricate findings.`,
    `- Stay fully in character.`,
    ``,
    `EXAMPLE for an IG scrape task:`,
    `[JOURNAL:rivoara-spy — IG bio: "Premium shower filter for HT aftercare"]`,
    `[JOURNAL:rivoara-spy — IG post: day-5 routine angle live]`,
    `[JOURNAL:rivoara-spy — IG post: Turkey clinic partnership visible in post 3]`,
    ``,
    `EXAMPLE for a failure:`,
    `Instagram hit login wall on @rivoara_official after 2 navigation attempts. No public data accessible. Auth needs refreshing.`,
    ``,
    `Do the work now. Then emit your markers.`,
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
  const { stdout, durationMs } = await runClaude({
    args,
    input: prompt,
    timeoutMs: TIMEOUT_MS.async,
    caller: 'async-task',
  })
  const startedAt = Date.now() - durationMs

  let parsed: ClaudeJsonOutput
  try {
    parsed = JSON.parse(stdout) as ClaudeJsonOutput
  } catch (err) {
    throw new Error(`async task parse failed: ${(err as Error).message}`)
  }
  if (parsed.is_error || parsed.subtype !== 'success' || !parsed.result) {
    throw new Error(
      `async task bad output: ${parsed.result ?? stdout.slice(0, 200)}`,
    )
  }
  const output = parsed.result.trim()
  void logPrompt({
    ts: Math.floor(startedAt / 1000),
    caller: 'async-task',
    args,
    input: prompt,
    output,
    durationMs,
  })
  return output
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

  // Parse markers from the worker's output and route them through the same
  // handlers the main chat uses. The async worker's job is to emit findings
  // as markers; clean pre-marker text is only sent to chat when short (a
  // failure explanation or tight ack) or when no markers fired at all.
  const { extractFlags } = await import('../memory/digest-flag.js')
  const { clean, digest, journals, journalCreates } = extractFlags(output)

  // Journal creates run first so an entry flagged in the same output against
  // a new slug lands correctly.
  const { appendEntry, createJournal, getJournal, isValidSlug } =
    await import('../memory/journals.js')
  for (const op of journalCreates) {
    if (!isValidSlug(op.slug)) {
      logger.warn(
        { op, id: task.id },
        'async JOURNAL-NEW: invalid slug, dropped',
      )
      continue
    }
    if (getJournal(op.slug)) continue
    try {
      createJournal({
        slug: op.slug,
        name: titleCaseSlug(op.slug),
        purpose: op.purpose,
      })
      logger.info(
        { slug: op.slug, id: task.id },
        'journal created via async marker',
      )
    } catch (err) {
      logger.error(
        { err, op, id: task.id },
        'async JOURNAL-NEW failed',
      )
    }
  }

  let appendedCount = 0
  for (const j of journals) {
    const ok = appendEntry(j.slug, {
      source: 'async',
      jid: task.jid,
      senderNumber: task.senderNumber,
      note: j.note,
    })
    if (ok) appendedCount++
    else {
      logger.warn(
        { slug: j.slug, id: task.id },
        'async JOURNAL marker pointed at unknown slug, dropped',
      )
    }
  }

  if (digest) {
    const { scheduleDigest } = await import('../memory/scheduler.js')
    scheduleDigest({
      jid: task.jid,
      number: task.senderNumber,
      reason: digest,
    })
  }

  // Decide what to send to chat.
  const leftover = clean.trim()
  const anyMarkerFired =
    appendedCount > 0 || journalCreates.length > 0 || digest !== null

  let chatText: string | null = null
  if (!anyMarkerFired) {
    // No markers — fall back to sending the output as a chat message so the
    // owner isn't left with silence. Covers both "Claude ignored the marker
    // rule" and legitimate "short failure explanation" cases.
    chatText = leftover || null
  } else if (leftover.length > 0 && leftover.length <= 400) {
    // Markers fired AND a short pre-marker line — likely an intentional
    // failure explanation or completion note. Send it.
    chatText = leftover
  } else if (leftover.length > 400) {
    // Long pre-marker prose despite markers firing — Claude didn't follow
    // the routing contract. Suppress the prose; log for inspection.
    logger.warn(
      {
        id: task.id,
        jid: task.jid,
        chars: leftover.length,
      },
      'async task produced long pre-marker prose, suppressing chat send',
    )
  }
  // Otherwise: markers fired, no leftover — success, silent. Findings live
  // in the journal files now.

  if (chatText) {
    await initiate({ jid: task.jid, text: chatText })
  }

  logger.info(
    {
      id: task.id,
      jid: task.jid,
      elapsed: elapsedLog(),
      appended: appendedCount,
      createdJournals: journalCreates.length,
      digestFired: !!digest,
      chatSent: chatText ? chatText.length : 0,
    },
    'async task completed',
  )
}

function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join(' ')
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
