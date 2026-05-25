import {
  getContentType,
  isJidGroup,
  jidDecode,
  jidNormalizedUser,
  type WAMessage,
  type WASocket,
} from 'baileys'
import type { IncomingMessage, TriggerHints } from '../channels/runtime.js'
import { config } from '../config.js'
import { formatAddress, jidToAddress } from '../db/address.js'
import { logger } from '../logger.js'
import {
  detectMediaType,
  downloadAndSave,
  getMediaSize,
} from '../store/media.js'
import { discoverGroupIfNew } from '../wa/whitelist.js'
import { processIncomingMessage } from './ingest.js'

export function attachIncoming(sock: WASocket): void {
  const ownerJid = sock.user?.id
    ? jidNormalizedUser(sock.user.id)
    : ''

  // History sync: WhatsApp delivers older messages via this event on connect.
  // Process ones within the age window through the normal pipeline.
  sock.ev.on('messaging-history.set', ({ messages: historyMsgs }) => {
    logger.info(
      { count: historyMsgs.length },
      'history sync received',
    )
    void processMessages(historyMsgs, sock, ownerJid, true)
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return
    void processMessages(messages, sock, ownerJid, type === 'append')
  })
}

async function processMessages(
  messages: WAMessage[],
  sock: WASocket,
  ownerJid: string,
  isHistorySync = false,
): Promise<void> {
  for (const msg of messages) {
    try {
      const incoming = await toIncoming(msg, ownerJid, sock)
      if (!incoming) continue
      if (incoming.isGroup) await discoverGroupIfNew(sock, incoming.accessKey)
      await processIncomingMessage(incoming, { isHistorySync })
    } catch (err) {
      logger.error(
        { err, msgId: msg.key.id },
        'failed to process incoming message',
      )
    }
  }
}

async function resolveToPn(sock: WASocket, jid: string): Promise<string> {
  if (!jid || !jid.endsWith('@lid')) return jid
  try {
    const pn = await sock.signalRepository.lidMapping.getPNForLID(jid)
    return pn ?? jid
  } catch {
    return jid
  }
}

async function toIncoming(
  msg: WAMessage,
  ownerJid: string,
  sock: WASocket,
): Promise<IncomingMessage | null> {
  const rawJid = msg.key.remoteJid
  if (!rawJid) return null
  if (!msg.message) return null
  if (rawJid === 'status@broadcast') return null

  const fromMe = !!msg.key.fromMe
  const isGroup = isJidGroup(rawJid) === true

  // Canonicalize chat jid: groups stay as @g.us, DMs preferred as
  // @s.whatsapp.net, drop device suffixes so devices merge.
  const jid = isGroup
    ? jidNormalizedUser(rawJid)
    : jidNormalizedUser(await resolveToPn(sock, rawJid))

  let senderRaw: string
  if (fromMe) {
    senderRaw = ownerJid
  } else if (isGroup) {
    senderRaw = msg.key.participant ?? ''
  } else {
    senderRaw = rawJid
  }
  const sender = jidNormalizedUser(await resolveToPn(sock, senderRaw))
  const senderNumber = jidDecode(sender)?.user ?? ''

  const messageType = getContentType(msg.message) ?? 'unknown'
  const text = extractText(msg.message)
  const timestamp =
    typeof msg.messageTimestamp === 'number'
      ? msg.messageTimestamp
      : Number(msg.messageTimestamp ?? 0)
  const msgId = msg.key.id ?? `${jid}-${timestamp}`
  const mediaType = detectMediaType(msg)

  return {
    id: msgId,
    externalMsgId: `wa:${msgId}`,
    channel: 'wa',
    address: formatAddress(jidToAddress(jid)),
    chatKey: jid,
    accessKey: jid,
    actorAddress: senderNumber
      ? formatAddress(jidToAddress(`${senderNumber}@s.whatsapp.net`))
      : null,
    senderKey: senderNumber,
    senderLabel: msg.pushName ?? undefined,
    timestamp,
    text,
    fromMe,
    isGroup,
    messageType,
    mediaType,
    mediaBytes: mediaType ? getMediaSize(msg) : null,
    downloadMedia: mediaType ? () => downloadAndSave(msg, jid) : undefined,
    quoteMsgId: msg.key.id ?? null,
    triggerHints: waTriggerHints(msg, sock),
    selfChat:
      fromMe &&
      !isGroup &&
      jidDecode(jid)?.user === config.owner.number,
    loadChatMetadata: () => loadWaChatMetadata(sock, jid, isGroup),
  }
}

function contextInfo(message: NonNullable<WAMessage['message']>) {
  return (
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.audioMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    message.documentWithCaptionMessage?.message?.documentMessage?.contextInfo ??
    message.stickerMessage?.contextInfo
  )
}

function ownerNumbers(sock: WASocket): Set<string> {
  const out = new Set<string>()
  if (config.owner.number) out.add(config.owner.number)
  const pn = sock.user?.id ? jidDecode(sock.user.id)?.user : undefined
  if (pn) out.add(pn)
  const lid = sock.user?.lid ? jidDecode(sock.user.lid)?.user : undefined
  if (lid) out.add(lid)
  return out
}

function waTriggerHints(msg: WAMessage, sock: WASocket): TriggerHints {
  const ci = msg.message ? contextInfo(msg.message) : undefined
  if (!ci) return {}

  const owners = ownerNumbers(sock)
  let mentionedBot = false
  for (const m of ci.mentionedJid ?? []) {
    const user = jidDecode(m)?.user
    if (user && owners.has(user)) {
      mentionedBot = true
      break
    }
  }

  let replyToBot = false
  const quotedParticipant = ci.participant
  if (quotedParticipant) {
    const user = jidDecode(quotedParticipant)?.user
    replyToBot = !!user && owners.has(user)
  }

  return { mentionedBot, replyToBot }
}

async function loadWaChatMetadata(
  sock: WASocket,
  jid: string,
  isGroup: boolean,
) {
  if (!isGroup) {
    return { platform: 'WhatsApp', isGroup, externalId: jid }
  }

  let chatName = 'unknown'
  let memberSummary = ''
  try {
    const meta = await sock.groupMetadata(jid)
    chatName = meta.subject || chatName
    if (meta.participants?.length) {
      memberSummary = `${meta.participants.length} participants`
    }
  } catch (err) {
    logger.warn({ err, jid }, 'group metadata fetch failed in bootstrap')
  }

  return {
    platform: 'WhatsApp',
    isGroup,
    chatName,
    memberSummary,
    externalId: jid,
  }
}

function extractText(message: NonNullable<WAMessage['message']>): string {
  if (message.conversation) return message.conversation
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text
  if (message.imageMessage?.caption) return message.imageMessage.caption
  if (message.videoMessage?.caption) return message.videoMessage.caption
  if (message.documentMessage?.caption) return message.documentMessage.caption
  return ''
}
