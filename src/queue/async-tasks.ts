import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
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
  session_id?: string
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
    `You are a BACKGROUND WORKER doing a delayed chat reply. The chat already got an ack ("on it, will report back"). Now you do the work, and your output IS the follow-up chat reply — the full answer the owner is waiting for.`,
    ``,
    `TASK:`,
    task.description,
    ``,
    `ORIGINAL USER MESSAGE (for reference):`,
    task.originatingMessage,
    ``,
    `Sender: ${task.senderName ?? task.senderNumber}`,
    ``,
    `HOW TO OUTPUT:`,
    `- Write the full answer as a natural chat reply. Same voice, same style as the main chat Claude. What the owner would have gotten if you'd answered inline, just delayed.`,
    `- Open with a short "about the X you asked about..." reference so the owner knows which task this is (they may have asked for several). One sentence, then the content.`,
    `- Concrete findings, no filler. Numbers, names, dates. If you found 10 creators, list them — don't say "multiple creators".`,
    `- If the task failed or hit a wall (login wall, empty page, bot-detection, timeout), say so honestly and briefly. Don't fabricate.`,
    ``,
    `OPTIONAL MARKERS (at the END of your output, same pattern as main chat):`,
    `- [JOURNAL:<slug> — <one-line finding>] for any finding that belongs in an active journal. These run IN ADDITION to your chat reply — they file structured entries in journals/<slug>/entries.jsonl for future reference, dedup, and cross-session memory. Use existing slugs only (check [Journals: active] in your preamble). ONE marker per finding.`,
    `- [JOURNAL-NEW:<slug> — <one-line purpose>] if the task clearly deserves a new journal that doesn't exist yet. Conservative — only when the topic is a recurring tracking surface, not a one-off.`,
    `- [DIGEST: <one-line reason>] if you learned something durable about the owner or chat that should update the profile/brief.`,
    ``,
    `CONSTRAINTS:`,
    `- Do NOT emit [ASYNC:...]. No recursive delegation.`,
    `- Markers are bonus persistence, not a substitute for the chat reply. Always write the chat reply first.`,
    `- Stay fully in character (personality).`,
    ``,
    `EXAMPLE for an IG scrape of rivoara_official (with journal tracking):`,
    `About the @rivoara_official check: bio is "Premium shower filter for HT aftercare". Last 3 posts: day-5 routine walkthrough, filter-science deep dive, Turkey clinic partnership announcement. Grid is clean, ~200 followers. Pattern: aftercare positioning is the lead, product is secondary.`,
    ``,
    `[JOURNAL:rivoara-spy — IG bio: "Premium shower filter for HT aftercare"]`,
    `[JOURNAL:rivoara-spy — IG recent posts: day-5 routine, filter science, Turkey clinic partnership]`,
    ``,
    `EXAMPLE for a failure:`,
    `About the @rivoara_official check: Instagram threw a login wall after the first navigation. Can't read the bio or posts without auth. The VNC Chrome session looks expired — worth re-logging.`,
    ``,
    `Do the work now. Write the reply. Markers optional at the end.`,
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

  // The clean (marker-stripped) text IS the chat reply. Always send it when
  // present. Markers fired in parallel above are bonus persistence —
  // journal entries, digests, new journal creation — not a substitute for
  // the chat reply.
  const chatText = clean.trim()
  const anyMarkerFired =
    appendedCount > 0 || journalCreates.length > 0 || digest !== null

  if (chatText.length > 0) {
    await initiate({ jid: task.jid, text: chatText })
  } else if (anyMarkerFired) {
    // Worker emitted only markers, no chat text. That's contract-breaking
    // (chat reply is the primary output) but recoverable — send a short
    // completion note so the owner isn't left with silence.
    const bits: string[] = []
    if (appendedCount > 0) {
      bits.push(`${appendedCount} journal ${appendedCount === 1 ? 'entry' : 'entries'}`)
    }
    if (journalCreates.length > 0) {
      bits.push(
        `${journalCreates.length} journal${journalCreates.length === 1 ? '' : 's'} created`,
      )
    }
    if (digest) bits.push('digest scheduled')
    await initiate({
      jid: task.jid,
      text: `Done. ${bits.join(', ')}.`,
    })
  }
  // Else: no chat text AND no markers — worker produced nothing. Log only.

  logger.info(
    {
      id: task.id,
      jid: task.jid,
      elapsed: elapsedLog(),
      appended: appendedCount,
      createdJournals: journalCreates.length,
      digestFired: !!digest,
      chatSent: chatText.length,
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

// ============================================================================
// BROWSER LANE
// ============================================================================
// A second async lane dedicated to browser work. Key differences vs the
// general async lane above:
//
// - Concurrency is 1. Serialized against itself because (a) the shared
//   Playwright MCP + Chrome is one physical resource, (b) the session below
//   is persistent and --resume doesn't allow concurrent resumes.
// - One GLOBAL persistent session stored at storage/browser-session.json.
//   First browser task bootstraps fresh (captures sessionId). Subsequent
//   tasks spawn with --resume <sessionId>, so the browser Claude carries
//   memory of prior tasks across runs.
// - Task description is added as a new user message to the persistent
//   session. The worker sees the accumulated history automatically.

function browserSessionFilePath(): string {
  return resolve(process.cwd(), config.memory.dir, 'browser-session.json')
}

type BrowserSessionState = {
  sessionId: string | null
  createdAt: number
  lastUsedAt: number
  resumeCount: number
}

function loadBrowserSession(): BrowserSessionState {
  const path = browserSessionFilePath()
  if (!existsSync(path)) {
    return { sessionId: null, createdAt: 0, lastUsedAt: 0, resumeCount: 0 }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BrowserSessionState>
    return {
      sessionId: parsed.sessionId ?? null,
      createdAt: parsed.createdAt ?? 0,
      lastUsedAt: parsed.lastUsedAt ?? 0,
      resumeCount: parsed.resumeCount ?? 0,
    }
  } catch {
    return { sessionId: null, createdAt: 0, lastUsedAt: 0, resumeCount: 0 }
  }
}

function saveBrowserSession(state: BrowserSessionState): void {
  const path = browserSessionFilePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

// Reset the browser session. Callable from outside if the session gets
// corrupted or we want a fresh start. Not wired into any command yet.
export function resetBrowserSession(): void {
  saveBrowserSession({
    sessionId: null,
    createdAt: 0,
    lastUsedAt: 0,
    resumeCount: 0,
  })
  logger.info('browser session reset')
}

const browserQueue: queueAsPromised<AsyncTask, void> = fastq.promise<
  unknown,
  AsyncTask,
  void
>(async (task) => {
  inProgress.set(task.id, task)
  try {
    await runBrowserTask(task)
  } catch (err) {
    logger.error(
      { err, id: task.id, jid: task.jid },
      'browser task failed unexpectedly',
    )
  } finally {
    inProgress.delete(task.id)
  }
}, 1)

export function enqueueBrowserTask(
  input: Omit<AsyncTask, 'id' | 'startedAt'>,
): AsyncTask {
  const task: AsyncTask = {
    ...input,
    id: `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Math.floor(Date.now() / 1000),
  }
  logger.info(
    {
      id: task.id,
      jid: task.jid,
      description: task.description.slice(0, 200),
    },
    'browser task enqueued',
  )
  browserQueue.push(task).catch((err) =>
    logger.error({ err, id: task.id }, 'browser queue push failed'),
  )
  return task
}

function buildBrowserPrompt(task: AsyncTask, isResume: boolean): string {
  // Framing tuned for the dedicated browser worker.
  const lines = [
    isResume
      ? `You are the BROWSER WORKER. Another task just came in. You already have memory of prior browser tasks in this session — act on it accordingly. Use the shared Chrome at localhost:9222 via Playwright MCP (already logged into the owner's sessions like TikTok, Instagram, etc. — do NOT log out, do NOT start a new browser instance).`
      : `You are the BROWSER WORKER. You run in a persistent session dedicated to browser tasks for the owner. The chat already got its ack; your output IS the follow-up chat reply the owner is waiting for. Use the shared Chrome at localhost:9222 via Playwright MCP (already authenticated with the owner's sessions — TikTok, Instagram, etc. — do NOT log out, do NOT launch a new browser).`,
    ``,
    `TASK:`,
    task.description,
    ``,
    `ORIGINAL USER MESSAGE (for reference):`,
    task.originatingMessage,
    ``,
    `Sender: ${task.senderName ?? task.senderNumber}`,
    ``,
    `HOW TO OUTPUT:`,
    `- Write the full answer as a natural chat reply. Same voice as the main chat Claude, just delayed.`,
    `- Open with a short "about the X you asked about..." reference — the owner may have asked for several things.`,
    `- Concrete findings only. Numbers, names, dates. If you found 10 creators, list them.`,
    `- Failure mode: page hung, login wall, bot-detection, empty feed — say so briefly. Do NOT fabricate.`,
    ``,
    `BAIL CONDITIONS (stop and report, don't burn the clock):`,
    `- Same tool call with same args retried 3 times → stuck, bail.`,
    `- 3 consecutive empty/error responses from the site → site is throttling, bail.`,
    `- Any single tool call running past 5 min → bail.`,
    `- Autonomy: pick and proceed on low-stakes choices (which hashtag first, which profile to open). For IRREVERSIBLE writes (DM send, post, purchase), do NOT act — stop and report candidates so the owner can confirm in chat.`,
    ``,
    `OPTIONAL MARKERS (at the END of your output):`,
    `- [JOURNAL:<slug> — <one-line finding>] per finding that belongs in an active journal.`,
    `- [JOURNAL-NEW:<slug> — <purpose>] if a clearly-recurring tracking surface doesn't have a journal yet.`,
    `- [DIGEST: <reason>] if a durable fact about the owner/chat came up.`,
    ``,
    `CONSTRAINTS:`,
    `- Do NOT emit [ASYNC:...] or [ASYNC-BROWSER:...]. No recursion.`,
    `- Markers are bonus persistence, not a substitute for the reply.`,
    `- Stay fully in character (personality).`,
    ``,
    `Do the work. Write the reply. Markers optional at the end.`,
  ]
  return lines.join('\n')
}

function buildBrowserArgs(task: AsyncTask, sessionId: string | null): string[] {
  const args: string[] = [
    '-p',
    '--output-format',
    'json',
    '--model',
    config.claude.model,
    '--permission-mode',
    'acceptEdits',
  ]
  if (sessionId) {
    // Resume — system prompt and memory-dirs are already baked into session
    args.push('--resume', sessionId)
  } else {
    // First call — bootstrap the persistent session
    args.push('--append-system-prompt', systemPrompt())
    for (const dir of config.claude.addDirs) {
      args.push('--add-dir', resolve(process.cwd(), dir))
    }
  }
  // Memory + media dirs re-added each call (harmless if already baked; needed
  // on fresh bootstrap; lets the browser worker Read updated memory files
  // between turns).
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

async function runBrowserTask(task: AsyncTask): Promise<void> {
  const session = loadBrowserSession()
  const isResume = !!session.sessionId
  const prompt = buildBrowserPrompt(task, isResume)
  const args = buildBrowserArgs(task, session.sessionId)
  const startedAtMs = Date.now()
  const elapsedLog = () =>
    `${Math.round((Date.now() - task.startedAt * 1000) / 1000)}s`

  let stdout: string
  let durationMs: number
  try {
    const result = await runClaude({
      args,
      input: prompt,
      timeoutMs: TIMEOUT_MS.async,
      caller: 'browser-task',
    })
    stdout = result.stdout
    durationMs = result.durationMs
  } catch (err) {
    logger.error(
      { err, id: task.id, jid: task.jid, elapsed: elapsedLog() },
      'browser task claude call failed',
    )
    await initiate({
      jid: task.jid,
      text: `Heads up: the browser task "${truncate(
        task.description,
        80,
      )}" failed. Ask me again and I'll retry.`,
    })
    return
  }

  let parsed: ClaudeJsonOutput
  try {
    parsed = JSON.parse(stdout) as ClaudeJsonOutput
  } catch (err) {
    logger.error(
      { err, id: task.id },
      'browser task: failed to parse claude output',
    )
    await initiate({
      jid: task.jid,
      text: `Heads up: the browser task "${truncate(
        task.description,
        80,
      )}" returned an unparseable response.`,
    })
    return
  }
  if (parsed.is_error || parsed.subtype !== 'success' || !parsed.result) {
    logger.error(
      { parsed, id: task.id },
      'browser task bad output',
    )
    await initiate({
      jid: task.jid,
      text: `Heads up: the browser task "${truncate(
        task.description,
        80,
      )}" returned an error.`,
    })
    return
  }

  // Persist the session id. On first call Claude returns the new sessionId;
  // on resume it may return the same or a rotated one.
  const returnedSessionId = parsed.session_id ?? null
  if (returnedSessionId) {
    const now = Math.floor(Date.now() / 1000)
    saveBrowserSession({
      sessionId: returnedSessionId,
      createdAt: session.createdAt || now,
      lastUsedAt: now,
      resumeCount: (session.resumeCount ?? 0) + (isResume ? 1 : 0),
    })
  }

  void logPrompt({
    ts: Math.floor(startedAtMs / 1000),
    caller: 'browser-task',
    args,
    input: prompt,
    output: parsed.result,
    sessionId: returnedSessionId ?? undefined,
    durationMs,
  })

  // Route markers the same way the general async lane does.
  const { extractFlags } = await import('../memory/digest-flag.js')
  const { clean, digest, journals, journalCreates } = extractFlags(
    parsed.result,
  )

  const { appendEntry, createJournal, getJournal, isValidSlug } =
    await import('../memory/journals.js')
  for (const op of journalCreates) {
    if (!isValidSlug(op.slug)) continue
    if (getJournal(op.slug)) continue
    try {
      createJournal({
        slug: op.slug,
        name: titleCaseSlug(op.slug),
        purpose: op.purpose,
      })
      logger.info(
        { slug: op.slug, id: task.id },
        'journal created via browser task marker',
      )
    } catch (err) {
      logger.error({ err, op, id: task.id }, 'browser JOURNAL-NEW failed')
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
  }
  if (digest) {
    const { scheduleDigest } = await import('../memory/scheduler.js')
    scheduleDigest({
      jid: task.jid,
      number: task.senderNumber,
      reason: digest,
    })
  }

  const chatText = clean.trim()
  if (chatText.length > 0) {
    await initiate({ jid: task.jid, text: chatText })
  } else if (
    appendedCount > 0 ||
    journalCreates.length > 0 ||
    digest !== null
  ) {
    const bits: string[] = []
    if (appendedCount > 0) {
      bits.push(`${appendedCount} journal ${appendedCount === 1 ? 'entry' : 'entries'}`)
    }
    if (journalCreates.length > 0) {
      bits.push(
        `${journalCreates.length} journal${journalCreates.length === 1 ? '' : 's'} created`,
      )
    }
    if (digest) bits.push('digest scheduled')
    await initiate({ jid: task.jid, text: `Done. ${bits.join(', ')}.` })
  }

  logger.info(
    {
      id: task.id,
      jid: task.jid,
      elapsed: elapsedLog(),
      isResume,
      appended: appendedCount,
      createdJournals: journalCreates.length,
      digestFired: !!digest,
      chatSent: chatText.length,
    },
    'browser task completed',
  )
}
