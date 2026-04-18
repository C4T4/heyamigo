import { askClaude } from '../ai/claude.js'
import { clearSession, setSession, setUsage } from '../ai/sessions.js'
import { logger } from '../logger.js'
import { extractFlags } from '../memory/digest-flag.js'
import {
  appendEntry,
  createJournal,
  getJournal,
  isValidSlug,
  updateJournalStatus,
} from '../memory/journals.js'
import { scheduleDigest } from '../memory/scheduler.js'
import type { Job, Result } from './types.js'

function isStaleSessionError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes('No conversation found')
  )
}

async function callClaude(job: Job): Promise<Result> {
  const { reply, sessionId, usage } = await askClaude({
    input: job.input,
    sessionId: job.sessionId,
    allowedTools: job.allowedTools,
  })

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

  const { clean, digest, journals, lifecycleOps } = extractFlags(reply)
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
  // Lifecycle ops run BEFORE entry appends so that a reply creating a new
  // journal AND flagging its first entry in the same turn works correctly.
  for (const op of lifecycleOps) {
    if (!isValidSlug(op.slug)) {
      logger.warn(
        { op, jid: job.jid },
        'journal lifecycle op: invalid slug, dropped',
      )
      continue
    }
    try {
      if (op.kind === 'new') {
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
      } else {
        const status =
          op.kind === 'pause'
            ? 'paused'
            : op.kind === 'archive'
              ? 'archived'
              : 'active'
        const updated = updateJournalStatus(op.slug, status)
        if (updated) {
          logger.info(
            { slug: op.slug, status, jid: job.jid },
            'journal status updated via bot marker',
          )
        } else {
          logger.warn(
            { op, jid: job.jid },
            'journal lifecycle op: unknown slug, dropped',
          )
        }
      }
    } catch (err) {
      logger.error(
        { err, op, jid: job.jid },
        'journal lifecycle op failed',
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

  return { reply: clean }
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
