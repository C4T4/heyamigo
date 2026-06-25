import { unlink } from 'fs/promises'
import { resolve } from 'path'
import { getProvider } from '../ai/providers.js'
import { getSession } from '../ai/sessions.js'
import { transcribeAudioFile } from '../audio/transcription.js'
import { config } from '../config.js'
import { personIdForAddress } from '../db/identity-sync.js'
import { estimate as estimateJob } from '../estimates/index.js'
import { logger } from '../logger.js'
import { buildMemoryPreamble } from '../memory/preamble.js'
import { enqueueInbound } from '../queue/inbound.js'
import { enqueueOutbound } from '../queue/outbound.js'
import type { Job } from '../queue/types.js'
import { mediaPromptTag, type MediaInfo } from '../store/media.js'
import { append, type StoredMessage } from '../store/messages.js'
import { getDailyTokens } from '../store/usage.js'
import {
  checkAccess,
  discoverAddressGroupIfNew,
  getLimitsForUser,
  getRoleForContext,
} from '../wa/whitelist.js'
import type { IncomingMessage } from '../channels/runtime.js'
import { buildInitPayload, buildRecentContext } from './bootstrap.js'
import { tryCommand } from './commands.js'
import { checkTrigger } from './triggers.js'

export type ProcessIncomingOptions = {
  isHistorySync?: boolean
}

function toStored(incoming: IncomingMessage): StoredMessage {
  return {
    id: incoming.id,
    jid: incoming.chatKey,
    direction: incoming.fromMe ? 'out' : 'in',
    fromMe: incoming.fromMe,
    sender: incoming.actorAddress ?? incoming.senderKey,
    senderNumber: incoming.senderKey,
    pushName: incoming.senderLabel,
    timestamp: incoming.timestamp,
    text: incoming.text,
    messageType: incoming.messageType,
  }
}

function enqueueTextReply(
  incoming: IncomingMessage,
  text: string,
  idempotencyKey: string,
): void {
  enqueueOutbound({
    address: incoming.address,
    kind: 'text',
    text,
    quoteMsgId:
      incoming.isGroup && config.reply.quoteInGroups
        ? incoming.quoteMsgId ?? undefined
        : undefined,
    idempotencyKey,
  })
}

function buildImageGenRoutingContract(): string {
  const outboxPath = resolve('storage/outbox')
  return [
    '[Image generation routing]',
    'This turn is classified as image/file generation.',
    'Do not perform file work in this foreground reply.',
    `Reply briefly and emit [ASYNC: Generate the requested image using current chat context. Save final files under ${outboxPath}/. Follow-up reply must include one [IMAGE: /absolute/path] tag per final image, or say: Image job failed before producing a file.]`,
  ].join('\n')
}

function shouldTranscribeAudio(params: {
  media: MediaInfo | null
  respond: boolean
  triggerMode: string
  selfChat?: boolean
}): params is typeof params & { media: MediaInfo } {
  if (params.media?.mediaType !== 'audio') return false
  if (!params.respond) return false
  if (params.selfChat) return true
  return params.triggerMode !== 'off'
}

function mergeAudioTranscript(text: string, transcript: string): string {
  const cleanedTranscript = transcript.trim()
  const cleanedText = text.trim()
  if (!cleanedTranscript) return text
  if (!cleanedText) return cleanedTranscript
  return `${cleanedText}\n\n[Audio transcript]\n${cleanedTranscript}`
}

