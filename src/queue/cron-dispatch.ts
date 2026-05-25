// Maps a fired cron row's payload into the right target queue.
// Called by the orchestrator each tick for due rows.
//
// All AI-backed dispatches (PROMPT/ASYNC/BROWSER variants) carry the
// firing cron's row id in the synthesized payload so the consuming
// worker can attribute token usage back via addCronUsage(). Lets
// /crons show running totals per recurring schedule.

import { logger } from '../logger.js'
import { enqueueBrowserJob } from './browser-queue.js'
import { getInternalCronHandler } from './cron-handlers.js'
import { type CronRow } from './crons.js'
import { enqueueInbound } from './inbound.js'
import { enqueueOutbound, type EnqueueOutboundInput } from './outbound.js'

export function dispatchCron(row: CronRow): void {
  let payload: unknown
  try {
    payload = JSON.parse(row.payload)
  } catch (err) {
    logger.error({ err, id: row.id, name: row.name }, 'cron payload not JSON')
    return
  }

  switch (row.enqueueInto) {
    case 'outbound':
      dispatchOutbound(row, payload)
      return
    case 'internal':
      dispatchInternal(row, payload)
      return
    case 'inbound':
      dispatchInboundPrompt(row, payload)
      return
    case 'async': {
      // Async lane: enqueue a background AI task. We use the existing
      // in-memory async queue (still fastq), so threading cronId for
      // cost attribution requires the agent inside the async task to
      // be told about it. For now we just enqueue plain — cost
      // tracking for ASYNC variant lands when the general async lane
      // migrates to SQLite.
      void (async () => {
        const { enqueueAsyncTask } = await import('./async-tasks.js')
        if (!isTaskPayload(payload)) {
          logger.error({ id: row.id, payload }, 'cron async payload malformed')
          return
        }
        enqueueAsyncTask({
          jid: payload.address.replace(/^wa:(dm|group):/, ''),  // strip prefix back to raw jid
          senderNumber: payload.senderNumber,
          description: payload.description,
          originatingMessage: `[cron:${row.name}]`,
          allowedTools: 'all',
        })
        logger.info({ id: row.id, name: row.name }, 'cron → async dispatched')
      })().catch((err) =>
        logger.error({ err, id: row.id }, 'cron → async dispatch failed'),
      )
      return
    }
    case 'browser': {
      if (!isTaskPayload(payload)) {
        logger.error({ id: row.id, payload }, 'cron browser payload malformed')
        return
      }
      enqueueBrowserJob({
        address: payload.address,
        description: payload.description,
        originatingMessage: `[cron:${row.name}]`,
        senderNumber: payload.senderNumber,
        senderName: null,
        allowedTools: 'all',
      })
      logger.info({ id: row.id, name: row.name }, 'cron → browser dispatched')
      return
    }
    case 'memory_writes':
      logger.warn(
        { name: row.name, target: row.enqueueInto },
        'cron memory_writes dispatch not implemented',
      )
      return
    default:
      logger.error(
        { name: row.name, target: row.enqueueInto },
        'cron has unknown target queue',
      )
  }
}

// PROMPT variant: synthesize an inbound row that looks like a user
// message. The chat worker pool picks it up, runs the AI, reply lands
// in chat via the normal outbound path. The cron row's id is threaded
// in the Job payload so worker.ts can attribute usage back.
function dispatchInboundPrompt(row: CronRow, payload: unknown): void {
  if (!isPromptPayload(payload)) {
    logger.error({ id: row.id, payload }, 'cron prompt payload malformed')
    return
  }
  // Address parsing: payload.address is the chat address (formatted),
  // so we extract the jid form for the synthesized Job.
  // For wa:dm:1234@s.whatsapp.net → jid is the part after the second :
  const jidMatch = /^wa:(?:dm|group):(.+)$/.exec(payload.address)
  const rawJid = jidMatch ? jidMatch[1]! : payload.address
  const now = Math.floor(Date.now() / 1000)

  // Minimal Job — the chat worker calling processJob will recompute
  // memoryPreamble / recentContext via the existing buildMemoryPreamble
  // path. We just provide the user-facing text + the cronId for
  // cost attribution.
  const job = {
    jid: rawJid,
    text: payload.prompt,
    input: payload.prompt,           // chat worker will wrap with memory preamble
    senderNumber: payload.senderNumber ?? 'system',
    fromMe: false,
    allowedTools: 'all' as const,
    allowedTags: 'all' as const,
    cronId: row.id,                  // for addCronUsage in worker.ts
  }

  enqueueInbound({
    address: payload.address,
    actorAddress: `system:cron:${row.id}`,
    personId: payload.personId ?? null,
    actorPersonId: null,
    externalMsgId: `cron-${row.id}-${now}`,   // dedup per second
    text: payload.prompt,
    pushName: 'system:cron',
    triggerReason: 'cron',
    receivedAt: now,
    payload: job,
  })
  logger.info({ id: row.id, name: row.name }, 'cron → inbound (PROMPT) dispatched')
}

function dispatchInternal(row: CronRow, payload: unknown): void {
  if (!payload || typeof payload !== 'object' || !('handler' in payload)) {
    logger.error({ id: row.id, name: row.name }, "internal cron missing 'handler' in payload")
    return
  }
  const handlerName = (payload as { handler: unknown }).handler
  if (typeof handlerName !== 'string') {
    logger.error({ id: row.id, name: row.name }, 'internal cron handler name not a string')
    return
  }
  const handler = getInternalCronHandler(handlerName)
  if (!handler) {
    logger.error(
      { id: row.id, name: row.name, handler: handlerName },
      'internal cron handler not registered',
    )
    return
  }
  try {
    const result = handler()
    if (result && typeof (result as Promise<void>).catch === 'function') {
      ;(result as Promise<void>).catch((err) =>
        logger.error({ err, handler: handlerName }, 'internal cron handler rejected'),
      )
    }
  } catch (err) {
    logger.error({ err, handler: handlerName }, 'internal cron handler threw')
  }
}

function dispatchOutbound(row: CronRow, payload: unknown): void {
  if (!isOutboundPayload(payload)) {
    logger.error({ id: row.id, payload }, 'cron outbound payload malformed')
    return
  }
  enqueueOutbound({
    ...payload,
    // Recurring crons MUST NOT collide with prior firings; embed the
    // current tick in the idempotency key. One-shots can supply their
    // own.
    idempotencyKey:
      payload.idempotencyKey ??
      `cron-${row.name}-${Math.floor(Date.now() / 1000)}`,
  })
}

function isOutboundPayload(p: unknown): p is EnqueueOutboundInput {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return typeof o.address === 'string' && typeof o.kind === 'string'
}

function isPromptPayload(p: unknown): p is {
  address: string
  prompt: string
  senderNumber?: string
  personId?: string
} {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return typeof o.address === 'string' && typeof o.prompt === 'string'
}

function isTaskPayload(p: unknown): p is {
  address: string
  description: string
  senderNumber: string
} {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return (
    typeof o.address === 'string' &&
    typeof o.description === 'string' &&
    typeof o.senderNumber === 'string'
  )
}
