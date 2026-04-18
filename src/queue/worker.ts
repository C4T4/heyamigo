import { askClaude } from '../ai/claude.js'
import { clearSession, setSession, setUsage } from '../ai/sessions.js'
import { logger } from '../logger.js'
import { extractFlags } from '../memory/digest-flag.js'
import { appendEntry } from '../memory/journals.js'
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

  const { clean, digest, journals } = extractFlags(reply)
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
