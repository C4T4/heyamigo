import { askClaude } from '../ai/claude.js'
import { clearSession, setSession, setUsage } from '../ai/sessions.js'
import { logger } from '../logger.js'
import { extractDigestFlag } from '../memory/digest-flag.js'
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

  const { clean, flag } = extractDigestFlag(reply)
  if (flag) {
    logger.info(
      { jid: job.jid, number: job.senderNumber, reason: flag },
      'DIGEST flag raised, scheduling',
    )
    scheduleDigest({
      jid: job.jid,
      number: job.senderNumber,
      reason: flag,
    })
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
