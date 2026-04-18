import {
  getContentType,
  isJidGroup,
  jidDecode,
  jidNormalizedUser,
  type WAMessage,
  type WASocket,
} from 'baileys'
import { getSession } from '../ai/sessions.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { buildMemoryPreamble } from '../memory/preamble.js'
import { enqueue } from '../queue/queue.js'
import type { Job } from '../queue/types.js'
import { downloadAndSave, mediaPromptTag } from '../store/media.js'
import { append, type StoredMessage } from '../store/messages.js'
import {
  checkAccess,
  discoverGroupIfNew,
  getRoleForContext,
} from '../wa/whitelist.js'
import { buildInitPayload, buildRecentContext } from './bootstrap.js'
import { tryCommand } from './commands.js'
import { handleReply } from './outgoing.js'
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

      // Download media if present (image, video, audio, document)
      const media = await downloadAndSave(msg, stored.jid)
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

      const { role } = getRoleForContext(stored.senderNumber, isGroup)

      const existingSession = getSession(stored.jid)
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
      }

      // Start typing indicator immediately; refresh every 10s (WA expires ~15s)
      let typingHeartbeat: NodeJS.Timeout | null = null
      if (config.reply.typingIndicator) {
        void sock
          .sendPresenceUpdate('composing', stored.jid)
          .catch(() => undefined)
        typingHeartbeat = setInterval(() => {
          void sock
            .sendPresenceUpdate('composing', stored.jid)
            .catch(() => undefined)
        }, 10000)
      }
      const stopTyping = () => {
        if (typingHeartbeat) clearInterval(typingHeartbeat)
        typingHeartbeat = null
      }
      // Defense-in-depth: if nothing else clears the heartbeat within 10 min
      // (e.g. a code path forgot), force-stop. Prevents runaway "typing..."
      // indicators when the pipeline silently fails.
      const typingSafetyCap = setTimeout(
        () => {
          if (typingHeartbeat) {
            logger.warn(
              { jid: job.jid },
              'typingHeartbeat safety-cap fired, forcing clear',
            )
            stopTyping()
          }
        },
        10 * 60 * 1000,
      )
      typingSafetyCap.unref()

      enqueue(job)
        .then((result) => handleReply(job, result, msg))
        .catch((err) => {
          const isTimeout =
            err instanceof Error && err.name === 'ClaudeTimeoutError'
          logger.error(
            { err, jid: job.jid, isTimeout },
            'pipeline failed',
          )
          const replyText = isTimeout
            ? 'That request timed out. The task was cancelled, queue is moving.'
            : config.reply.errorMessage
          return handleReply(job, { reply: replyText }, msg).catch((e) =>
            logger.error(
              { err: e, jid: job.jid },
              'failed to send error reply',
            ),
          )
        })
        .finally(() => {
          stopTyping()
          clearTimeout(typingSafetyCap)
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
