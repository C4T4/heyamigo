import { unlink } from 'fs/promises'
import {
  getContentType,
  isJidGroup,
  jidDecode,
  jidNormalizedUser,
  type WAMessage,
  type WASocket,
} from 'baileys'
import { getProvider } from '../ai/providers.js'
import { getSession } from '../ai/sessions.js'
import { formatAddress, jidToAddress } from '../db/address.js'
import { personIdForAddress } from '../db/identity-sync.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { buildMemoryPreamble } from '../memory/preamble.js'
import { enqueueInbound } from '../queue/inbound.js'
import { enqueueOutbound } from '../queue/outbound.js'
import type { Job } from '../queue/types.js'
import {
  detectMediaType,
  downloadAndSave,
  getMediaSize,
  mediaPromptTag,
} from '../store/media.js'
import { append, type StoredMessage } from '../store/messages.js'
import { getDailyTokens } from '../store/usage.js'
import { sendText } from '../wa/sender.js'
import {
  checkAccess,
  discoverGroupIfNew,
  getLimitsForUser,
  getRoleForContext,
} from '../wa/whitelist.js'
import { buildInitPayload, buildRecentContext } from './bootstrap.js'
import { tryCommand } from './commands.js'
import { checkTrigger } from './triggers.js'

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
    void processMessages(historyMsgs, sock, ownerJid)
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
      const stored = await toStored(msg, ownerJid, sock)
      if (!stored) continue

      // Age gate: skip messages older than maxMessageAgeMs
      const ageMs = Date.now() - stored.timestamp * 1000
      if (ageMs > config.reply.maxMessageAgeMs) {
        if (isHistorySync) continue // don't store ancient history
        await append(stored)
        logger.debug(
          { jid: stored.jid, ageMs: Math.floor(ageMs) },
          'message too old, stored silently',
        )
        continue
      }

      const isGroup = stored.jid.endsWith('@g.us')
      if (isGroup) await discoverGroupIfNew(sock, stored.jid)

      const decision = checkAccess({
        jid: stored.jid,
        isGroup,
        senderNumber: stored.senderNumber,
        fromMe: stored.fromMe,
      })

      const logCtx = {
        jid: stored.jid,
        from: stored.senderNumber || '(owner)',
        fromMe: stored.fromMe,
        type: stored.messageType,
        text: stored.text.slice(0, 80),
        decision: decision.reason,
      }

      if (!decision.store) {
        logger.debug(logCtx, 'message dropped')
        continue
      }

      // File-size gate: refuse oversized media BEFORE downloading. Per-role
      // cap; owner is always unlimited. If a file is too big we store the
      // message (text/caption preserved for history), tell the user, and
      // skip the Claude call — Claude would have no useful payload anyway.
      const limits = getLimitsForUser(stored.senderNumber, isGroup)
      const incomingMediaType = detectMediaType(msg)
      if (
        incomingMediaType &&
        limits.maxFileBytes !== null &&
        decision.respond
      ) {
        const size = getMediaSize(msg)
        if (size !== null && size > limits.maxFileBytes) {
          await append(stored)
          const quoted = isGroup && config.reply.quoteInGroups ? msg : undefined
          await sendText(
            sock,
            stored.jid,
            'Could not process that, please try a smaller file.',
            quoted,
          ).catch((err) =>
            logger.error(
              { err, jid: stored.jid },
              'failed to send oversized-file notice',
            ),
          )
          logger.info(
            { ...logCtx, size, cap: limits.maxFileBytes },
            'oversized media rejected',
          )
          continue
        }
      }

      // Download media if present (image, video, audio, document)
      const media = await downloadAndSave(msg, stored.jid)

      // Post-download safety net: re-check against the real buffer size.
      // Catches cases the pre-download gate missed — protobuf fileLength
      // missing, nested in documentWithCaptionMessage, stickers, etc.
      // Only enforced when we'd otherwise respond; silent groups keep the
      // archive intact regardless of size.
      if (
        media &&
        limits.maxFileBytes !== null &&
        decision.respond &&
        media.bytes > limits.maxFileBytes
      ) {
        await unlink(media.mediaPath).catch(() => undefined)
        await append(stored)
        const quoted =
          isGroup && config.reply.quoteInGroups ? msg : undefined
        await sendText(
          sock,
          stored.jid,
          'Could not process that, please try a smaller file.',
          quoted,
        ).catch((err) =>
          logger.error(
            { err, jid: stored.jid },
            'failed to send oversized-file notice',
          ),
        )
        logger.info(
          { ...logCtx, bytes: media.bytes, cap: limits.maxFileBytes },
          'oversized media rejected (post-download)',
        )
        continue
      }

      if (media) {
        stored.mediaType = media.mediaType
        stored.mediaPath = media.mediaPath
        stored.mediaMime = media.mediaMime
      }

      await append(stored)

      if (!decision.respond) {
        logger.info(logCtx, 'message captured, silent')
        continue
      }

      // Need either text or media to respond
      if (!stored.text.trim() && !media) {
        logger.debug(logCtx, 'message captured, respond skipped (empty)')
        continue
      }

      // Commands short-circuit the AI pipeline (always, regardless of trigger mode)
      const isCommand = await tryCommand({
        sock,
        jid: stored.jid,
        text: stored.text,
        senderNumber: stored.senderNumber,
        quoted: isGroup && config.reply.quoteInGroups ? msg : undefined,
      })
      if (isCommand) {
        logger.info(logCtx, 'command handled')
        continue
      }

      // Self-chat: owner messaging themselves — always trigger
      const isSelfChat = stored.fromMe && !isGroup &&
        jidDecode(stored.jid)?.user === config.owner.number

      // Trigger gate: alias / @mention / reply-to-bot depending on mode
      let triggerReason = isSelfChat ? 'self-chat' : ''
      if (!isSelfChat) {
        const trigger = checkTrigger({
          isGroup,
          text: stored.text,
          msg,
          sock,
        })
        if (!trigger.triggered) {
          logger.info(
            { ...logCtx, trigger: trigger.reason },
            'message captured, no trigger',
          )
          continue
        }
        triggerReason = trigger.reason
      }

      // Daily token cap: silent drop once the user has burned their budget
      // for the day. Owner is exempt (limits.dailyTokenLimit is null).
      if (limits.dailyTokenLimit !== null) {
        const used = getDailyTokens(stored.senderNumber)
        if (used >= limits.dailyTokenLimit) {
          logger.info(
            {
              ...logCtx,
              used,
              cap: limits.dailyTokenLimit,
              trigger: triggerReason,
            },
            'daily token quota exhausted, silent drop',
          )
          continue
        }
      }

      const { role } = getRoleForContext(stored.senderNumber, isGroup)

      const existingSession = getSession(stored.jid, getProvider().name)
      let userContent = stored.text
      if (media) {
        const tag = mediaPromptTag(media, stored.text)
        userContent = tag
      }

      const recentText = stored.text
      const memoryPreamble = buildMemoryPreamble({
        jid: stored.jid,
        senderNumber: stored.senderNumber,
        isGroup,
        recentText,
      })
      let core: string
      if (existingSession) {
        const recent = await buildRecentContext(
          stored.jid,
          config.bootstrap.recentContextDepth,
        )
        const current = `[Current message]\n${stored.senderNumber}: ${userContent}`
        core = recent ? `${recent}\n${current}` : userContent
      } else {
        core = await buildInitPayload({
          jid: stored.jid,
          sock,
          userText: userContent,
          userNumber: stored.senderNumber,
        })
      }
      const input = `${memoryPreamble}\n\n---\n\n${core}`

      logger.info(
        { ...logCtx, resume: !!existingSession, trigger: triggerReason },
        'message captured, enqueuing',
      )

      const job: Job = {
        jid: stored.jid,
        text: stored.text,
        input,
        sessionId: existingSession,
        senderNumber: stored.senderNumber,
        fromMe: stored.fromMe,
        allowedTools: role.tools,
        allowedTags: role.tags,
      }

      // Enqueue into the inbound table; chat worker pool drains and
      // calls processJob + handleReply asynchronously. Typing indicator
      // is temporarily dropped (was tied to the old synchronous flow);
      // re-add via ChannelAdapter.sendTyping() in a follow-up commit.
      const chatAddress = formatAddress(jidToAddress(stored.jid))
      const senderAddress = stored.senderNumber
        ? formatAddress(jidToAddress(`${stored.senderNumber}@s.whatsapp.net`))
        : null
      const personId = personIdForAddress(chatAddress)
      const actorPersonId = senderAddress
        ? personIdForAddress(senderAddress)
        : null

      // For media-bearing messages, send an immediate "looking…" ack
      // via outbound so the user isn't left wondering whether the bot
      // saw the image (typing indicator was dropped in Phase 4 —
      // followup commit will reinstate via ChannelAdapter.sendTyping).
      // The chat worker still processes the actual reply normally.
      if (media && config.reply.ackOnMedia !== false) {
        enqueueOutbound({
          address: chatAddress,
          kind:    'text',
          text:    config.reply.mediaAckText,
          idempotencyKey: `media-ack-${msg.key.id}`,
        })
      }

      enqueueInbound({
        address:        chatAddress,
        actorAddress:   senderAddress,
        personId,
        actorPersonId,
        externalMsgId:  msg.key.id ?? null,
        text:           stored.text,
        pushName:       stored.pushName ?? null,
        triggerReason,
        receivedAt:     stored.timestamp,
        payload:        job,
      })
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

async function toStored(
  msg: WAMessage,
  ownerJid: string,
  sock: WASocket,
): Promise<StoredMessage | null> {
  const rawJid = msg.key.remoteJid
  if (!rawJid) return null
  if (!msg.message) return null
  if (rawJid === 'status@broadcast') return null

  const fromMe = !!msg.key.fromMe
  const isGroup = isJidGroup(rawJid) === true

  // canonicalize chat jid: groups stay as @g.us, DMs preferred as @s.whatsapp.net,
  // drop device suffix (e.g. ":19") so chats from different devices merge
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

  return {
    id: msg.key.id ?? '',
    jid,
    direction: fromMe ? 'out' : 'in',
    fromMe,
    sender,
    senderNumber,
    pushName: msg.pushName ?? undefined,
    timestamp:
      typeof msg.messageTimestamp === 'number'
        ? msg.messageTimestamp
        : Number(msg.messageTimestamp ?? 0),
    text,
    messageType,
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
