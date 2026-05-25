import { getProvider } from '../ai/providers.js'
import {
  clearSession,
  getSessionInfo,
  setSession,
  setUsage,
} from '../ai/sessions.js'
import { config } from '../config.js'
import { formatAddress, jidToAddress } from '../db/address.js'
import { logger } from '../logger.js'
import { addDailyTokens } from '../store/usage.js'
import { estimate as estimateJob } from '../estimates/index.js'
import { extractFlags, filterFlagsByRole } from '../memory/digest-flag.js'
import { isValidSlug } from '../memory/journals.js'
import { enqueueAsyncTask, enqueueBrowserTask } from './async-tasks.js'
import { enqueueCron } from './crons.js'
import { enqueueMemoryWrite } from './memory-writes.js'
import { enqueueOutbound } from './outbound.js'
import type { Job, JobCard, Result } from './types.js'

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
  // Capture prior session usage BEFORE the ask call so we can compute
  // per-turn deltas regardless of the provider's reporting mode.
  const priorUsage = getSessionInfo(job.jid, provider.name)?.usage
  const { reply, sessionId, usage } = await provider.ask({
    input: job.input,
    sessionId: job.sessionId,
    allowedTools: job.allowedTools,
  })
  const durationMs = Date.now() - startedAt

  if (!job.sessionId) {
    setSession(job.jid, provider.name, sessionId)
  }

  // Reconcile per-turn vs cumulative reporting. See AiProvider
  // .usageReportingMode for context. For cumulative providers (Codex),
  // the reported usage = whole-thread totals; we subtract the prior
  // cumulative to get this turn's cost. For per-turn providers
  // (Claude), the reported usage IS this turn's cost; we sum into
  // the running cumulative.
  //
  // Fallback baseline: if cumulative* fields aren't stored yet
  // (first turn after this fix deploys), use the prior plain field
  // values. That treats the existing buggy-cumulative storage as the
  // baseline so the next delta is accurate.
  const baseCumInput =
    priorUsage?.cumulativeInputTokens ?? priorUsage?.inputTokens ?? 0
  const baseCumCacheRead =
    priorUsage?.cumulativeCacheReadTokens ?? priorUsage?.cacheReadTokens ?? 0
  const baseCumCacheCreate =
    priorUsage?.cumulativeCacheCreationTokens ?? priorUsage?.cacheCreationTokens ?? 0
  const baseCumOutput =
    priorUsage?.cumulativeOutputTokens ?? priorUsage?.outputTokens ?? 0

  let turnInput: number
  let turnCacheRead: number
  let turnCacheCreate: number
  let turnOutput: number
  let newCumInput: number
  let newCumCacheRead: number
  let newCumCacheCreate: number
  let newCumOutput: number

  if (provider.usageReportingMode === 'cumulative') {
    // Reported usage IS the cumulative total. Delta = current - prev.
    // Math.max(0, …) protects against the rare case where the CLI's
    // counter resets (e.g. fresh session that we still tracked) —
    // never display negative deltas.
    newCumInput        = usage.inputTokens
    newCumCacheRead    = usage.cacheReadTokens
    newCumCacheCreate  = usage.cacheCreationTokens
    newCumOutput       = usage.outputTokens
    turnInput          = Math.max(0, newCumInput        - baseCumInput)
    turnCacheRead      = Math.max(0, newCumCacheRead    - baseCumCacheRead)
    turnCacheCreate    = Math.max(0, newCumCacheCreate  - baseCumCacheCreate)
    turnOutput         = Math.max(0, newCumOutput       - baseCumOutput)
  } else {
    // Reported usage IS per-turn already. Accumulate into cumulative.
    turnInput          = usage.inputTokens
    turnCacheRead      = usage.cacheReadTokens
    turnCacheCreate    = usage.cacheCreationTokens
    turnOutput         = usage.outputTokens
    newCumInput        = baseCumInput        + turnInput
    newCumCacheRead    = baseCumCacheRead    + turnCacheRead
    newCumCacheCreate  = baseCumCacheCreate  + turnCacheCreate
    newCumOutput       = baseCumOutput       + turnOutput
  }

  // totalContextTokens is the PROMPT side (input + cache reads + cache
  // creation). Output is response, not context. The old code included
  // outputTokens here which was wrong.
  const totalContextTokens = turnInput + turnCacheRead + turnCacheCreate

  setUsage(job.jid, provider.name, {
    inputTokens:                 turnInput,
    cacheReadTokens:             turnCacheRead,
    cacheCreationTokens:         turnCacheCreate,
    outputTokens:                turnOutput,
    totalContextTokens,
    numTurns:                    usage.numTurns,
    cumulativeInputTokens:       newCumInput,
    cumulativeCacheReadTokens:   newCumCacheRead,
    cumulativeCacheCreationTokens: newCumCacheCreate,
    cumulativeOutputTokens:      newCumOutput,
    updatedAt: Math.floor(Date.now() / 1000),
  })

  // Per-user daily token accounting. Owner sender is exempt by check at the
  // incoming gate, but we still bill so /usage reflects reality if added.
  // Cache-read tokens are excluded — they don't cost real budget.
  if (job.senderNumber) {
    addDailyTokens(job.senderNumber, turnInput + turnOutput)
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
    crons,
    reminds,
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
  //
  // For each delegation, we also build a "job card" — a short ETA
  // message that handleReply will emit after the agent's reply
  // chunks. Gives the user a visible "doing X, ~Y min" instead of
  // wondering whether anything's happening.
  const jobCards: JobCard[] = []
  const cardBase = `card-${job.jid}-${Date.now()}`
  for (let i = 0; i < asyncTasks.length; i++) {
    const t = asyncTasks[i]!
    enqueueAsyncTask({
      jid: job.jid,
      senderNumber: job.senderNumber,
      description: t.description,
      originatingMessage: job.text,
      allowedTools: job.allowedTools ?? 'all',
    })
    const est = estimateJob({
      description: t.description,
      taskKind: 'async',
    })
    if (est) {
      jobCards.push({
        text: formatJobCard(est.text, t.description),
        idempotencyKey: `${cardBase}-async-${i}`,
      })
    }
  }
  for (let i = 0; i < asyncBrowserTasks.length; i++) {
    const t = asyncBrowserTasks[i]!
    enqueueBrowserTask({
      jid: job.jid,
      senderNumber: job.senderNumber,
      description: t.description,
      originatingMessage: job.text,
      allowedTools: job.allowedTools ?? 'all',
    })
    const est = estimateJob({
      description: t.description,
      taskKind: 'async-browser',
    })
    if (est) {
      jobCards.push({
        text: formatJobCard(est.text, t.description),
        idempotencyKey: `${cardBase}-browser-${i}`,
      })
    }
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

  // [CRON: @every X — body] and [REMIND: in Nu — body] create cron
  // rows that fire into outbound at their scheduled time. The
  // originating chat (job.jid) is the destination for both.
  const chatAddress = formatAddress(jidToAddress(job.jid))
  const cronBase = `chat-cron-${job.jid}-${Date.now()}`
  for (let i = 0; i < crons.length; i++) {
    const c = crons[i]!
    try {
      enqueueCron({
        name:        `${cronBase}-${i}`,
        enqueueInto: 'outbound',
        payload:     { address: chatAddress, kind: 'text', text: c.body },
        recurrence:  c.recurrence,
      })
      logger.info(
        { jid: job.jid, recurrence: c.recurrence, chars: c.body.length },
        'CRON tag scheduled',
      )
    } catch (err) {
      logger.warn(
        { err, jid: job.jid, recurrence: c.recurrence },
        'CRON tag failed (bad recurrence?)',
      )
    }
  }
  const remindBase = `chat-remind-${job.jid}-${Date.now()}`
  for (let i = 0; i < reminds.length; i++) {
    const r = reminds[i]!
    enqueueCron({
      name:        `${remindBase}-${i}`,
      enqueueInto: 'outbound',
      payload:     { address: chatAddress, kind: 'text', text: r.body },
      recurrence:  null,
      firstRunAt:  Math.floor(Date.now() / 1000) + r.whenSecondsFromNow,
    })
    logger.info(
      { jid: job.jid, inSeconds: r.whenSecondsFromNow, chars: r.body.length },
      'REMIND tag scheduled',
    )
  }

  return {
    reply: clean,
    stats: {
      durationMs,
      // All per-turn values now (delta-corrected for cumulative
      // providers above). Footer shows these directly.
      inputTokens: turnInput,
      outputTokens: turnOutput,
      cacheReadTokens: turnCacheRead,
      totalContextTokens,
      contextWindow: config.claude.contextWindow,
      fresh: wasFresh,
      hasDigest: digest !== null,
      journalSlugs: journals.map((j) => j.slug),
      asyncCount: asyncTasks.length + asyncBrowserTasks.length,
    },
    jobCards: jobCards.length > 0 ? jobCards : undefined,
  }
}

// Compact card text. Emoji + ETA + a brief excerpt of what the agent
// delegated, so the user knows which job each card refers to when
// multiple are running.
function formatJobCard(etaText: string, description: string): string {
  const excerpt = description.length > 100
    ? description.slice(0, 97) + '...'
    : description
  return `🔄 ${etaText}\n${excerpt}`
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
