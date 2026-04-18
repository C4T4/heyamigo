import { existsSync, unlinkSync } from 'fs'
import { isJidGroup, type WAMessage } from 'baileys'
import { config } from '../config.js'
import { logger } from '../logger.js'
import type { Job, Result } from '../queue/types.js'
import { append } from '../store/messages.js'
import { detectMediaType, sendFile, sendText } from '../wa/sender.js'
import { getSocket } from '../wa/socket.js'

// Matches [FILE: path], [IMAGE: path], [VIDEO: path], [AUDIO: path], [DOCUMENT: path]
const FILE_TAG_RE = /\[(?:FILE|IMAGE|VIDEO|AUDIO|DOCUMENT):\s*([^\]]+)\]/gi

type ParsedReply = {
  text: string
  files: string[]
}

function extractFiles(reply: string): ParsedReply {
  const files: string[] = []
  const text = reply.replace(FILE_TAG_RE, (_, path: string) => {
    const trimmed = path.trim()
    if (existsSync(trimmed)) {
      files.push(trimmed)
    } else {
      logger.warn({ path: trimmed }, 'file path not found, skipping')
    }
    return ''
  }).trim()
  return { text, files }
}

export async function handleReply(
  job: Job,
  result: Result,
  originalMsg: WAMessage,
): Promise<void> {
  const sock = getSocket()
  if (!sock) {
    logger.warn({ jid: job.jid }, 'no socket available to send reply')
    return
  }

  const raw = result.reply?.replaceAll('—', ', ').replaceAll('–', '-')
  if (!raw) return

  const { text, files } = extractFiles(raw)
  const isGroup = isJidGroup(job.jid) === true
  const quoted = isGroup && config.reply.quoteInGroups ? originalMsg : undefined

  try {
    // Send files first (images, videos, PDFs, audio, etc.)
    for (const filePath of files) {
      const isFirst = filePath === files[0]
      const mediaType = detectMediaType(filePath)
      // First file gets caption if text is short + single file + supports captions
      const supportsCaption = mediaType !== 'audio'
      const caption =
        isFirst && text && text.length <= 1000 && files.length === 1 && supportsCaption
          ? text
          : undefined
      await sendFile(
        sock,
        job.jid,
        filePath,
        caption,
        isFirst ? quoted : undefined,
      )
      await append({
        id: `reply-file-${Date.now()}`,
        jid: job.jid,
        direction: 'out',
        fromMe: true,
        sender: sock.user?.id ?? '',
        senderNumber: config.owner.number,
        timestamp: Math.floor(Date.now() / 1000),
        text: caption || `[${mediaType}: ${filePath}]`,
        messageType: `${mediaType}Message`,
        mediaPath: filePath,
        mediaType,
      })
      logger.info({ jid: job.jid, path: filePath, mediaType }, 'file sent')
      // Clean up temp file after sending
      try { unlinkSync(filePath) } catch {}
      if (files.length > 1) await sleep(config.reply.chunkDelayMs)
    }

    // Send text (skip if already used as caption on single file)
    const textAlreadySent =
      files.length === 1 && text && text.length <= 1000 && detectMediaType(files[0]!) !== 'audio'
    if (text && !textAlreadySent) {
      const chunks = chunkText(text, config.reply.chunkChars)
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!
        const q = i === 0 && files.length === 0 ? quoted : undefined
        await sendText(sock, job.jid, chunk, q)

        await append({
          id: `reply-${Date.now()}-${i}`,
          jid: job.jid,
          direction: 'out',
          fromMe: true,
          sender: sock.user?.id ?? '',
          senderNumber: config.owner.number,
          timestamp: Math.floor(Date.now() / 1000),
          text: chunk,
          messageType: 'conversation',
        })

        if (i < chunks.length - 1) await sleep(config.reply.chunkDelayMs)
      }
    }

    if (config.reply.typingIndicator) {
      await sock
        .sendPresenceUpdate('paused', job.jid)
        .catch(() => undefined)
    }

    logger.info(
      {
        jid: job.jid,
        files: files.length,
        chars: text.length,
      },
      'reply sent',
    )
  } catch (err) {
    logger.error({ err, jid: job.jid }, 'failed to send reply')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Proactive outbound: send a message to a chat without an incoming trigger.
// Chunks, persists to the message log, never throws. Callers are responsible
// for the canSendProactive() gate — this function does not re-check it.
export async function initiate(params: {
  jid: string
  text: string
}): Promise<boolean> {
  const sock = getSocket()
  if (!sock) {
    logger.warn({ jid: params.jid }, 'initiate: no socket available')
    return false
  }
  const raw = params.text.replaceAll('—', ', ').replaceAll('–', '-')
  if (!raw.trim()) return false

  try {
    const chunks = chunkText(raw, config.reply.chunkChars)
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      await sendText(sock, params.jid, chunk)
      await append({
        id: `initiate-${Date.now()}-${i}`,
        jid: params.jid,
        direction: 'out',
        fromMe: true,
        sender: sock.user?.id ?? '',
        senderNumber: config.owner.number,
        timestamp: Math.floor(Date.now() / 1000),
        text: chunk,
        messageType: 'conversation',
      })
      if (i < chunks.length - 1) await sleep(config.reply.chunkDelayMs)
    }
    logger.info(
      { jid: params.jid, chars: raw.length },
      'proactive message sent',
    )
    return true
  } catch (err) {
    logger.error({ err, jid: params.jid }, 'initiate failed')
    return false
  }
}

export function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  const paragraphs = text.split(/\n\s*\n/)
  let current = ''

  const flush = () => {
    if (current) {
      chunks.push(current)
      current = ''
    }
  }

  for (const para of paragraphs) {
    const joiner = current ? '\n\n' : ''
    if (current.length + joiner.length + para.length <= maxChars) {
      current += joiner + para
      continue
    }
    flush()
    if (para.length <= maxChars) {
      current = para
    } else {
      const parts = splitLong(para, maxChars)
      for (let i = 0; i < parts.length - 1; i++) chunks.push(parts[i]!)
      current = parts[parts.length - 1] ?? ''
    }
  }
  flush()
  return chunks
}

function splitLong(text: string, maxChars: number): string[] {
  const out: string[] = []
  const sentences = text.split(/(?<=[.!?])\s+/)
  let current = ''
  for (const s of sentences) {
    const joiner = current ? ' ' : ''
    if (current.length + joiner.length + s.length <= maxChars) {
      current += joiner + s
      continue
    }
    if (current) {
      out.push(current)
      current = ''
    }
    if (s.length <= maxChars) {
      current = s
    } else {
      for (let i = 0; i < s.length; i += maxChars) {
        out.push(s.slice(i, i + maxChars))
      }
    }
  }
  if (current) out.push(current)
  return out
}
