import { getProvider } from '../ai/providers.js'
import { clearSession, setSession, setUsage } from '../ai/sessions.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { addDailyTokens } from '../store/usage.js'
import { extractFlags, filterFlagsByRole } from '../memory/digest-flag.js'
import { isValidSlug } from '../memory/journals.js'
import { enqueueAsyncTask, enqueueBrowserTask } from './async-tasks.js'
import { enqueueMemoryWrite } from './memory-writes.js'
import { enqueueOutbound } from './outbound.js'
import type { Job, Result } from './types.js'

function isStaleSessionError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes('No conversation found')
  )
}

async function callClaude(job: Job): Promise<Result> {
  const startedAt = Date.now()
  const wasFresh = !job.sessionId
  const provider = getProvider()
  const { reply, sessionId, usage } = await provider.ask({
    input: job.input,
    sessionId: job.sessionId,
    allowedTools: job.allowedTools,
  })
  const durationMs = Date.now() - startedAt

  if (!job.sessionId) {
    setSession(job.jid, provider.name, sessionId)
  }

  const totalContextTokens =
    usage.inputTokens +
    usage.cacheReadTokens +
    usage.cacheCreationTokens +
    usage.outputTokens
  setUsage(job.jid, provider.name, {
    ...usage,
    totalContextTokens,
    updatedAt: Math.floor(Date.now() / 1000),
  })

  // Per-user daily token accounting. Owner sender is exempt by check at the
  // incoming gate, but we still bill so /usage reflects reality if added.
  // Cache-read tokens are excluded — they don't cost real budget.
  if (job.senderNumber) {
    addDailyTokens(job.senderNumber, usage.inputTokens + usage.outputTokens)
  }

  const rawFlags = extractFlags(reply)
  const {
    clean,
    digest,
    journals,
    journalCreates,
    asyncTasks,
    asyncBrowserTasks,
    sendTexts,
  } = filterFlagsByRole(rawFlags, job.allowedTags)
  // Detect any stripped tags so we can log + nudge the role config
  // if a user is repeatedly hitting the gate.
  const stripped: string[] = []
  if (rawFlags.digest && !digest) stripped.push('DIGEST')
  if (rawFlags.journals.length !== journals.length) stripped.push('JOURNAL')
  if (rawFlags.journalCreates.length !== journalCreates.length)
    stripped.push('JOURNAL-NEW')
  if (rawFlags.asyncTasks.length !== asyncTasks.length) stripped.push('ASYNC')
  if (rawFlags.asyncBrowserTasks.length !== asyncBrowserTasks.length)
    stripped.push('ASYNC-BROWSER')
  if (rawFlags.sendTexts.length !== sendTexts.length) stripped.push('SEND-TEXT')
  if (stripped.length > 0) {
    logger.warn(
      { jid: job.jid, senderNumber: job.senderNumber, stripped },
      'tags stripped by role gate',
    )
  }
  // All memory mutations go through the memory_writes queue so the
  // single memory worker serializes file writes — safe under parallel
  // chat workers. Idempotency keys derived from job + index so a
  // retry doesn't duplicate.
  const memBase = `chat-${job.jid}-${Date.now()}`
  if (digest) {
    logger.info(
      { jid: job.jid, number: job.senderNumber, reason: digest },
      'DIGEST flag raised, scheduling',
    )
    enqueueMemoryWrite({
      op: 'trigger_digest',
      payload: { jid: job.jid, number: job.senderNumber, reason: digest },
      idempotencyKey: `${memBase}-digest`,
    })
  }
  // Creates run BEFORE entry appends so that a reply creating a new journal
  // AND flagging its first entry in the same turn works correctly. The
  // memory worker enforces this ordering because it drains serially in
  // insert order.
  for (let i = 0; i < journalCreates.length; i++) {
    const op = journalCreates[i]!
    if (!isValidSlug(op.slug)) {
      logger.warn(
        { op, jid: job.jid },
        'JOURNAL-NEW: invalid slug, dropped',
      )
      continue
    }
    enqueueMemoryWrite({
      op: 'create_journal',
      payload: { slug: op.slug, name: titleCase(op.slug), purpose: op.purpose },
      idempotencyKey: `${memBase}-create-${i}`,
    })
  }
  for (let i = 0; i < journals.length; i++) {
    const j = journals[i]!
    enqueueMemoryWrite({
      op: 'append_journal',
      payload: {
        slug: j.slug,
        entry: {
          source: 'reactive',
          jid: job.jid,
          senderNumber: job.senderNumber,
          note: j.note,
        },
      },
      idempotencyKey: `${memBase}-append-${i}`,
    })
  }

  // Async tasks: Claude delegated to background workers. Chat reply above
  // is the user-facing ack. Two lanes:
  //   [ASYNC:...] → general lane, stateless, concurrency 3, non-browser work
  //   [ASYNC-BROWSER:...] → browser lane, persistent session, concurrency 1
  // Both report back via initiate() when done.
  for (const t of asyncTasks) {
    enqueueAsyncTask({
      jid: job.jid,
      senderNumber: job.senderNumber,
      description: t.description,
      originatingMessage: job.text,
      allowedTools: job.allowedTools ?? 'all',
    })
  }
  for (const t of asyncBrowserTasks) {
    enqueueBrowserTask({
      jid: job.jid,
      senderNumber: job.senderNumber,
      description: t.description,
      originatingMessage: job.text,
      allowedTools: job.allowedTools ?? 'all',
    })
  }
  // SEND-TEXT: cross-chat text send. Agent specified the destination
  // address explicitly. Just drops a row in outbound; sender worker
  // dispatches by channel.
  for (let i = 0; i < sendTexts.length; i++) {
    const t = sendTexts[i]!
    enqueueOutbound({
      address: t.address,
      kind:    'text',
      text:    t.body,
      idempotencyKey: `sendtext-${job.jid}-${Date.now()}-${i}`,
    })
    logger.info(
      { from: job.jid, to: t.address, chars: t.body.length },
      'SEND-TEXT enqueued',
    )
  }

  return {
    reply: clean,
    stats: {
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      totalContextTokens,
      contextWindow: config.claude.contextWindow,
      fresh: wasFresh,
      hasDigest: digest !== null,
      journalSlugs: journals.map((j) => j.slug),
      asyncCount: asyncTasks.length + asyncBrowserTasks.length,
    },
  }
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join(' ')
}

export async function processJob(job: Job): Promise<Result> {
  try {
    return await callClaude(job)
  } catch (err) {
    if (job.sessionId && isStaleSessionError(err)) {
      logger.warn(
        { jid: job.jid, staleId: job.sessionId },
        'stale session detected, clearing and retrying with fresh bootstrap',
      )
      clearSession(job.jid, getProvider().name)
      return callClaude({ ...job, sessionId: undefined, allowedTools: job.allowedTools })
    }
    throw err
  }
}
