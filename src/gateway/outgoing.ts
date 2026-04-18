import { existsSync, unlinkSync } from 'fs'
import { isJidGroup, type WAMessage } from 'baileys'
import { config } from '../config.js'
import { logger } from '../logger.js'
import type { Job, ReplyStats, Result } from '../queue/types.js'
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

  const footer =
    result.stats && config.reply.showStats
      ? formatStatsFooter(result.stats)
      : ''

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
      // Append footer to caption at send time only (not to storage). Only
      // when this media file is the final user-facing payload (no text
      // coming after, single file with caption case).
      const willHaveTextAfter =
        !!text &&
        !(files.length === 1 && text.length <= 1000 && supportsCaption)
      const captionForSend =
        caption && footer && !willHaveTextAfter
          ? `${caption}\n\n${footer}`
          : caption
      await sendFile(
        sock,
        job.jid,
        filePath,
        captionForSend,
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
        const isLast = i === chunks.length - 1
        const chunkForSend =
          isLast && footer ? `${chunk}\n\n${footer}` : chunk
        await sendText(sock, job.jid, chunkForSend, q)

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

// Append-only-at-send footer. Never stored, never in Claude's recent-context
// feedback loop. Adaptive: shows only what's interesting for this reply.
export function formatStatsFooter(stats: ReplyStats): string {
  const parts: string[] = []

  // Duration — always
  const secs = stats.durationMs / 1000
  parts.push(secs < 10 ? `${secs.toFixed(1)}s` : `${Math.round(secs)}s`)

  // Tokens in / out — always. Show cache hit only when it's meaningful.
  const inStr = compactTokens(stats.inputTokens + stats.cacheReadTokens)
  const outStr = compactTokens(stats.outputTokens)
  const cacheStr =
    stats.cacheReadTokens >= 500
      ? ` (${compactTokens(stats.cacheReadTokens)} cached)`
      : ''
  parts.push(`${inStr}↑${cacheStr} ${outStr}↓`)

  // Context % — only when worth calling out
  if (stats.contextWindow > 0) {
    const pct = Math.round(
      (stats.totalContextTokens / stats.contextWindow) * 100,
    )
    if (pct >= 90) parts.push(`⚠ ${pct}% ctx`)
    else if (pct >= 70) parts.push(`${pct}% ctx`)
  }

  // Fresh session — resume is default, says nothing
  if (stats.fresh) parts.push('fresh')

  // Journal flagged — show each slug (usually 0 or 1)
  for (const slug of stats.journalSlugs) parts.push(`+journal:${slug}`)

  // Digest fired
  if (stats.hasDigest) parts.push('+digest')

  // Async spawned
  if (stats.asyncCount > 0) {
    parts.push(
      stats.asyncCount === 1 ? '+async' : `+${stats.asyncCount} async`,
    )
  }

  return `_${parts.join(' · ')}_`
}

function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
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
