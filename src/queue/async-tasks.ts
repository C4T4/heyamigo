import { resolve } from 'path'
import { getProvider } from '../ai/providers.js'
import { formatAddress, jidToAddress } from '../db/address.js'
import { config } from '../config.js'
import fastq from 'fastq'
import type { queueAsPromised } from 'fastq'
import { initiate } from '../gateway/outgoing.js'
import { logger } from '../logger.js'
import { enqueueBrowserJob } from './browser-queue.js'

export type AsyncTask = {
  id: string
  jid: string
  address?: string
  senderNumber: string
  senderName?: string
  description: string
  originatingMessage: string
  allowedTools: string[] | 'all'
  startedAt: number
}

// Concurrency: how many async workers can run simultaneously.
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
  logger.info(
    {
      id: task.id,
      jid: task.jid,
      address: task.address,
      description: task.description.slice(0, 200),
    },
    'async task claimed from queue',
  )
  inProgress.set(task.id, task)
  try {
    await executeAsyncTask(task)
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

function fileDeliveryLines(): string[] {
  const outboxPath = resolve('storage/outbox')
  return [
    `FILE DELIVERY:`,
    `- If this worker creates, edits, exports, or generates files, save final files under ${outboxPath}/.`,
    `- Deliver each final file with [IMAGE|VIDEO|AUDIO|DOCUMENT: /absolute/path].`,
    `- If no file was produced, say that plainly.`,
  ]
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
    ...fileDeliveryLines(),
    ``,
    `OPTIONAL MARKERS (at the END of your output, same pattern as main chat):`,
    `- [JOURNAL:<slug> — <one-line finding>] for any finding that belongs in an active journal. These run IN ADDITION to your chat reply — they file structured entries in journals/<slug>/entries.jsonl for future reference, dedup, and cross-session memory. Use existing slugs only (check [Journals: active] in your preamble). ONE marker per finding.`,
    `- [JOURNAL-NEW:<slug> — <one-line purpose>] if the task clearly deserves a new journal that doesn't exist yet. Conservative — only when the topic is a recurring tracking surface, not a one-off.`,
    `- [DIGEST: <one-line reason>] if you learned something durable about the owner or chat that should update the profile/brief.`,
    ``,
    `CONSTRAINTS:`,
    `- You are already the async worker. Do the task here, including file work.`,
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

function asyncTaskAddDirs(): string[] {
  return [
    ...config.claude.addDirs,
    config.memory.dir,
    config.storage.mediaDir,
  ]
}

async function executeAsyncTask(task: AsyncTask): Promise<void> {
  const prompt = buildPrompt(task)
  const elapsedLog = () =>
    `${Math.round((Date.now() - task.startedAt * 1000) / 1000)}s`
  let output: string
  try {
    const { reply } = await getProvider().runTask({
      input: prompt,
      caller: 'async-task',
      mode: 'auto',
      lane: 'async',
      includeSystemPrompt: true,
      addDirs: asyncTaskAddDirs(),
      allowedTools: task.allowedTools,
    })
    output = reply
  } catch (err) {
    logger.error(
      { err, id: task.id, jid: task.jid, elapsed: elapsedLog() },
      'async task claude call failed',
    )
    await initiate({
      jid: task.jid,
      address: task.address,
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
  const { clean, digest, journals, journalCreates, sendTexts } = extractFlags(output)

  // SEND-TEXT: async task wants to text a different chat too.
  if (sendTexts.length > 0) {
    const { enqueueOutbound } = await import('./outbound.js')
    for (let i = 0; i < sendTexts.length; i++) {
      const t = sendTexts[i]!
      enqueueOutbound({
        address: t.address,
        kind:    'text',
        text:    t.body,
        idempotencyKey: `async-sendtext-${task.id}-${i}`,
      })
    }
  }

  // All memory mutations through memory_writes queue (Phase 5a).
  const { enqueueMemoryWrite } = await import('./memory-writes.js')
  const { isValidSlug } = await import('../memory/journals.js')
  const memBase = `async-${task.id}`
  for (let i = 0; i < journalCreates.length; i++) {
    const op = journalCreates[i]!
    if (!isValidSlug(op.slug)) {
      logger.warn({ op, id: task.id }, 'async JOURNAL-NEW: invalid slug, dropped')
      continue
    }
    enqueueMemoryWrite({
      op: 'create_journal',
      payload: { slug: op.slug, name: titleCaseSlug(op.slug), purpose: op.purpose },
      idempotencyKey: `${memBase}-create-${i}`,
    })
  }
  // Treat enqueued appends as "appended" for the reporting line below;
  // the memory worker logs the actual append+slug-validity outcomes.
  let appendedCount = 0
  for (let i = 0; i < journals.length; i++) {
    const j = journals[i]!
    enqueueMemoryWrite({
      op: 'append_journal',
      payload: {
        slug: j.slug,
        entry: {
          source: 'async',
          jid: task.jid,
          senderNumber: task.senderNumber,
          note: j.note,
        },
      },
      idempotencyKey: `${memBase}-append-${i}`,
    })
    appendedCount++
  }
  if (digest) {
    enqueueMemoryWrite({
      op: 'trigger_digest',
      payload: { jid: task.jid, number: task.senderNumber, reason: digest },
      idempotencyKey: `${memBase}-digest`,
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
    await initiate({ jid: task.jid, address: task.address, text: chatText })
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
      address: task.address,
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
//   is one physical resource.
// - Persistent agent session DROPPED in Phase 4 — multiple browser
//   tasks now run concurrently, each in its own Chrome tab, each as
//   a fresh agent. Cross-task agent memory was rarely load-bearing
//   (the chat-track agent writes self-contained task descriptions).
//   Per-task tab isolation is enforced by the prompt instructions
//   below.

// Browser tasks now go into the durable browser_tasks SQLite table.
// The browser worker pool (src/queue/browser-worker.ts) drains it.
// In-flight tasks survive process crashes; the orchestrator reclaims
// stuck claims via the TTL on the table.
export function enqueueBrowserTask(
  input: Omit<AsyncTask, 'id' | 'startedAt'>,
): AsyncTask {
  // Keep AsyncTask shape exported so existing callers (worker.ts)
  // don't change. The returned id is informational only — the real
  // row id is the DB auto-increment.
  const task: AsyncTask = {
    ...input,
    id: `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Math.floor(Date.now() / 1000),
  }
  enqueueBrowserJob({
    address:            task.address ?? formatAddress(jidToAddress(task.jid)),
    description:        task.description,
    originatingMessage: task.originatingMessage,
    senderNumber:       task.senderNumber,
    senderName:         task.senderName ?? null,
    allowedTools:       task.allowedTools,
  })
  logger.info(
    {
      id: task.id,
      jid: task.jid,
      description: task.description.slice(0, 200),
    },
    'browser task enqueued',
  )
  return task
}

function buildBrowserPrompt(task: AsyncTask): string {
  // Framing tuned for the dedicated browser worker. Each task is its
  // own fresh agent run (no persistent session) — multiple browser
  // tasks may be running in parallel on the same Chrome, each in its
  // own tab.
  const lines = [
    `You are the BROWSER WORKER. The chat already got its ack; your output IS the follow-up chat reply the owner is waiting for. Use the shared Chrome at localhost:9222 via Playwright MCP (already authenticated with the owner's sessions — TikTok, Instagram, etc. — do NOT log out, do NOT launch a new browser).`,
    ``,
    `TAB OWNERSHIP: Other browser workers may be running concurrently on the SAME Chrome instance, each driving its own tab. Your FIRST action is to open a new tab for this task (browser_tabs with action=new). Operate ONLY on that tab for the rest of the task. Do NOT switch to or interact with tabs you didn't open — they belong to other workers. Close your tab when you finish.`,
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
    ...fileDeliveryLines(),
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
    `- You are already the browser worker. Do the browser task here.`,
    `- Do NOT emit [ASYNC:...] or [ASYNC-BROWSER:...]. No recursion.`,
    `- Markers are bonus persistence, not a substitute for the reply.`,
    `- Stay fully in character (personality).`,
    ``,
    `Do the work. Write the reply. Markers optional at the end.`,
  ]
  return lines.join('\n')
}

function browserAddDirs(): string[] {
  return [
    ...config.claude.addDirs,
    config.memory.dir,
    config.storage.mediaDir,
  ]
}

// Exported so the browser worker (src/queue/browser-worker.ts) can
// invoke it for each claimed row. Body unchanged from the pre-queue
// version — just rehomed for direct invocation by the pool.
export async function runBrowserTask(task: AsyncTask): Promise<void> {
  const provider = getProvider()
  // Each task is fresh (Phase 4 browser parallelism). No persistent
  // session — would force serialization on concurrent tasks.
  // Chat-track agent writes self-contained task descriptions, so the
  // worker doesn't need cross-task agent memory.
  const prompt = buildBrowserPrompt(task)
  const elapsedLog = () =>
    `${Math.round((Date.now() - task.startedAt * 1000) / 1000)}s`

  let reply: string
  try {
    const result = await provider.runTask({
      input: prompt,
      caller: 'browser-task',
      mode: 'auto',
      lane: 'async',
      includeSystemPrompt: true,
      addDirs: browserAddDirs(),
      allowedTools: task.allowedTools,
    })
    reply = result.reply
  } catch (err) {
    logger.error(
      { err, id: task.id, jid: task.jid, elapsed: elapsedLog() },
      'browser task provider call failed',
    )
    await initiate({
      jid: task.jid,
      address: task.address,
      text: `Heads up: the browser task "${truncate(
        task.description,
        80,
      )}" failed. Ask me again and I'll retry.`,
    })
    return
  }

  // Route markers the same way the general async lane does.
  const { extractFlags } = await import('../memory/digest-flag.js')
  const { clean, digest, journals, journalCreates, sendTexts } = extractFlags(reply)

  if (sendTexts.length > 0) {
    const { enqueueOutbound } = await import('./outbound.js')
    for (let i = 0; i < sendTexts.length; i++) {
      const t = sendTexts[i]!
      enqueueOutbound({
        address: t.address,
        kind:    'text',
        text:    t.body,
        idempotencyKey: `browser-sendtext-${task.id}-${i}`,
      })
    }
  }

  const { enqueueMemoryWrite } = await import('./memory-writes.js')
  const { isValidSlug } = await import('../memory/journals.js')
  const memBase = `browser-${task.id}`
  for (let i = 0; i < journalCreates.length; i++) {
    const op = journalCreates[i]!
    if (!isValidSlug(op.slug)) continue
    enqueueMemoryWrite({
      op: 'create_journal',
      payload: { slug: op.slug, name: titleCaseSlug(op.slug), purpose: op.purpose },
      idempotencyKey: `${memBase}-create-${i}`,
    })
  }
  let appendedCount = 0
  for (let i = 0; i < journals.length; i++) {
    const j = journals[i]!
    enqueueMemoryWrite({
      op: 'append_journal',
      payload: {
        slug: j.slug,
        entry: {
          source: 'async',
          jid: task.jid,
          senderNumber: task.senderNumber,
          note: j.note,
        },
      },
      idempotencyKey: `${memBase}-append-${i}`,
    })
    appendedCount++
  }
  if (digest) {
    enqueueMemoryWrite({
      op: 'trigger_digest',
      payload: { jid: task.jid, number: task.senderNumber, reason: digest },
      idempotencyKey: `${memBase}-digest`,
    })
  }

  const chatText = clean.trim()
  if (chatText.length > 0) {
    await initiate({ jid: task.jid, address: task.address, text: chatText })
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
    await initiate({
      jid: task.jid,
      address: task.address,
      text: `Done. ${bits.join(', ')}.`,
    })
  }

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
    'browser task completed',
  )
}
