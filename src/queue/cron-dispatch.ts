// Maps a fired cron row's payload into the right target queue.
// Called by the orchestrator each tick for due rows.
//
// Currently supports: outbound. inbound, async, memory_writes ride
// in on later phases — when those queues exist, add their dispatch
// here and a cron can fire into them with no other changes.

import { logger } from '../logger.js'
import { getInternalCronHandler } from './cron-handlers.js'
import { type CronRow } from './crons.js'
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
    case 'async':
    case 'memory_writes':
      logger.warn(
        { name: row.name, target: row.enqueueInto },
        'cron target queue not yet wired (phase pending)',
      )
      return
    default:
      logger.error(
        { name: row.name, target: row.enqueueInto },
        'cron has unknown target queue',
      )
  }
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
  // Fire-and-forget. Handler errors are caught and logged but the
  // cron row still gets marked fired so we don't stack up retries.
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