export async function processIncomingMessage(
  incoming: IncomingMessage,
  opts: ProcessIncomingOptions = {},
): Promise<void> {
  const stored = toStored(incoming)

  const ageMs = Date.now() - stored.timestamp * 1000
  if (ageMs > config.reply.maxMessageAgeMs) {
    if (opts.isHistorySync) return
    await append(stored)
    logger.debug(
      { jid: stored.jid, address: incoming.address, ageMs: Math.floor(ageMs) },
      'message too old, stored silently',
    )
    return
  }

  if (incoming.isGroup && incoming.channel !== 'wa') {
    await discoverAddressGroupIfNew({
      address: incoming.address,
      name: incoming.chat?.chatName,
      ownerSender: stored.senderNumber || config.owner.number || undefined,
    })
  }

  const decision = checkAccess({
    jid: incoming.accessKey,
    address: incoming.address,
    isGroup: incoming.isGroup,
    senderNumber: stored.senderNumber,
    fromMe: stored.fromMe,
  })

  const logCtx = {
    jid: stored.jid,
    address: incoming.address,
    from: stored.senderNumber || '(owner)',
    fromMe: stored.fromMe,
    type: stored.messageType,
    text: stored.text.slice(0, 80),
    decision: decision.reason,
  }

  if (!decision.store) {
    logger.debug(logCtx, 'message dropped')
    return
  }

  const limits = getLimitsForUser(stored.senderNumber, incoming.isGroup)
  if (
    incoming.mediaType &&
    limits.maxFileBytes !== null &&
    decision.respond &&
    incoming.mediaBytes !== null &&
    incoming.mediaBytes !== undefined &&
    incoming.mediaBytes > limits.maxFileBytes
  ) {
    await append(stored)
    enqueueTextReply(
      incoming,
      'Could not process that, please try a smaller file.',
      `oversized-${incoming.externalMsgId}`,
    )
    logger.info(
      { ...logCtx, size: incoming.mediaBytes, cap: limits.maxFileBytes },
      'oversized media rejected',
    )
    return
  }

  let media: MediaInfo | null = null
  if (incoming.mediaType && incoming.downloadMedia) {
    media = await incoming.downloadMedia()
  }

  if (
    media &&
    limits.maxFileBytes !== null &&
    decision.respond &&
    media.bytes > limits.maxFileBytes
  ) {
    await unlink(media.mediaPath).catch(() => undefined)
    await append(stored)
    enqueueTextReply(
      incoming,
      'Could not process that, please try a smaller file.',
      `oversized-downloaded-${incoming.externalMsgId}`,
    )
    logger.info(
      { ...logCtx, bytes: media.bytes, cap: limits.maxFileBytes },
      'oversized media rejected (post-download)',
    )
    return
  }

  if (media) {
    stored.mediaType = media.mediaType
    stored.mediaPath = media.mediaPath
    stored.mediaMime = media.mediaMime
  }

  const originalMediaText = stored.text
  let audioTranscript: string | null = null
  const transcribeThisAudio =
    shouldTranscribeAudio({
      media,
      respond: decision.respond,
      triggerMode: decision.triggerMode,
      selfChat: incoming.selfChat,
    }) && media

  if (transcribeThisAudio) {
    audioTranscript = await transcribeAudioFile({
      path: transcribeThisAudio.mediaPath,
      mime: transcribeThisAudio.mediaMime,
      address: incoming.address,
      externalMsgId: incoming.externalMsgId,
    })
    if (audioTranscript) {
      stored.text = mergeAudioTranscript(stored.text, audioTranscript)
      logCtx.text = stored.text.slice(0, 80)
    }
  }

  await append(stored)

  if (!decision.respond) {
    logger.info(logCtx, 'message captured, silent')
    return
  }

  if (!stored.text.trim() && !media) {
    logger.debug(logCtx, 'message captured, respond skipped (empty)')
    return
  }

  const isCommand = await tryCommand({
    jid: stored.jid,
    address: incoming.address,
    text: stored.text,
    senderNumber: stored.senderNumber,
    reply: async (text) =>
      enqueueTextReply(incoming, text, `command-${incoming.externalMsgId}`),
  })
  if (isCommand) {
    logger.info(logCtx, 'command handled')
    return
  }

  let triggerReason = incoming.selfChat ? 'self-chat' : ''
  if (!incoming.selfChat) {
    const trigger = checkTrigger({
      mode: decision.triggerMode,
      text: stored.text,
      audioTranscript: audioTranscript ?? undefined,
      mentionedBot: incoming.triggerHints?.mentionedBot,
      replyToBot: incoming.triggerHints?.replyToBot,
    })
    if (!trigger.triggered) {
      logger.info(
        { ...logCtx, trigger: trigger.reason },
        'message captured, no trigger',
      )
      return
    }
    triggerReason = trigger.reason
  }

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
      return
    }
  }

  const { role } = getRoleForContext(stored.senderNumber, incoming.isGroup)

  const existingSession = getSession(stored.jid, getProvider().name)
  let userContent = stored.text
  if (media) {
    userContent = mediaPromptTag(media, originalMediaText, audioTranscript)
  }

  const memoryPreamble = buildMemoryPreamble({
    jid: stored.jid,
    senderNumber: stored.senderNumber,
    isGroup: incoming.isGroup,
    recentText: stored.text,
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
    const chat = incoming.chat ?? await incoming.loadChatMetadata?.()
    core = await buildInitPayload({
      jid: stored.jid,
      userText: userContent,
      userNumber: stored.senderNumber,
      chat,
    })
  }

  const personId = personIdForAddress(incoming.address)
  const actorPersonId = incoming.actorAddress
    ? personIdForAddress(incoming.actorAddress)
    : null

  const est = estimateJob({
    description: stored.text,
    attachments: media ? [{ kind: media.mediaType }] : undefined,
    senderPersonId: actorPersonId ?? undefined,
  })
  const jobKind = est?.kind ?? null

  let input = `${memoryPreamble}\n\n---\n\n${core}`
  if (est?.kind === 'image-gen') {
    input = `${input}\n\n---\n\n${buildImageGenRoutingContract()}`
  }

  logger.info(
    { ...logCtx, resume: !!existingSession, trigger: triggerReason },
    'message captured, enqueuing',
  )

  const job: Job = {
    jid: stored.jid,
    address: incoming.address,
    actorAddress: incoming.actorAddress,
    text: stored.text,
    input,
    sessionId: existingSession,
    senderNumber: stored.senderNumber,
    fromMe: stored.fromMe,
    allowedTools: role.tools,
    allowedTags: role.tags,
  }

  if (est) {
    enqueueOutbound({
      address: incoming.address,
      kind: 'text',
      text: est.text,
      idempotencyKey: `estimate-${incoming.externalMsgId}`,
    })
  } else if (media && config.reply.ackOnMedia !== false) {
    enqueueOutbound({
      address: incoming.address,
      kind: 'text',
      text: config.reply.mediaAckText,
      idempotencyKey: `media-ack-${incoming.externalMsgId}`,
    })
  }

  enqueueInbound({
    address: incoming.address,
    actorAddress: incoming.actorAddress,
    personId,
    actorPersonId,
    externalMsgId: incoming.externalMsgId,
    text: stored.text,
    mediaPath: media?.mediaPath ?? null,
    mediaMime: media?.mediaMime ?? null,
    mediaBytes: media?.bytes ?? null,
    pushName: stored.pushName ?? null,
    triggerReason,
    kind: jobKind,
    receivedAt: stored.timestamp,
    payload: job,
  })
}
