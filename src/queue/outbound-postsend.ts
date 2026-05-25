// Post-send bookkeeping run by the sender worker after a successful
// channel send. Kept separate from the worker loop so it's easy to
// extend (e.g. emit metrics, fire webhooks) without bloating the loop.
//
// Today's job:
//  - Append a row to the message log so Claude sees what the bot
//    said in future bootstrap context.
//  - Delete the local file if the outbound row pointed at one and the
//    path looks like ephemeral outbox content. We trust producers to
//    only point at files they want unlinked after send.

import { existsSync, unlinkSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { config } from '../config.js'
import { addressToExternalId, parseAddress } from '../db/address.js'
import { logger } from '../logger.js'
import { append } from '../store/messages.js'
import type { OutboundRow } from './outbound.js'

export async function afterSend(row: OutboundRow, sentMsgId: string): Promise<void> {
  await persistToMessageLog(row, sentMsgId)
  maybeUnlinkMedia(row)
}

async function persistToMessageLog(row: OutboundRow, msgId: string): Promise<void> {
  let address
  try {
    address = parseAddress(row.address)
  } catch {
    return
  }
  // Message log is currently WA-specific (keyed by JID). Only persist
  // WA-bound replies for now; multi-channel log unification comes in a
  // later phase.
  if (address.channel !== 'wa') return

  const jid = addressToExternalId(address)
  const messageType =
    row.kind === 'text' ? 'conversation' : `${row.kind}Message`

  try {
    await append({
      id: `outbound-${row.id}-${msgId}`,
      jid,
      direction: 'out',
      fromMe: true,
      sender: '',
      senderNumber: config.owner.number,
      timestamp: Math.floor(Date.now() / 1000),
      text: row.text ?? (row.mediaPath ? `[${row.kind}: ${row.mediaPath}]` : ''),
      messageType,
      mediaPath: row.mediaPath ?? undefined,
      mediaType: row.kind === 'text' ? undefined : (row.kind as 'image' | 'video' | 'audio' | 'document'),
    })
  } catch (err) {
    logger.warn(
      { err, outboundId: row.id },
      'failed to append to message log (send already succeeded)',
    )
  }
}

function maybeUnlinkMedia(row: OutboundRow): void {
  if (!row.mediaPath) return
  // Resolve relative paths the same way the sender worker did when
  // calling the adapter, so we delete the actual file.
  const path = isAbsolute(row.mediaPath)
    ? row.mediaPath
    : resolve(process.cwd(), row.mediaPath)
  // Only auto-delete files inside known-ephemeral directories. Inbound
  // media in storage/media/ has its own retention cron and should not
  // be touched here. config.storage.mediaDir = inbound media.
  const inboundMediaDir = resolve(process.cwd(), config.storage.mediaDir)
  if (path.startsWith(inboundMediaDir)) {
    return
  }
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch (err) {
    logger.warn({ err, path }, 'failed to unlink outbound media file')
  }
}
