import { askClaude } from '../ai/claude.js'
import { clearSession, setSession, setUsage } from '../ai/sessions.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { extractFlags } from '../memory/digest-flag.js'
import {
  appendEntry,
  createJournal,
  getJournal,
  isValidSlug,
} from '../memory/journals.js'
import { scheduleDigest } from '../memory/scheduler.js'
import { enqueueAsyncTask, enqueueBrowserTask } from './async-tasks.js'
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
  const { reply, sessionId, usage } = await askClaude({
    input: job.input,
    sessionId: job.sessionId,
    allowedTools: job.allowedTools,
  })
  const durationMs = Date.now() - startedAt

  if (!job.sessionId) {
    setSession(job.jid, sessionId)
  }

  const totalContextTokens =
    usage.inputTokens +
    usage.cacheReadTokens +
    usage.cacheCreationTokens +
    usage.outputTokens
  setUsage(job.jid, {
    ...usage,
    totalContextTokens,
    updatedAt: Math.floor(Date.now() / 1000),
  })

  const {
    clean,
    digest,
    journals,
    journalCreates,
    asyncTasks,
    asyncBrowserTasks,
  } = extractFlags(reply)
  if (digest) {
    logger.info(
      { jid: job.jid, number: job.senderNumber, reason: digest },
      'DIGEST flag raised, scheduling',
    )
    scheduleDigest({
      jid: job.jid,
      number: job.senderNumber,
      reason: digest,
    })
  }
  // Creates run BEFORE entry appends so that a reply creating a new journal
  // AND flagging its first entry in the same turn works correctly.
  for (const op of journalCreates) {
    if (!isValidSlug(op.slug)) {
      logger.warn(
        { op, jid: job.jid },
        'JOURNAL-NEW: invalid slug, dropped',
      )
      continue
    }
    try {
      if (getJournal(op.slug)) {
        logger.info(
          { slug: op.slug },
          'JOURNAL-NEW for existing slug, ignored',
        )
        continue
      }
      createJournal({
        slug: op.slug,
        name: titleCase(op.slug),
        purpose: op.purpose,
      })
      logger.info(
        { slug: op.slug, jid: job.jid },
        'journal created via bot marker',
      )
    } catch (err) {
      logger.error(
        { err, op, jid: job.jid },
        'JOURNAL-NEW failed',
      )
    }
  }
  for (const j of journals) {
    const ok = appendEntry(j.slug, {
      source: 'reactive',
      jid: job.jid,
      senderNumber: job.senderNumber,
      note: j.note,
    })
    if (!ok) {
      logger.warn(
        { slug: j.slug, jid: job.jid },
        'JOURNAL flag pointed at unknown slug, dropped',
      )
    }
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
      clearSession(job.jid)
      return callClaude({ ...job, sessionId: undefined, allowedTools: job.allowedTools })
    }
    throw err
  }
}
