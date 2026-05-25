// Maps a fired cron row's payload into the right target queue.
// Called by the orchestrator each tick for due rows.
//
// Currently supports: outbound. inbound, async, memory_writes ride
// in on later phases — when those queues exist, add their dispatch
// here and a cron can fire into them with no other changes.

import { logger } from '../logger.js'
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
