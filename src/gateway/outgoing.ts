import { existsSync, statSync } from 'fs'
import { extname } from 'path'
import { isJidGroup, type WAMessage } from 'baileys'
import { config } from '../config.js'
import { formatAddress, jidToAddress } from '../db/address.js'
import { logger } from '../logger.js'
import { enqueueOutbound } from '../queue/outbound.js'
import type { Job, ReplyStats, Result } from '../queue/types.js'
import { detectMediaType } from '../wa/sender.js'

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

function kindForFile(filePath: string): 'image' | 'video' | 'audio' | 'document' {
  return detectMediaType(filePath)
}

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.avi': 'video/avi', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv', '.txt': 'text/plain', '.zip': 'application/zip',
}

function mimeFor(filePath: string): string {
  return MIME_MAP[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function fileSize(filePath: string): number | undefined {
  try { return statSync(filePath).size } catch { return undefined }
}

// `originalMsg` is currently ignored when routing through the outbound
// queue — Baileys quoting needs the full WAMessage embedded in
// contextInfo, which we'd have to serialize through the DB row and
// reconstruct. Known regression for Phase 1; see refactor-scrap.md.
// Kept in the signature so existing callers don't change.
export async function handleReply(
  job: Job,
  result: Result,
  _originalMsg: WAMessage,
): Promise<void> {
  const raw = result.reply?.replaceAll('—', ', ').replaceAll('–', '-')
  if (!raw) return

  const { text, files } = extractFiles(raw)
  const isGroup = isJidGroup(job.jid) === true
  void isGroup // quoting deferred; see comment above

  const address = formatAddress(jidToAddress(job.jid))

  // Surface media tags in the footer too. Files already parsed above
  // — just map each to its kind so the footer reads e.g. "+2 image".
  const mediaKinds = files.map(kindForFile)
  const footer =
    result.stats && config.reply.showStats
      ? formatStatsFooter(result.stats, { mediaKinds })
      : ''

  let pieceIdx = 0
  const baseKey = `reply-${job.jid}-${Date.now()}`
  const enqueuePiece = (input: Parameters<typeof enqueueOutbound>[0]) => {
    enqueueOutbound({ ...input, idempotencyKey: `${baseKey}-${pieceIdx++}` })
  }

  // Files first. Caption goes on the single-file-with-short-text case,
  // matching pre-refactor behavior.
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]!
    const isFirst = i === 0
    const kind = kindForFile(filePath)
    const supportsCaption = kind !== 'audio'
    const caption =
      isFirst && text && text.length <= 1000 && files.length === 1 && supportsCaption
        ? text
        : undefined
    const willHaveTextAfter =
      !!text && !(files.length === 1 && text.length <= 1000 && supportsCaption)
    const captionForSend =
      caption && footer && !willHaveTextAfter
        ? `${caption}\n\n${footer}`
        : caption
    enqueuePiece({
      address,
      kind,
      text:       captionForSend,
      mediaPath:  filePath,
      mediaMime:  mimeFor(filePath),
      mediaBytes: fileSize(filePath),
    })
  }

  // Text — skip if already used as a caption on a single file.
  const textAlreadySent =
    files.length === 1 &&
    text &&
    text.length <= 1000 &&
    kindForFile(files[0]!) !== 'audio'

  if (text && !textAlreadySent) {
    const chunks = chunkText(text, config.reply.chunkChars)
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      const isLast = i === chunks.length - 1
      const chunkForSend = isLast && footer ? `${chunk}\n\n${footer}` : chunk
      enqueuePiece({ address, kind: 'text', text: chunkForSend })
    }
  }

  // Job cards (ETAs for delegated async/browser tasks) go LAST so
  // they arrive after the agent's reply chunks in chat. Each card
  // has its own producer-supplied idempotencyKey; we don't slot them
  // into the piece-numbered key space.
  for (const card of result.jobCards ?? []) {
    enqueueOutbound({
      address,
      kind: 'text',
      text: card.text,
      idempotencyKey: card.idempotencyKey,
    })
  }

  logger.info(
    {
      jid: job.jid,
      files: files.length,
      chars: text.length,
      pieces: pieceIdx,
      cards: result.jobCards?.length ?? 0,
    },
    'reply enqueued for outbound',
  )
}

// Proactive outbound: send a message to a chat without an incoming
// trigger. Same parsing as handleReply; enqueues outbound rows.
// `text` may contain [FILE:...] tags; they're extracted and enqueued
// as media. Returns true if anything was enqueued.
export async function initiate(params: {
  jid: string
  text: string
}): Promise<boolean> {
  const raw = params.text.replaceAll('—', ', ').replaceAll('–', '-')
  if (!raw.trim()) return false

  const { text, files } = extractFiles(raw)
  if (!text && files.length === 0) return false

  const address = formatAddress(jidToAddress(params.jid))
  let pieceIdx = 0
  const baseKey = `initiate-${params.jid}-${Date.now()}`
  const enqueuePiece = (input: Parameters<typeof enqueueOutbound>[0]) => {
    enqueueOutbound({ ...input, idempotencyKey: `${baseKey}-${pieceIdx++}` })
  }

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]!
    const isFirst = i === 0
    const kind = kindForFile(filePath)
    const supportsCaption = kind !== 'audio'
    const caption =
      isFirst && text && text.length <= 1000 && files.length === 1 && supportsCaption
        ? text
        : undefined
    enqueuePiece({
      address,
      kind,
      text:       caption,
      mediaPath:  filePath,
      mediaMime:  mimeFor(filePath),
      mediaBytes: fileSize(filePath),
    })
  }

  const textAlreadySent =
    files.length === 1 &&
    text &&
    text.length <= 1000 &&
    kindForFile(files[0]!) !== 'audio'

  if (text && !textAlreadySent) {
    const chunks = chunkText(text, config.reply.chunkChars)
    for (const chunk of chunks) {
      enqueuePiece({ address, kind: 'text', text: chunk })
    }
  }

  logger.info(
    { jid: params.jid, files: files.length, chars: text.length, pieces: pieceIdx },
    'proactive message enqueued for outbound',
  )
  return pieceIdx > 0
}

// Append-only-at-send footer. Never stored, never in Claude's recent-context
// feedback loop. Adaptive: shows only what's interesting for this reply.
// `mediaKinds` is the array of [IMAGE/VIDEO/AUDIO/DOCUMENT] tags the agent
// emitted in this reply — they're parsed out of the text in handleReply so
// we forward them here for footer rendering.
export function formatStatsFooter(
  stats: ReplyStats,
  extras?: { mediaKinds?: readonly string[] },
): string {
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

  // Context % — only when worth calling out. Skipped when pct is
  // implausible (>120%) — usually means cumulative/per-turn token
  // counts got crossed by a stale session. Better to show nothing
  // than display "7018% ctx" and lose user trust.
  if (stats.contextWindow > 0) {
    const pct = Math.round(
      (stats.totalContextTokens / stats.contextWindow) * 100,
    )
    if (pct > 120) {
      // skip — data is stale or inconsistent
    } else if (pct >= 90) {
      parts.push(`⚠ ${pct}% ctx`)
    } else if (pct >= 70) {
      parts.push(`${pct}% ctx`)
    }
  }

  if (stats.fresh) parts.push('fresh')

  // Side-effect tags. Order: scheduling first (most "did it work?"
  // value for the user), then delegations, then content side effects.
  const plus = (label: string, n: number) =>
    n === 1 ? `+${label}` : `+${n} ${label}`

  if (stats.remindCount > 0)       parts.push(plus('remind', stats.remindCount))
  if (stats.cronCount > 0)         parts.push(plus('cron', stats.cronCount))
  if (stats.asyncBrowserCount > 0) parts.push(plus('browser', stats.asyncBrowserCount))
  if (stats.asyncCount > 0)        parts.push(plus('async', stats.asyncCount))
  for (const slug of stats.journalSlugs) parts.push(`+journal:${slug}`)
  if (stats.journalCreateCount > 0) parts.push(plus('journal-new', stats.journalCreateCount))
  if (stats.hasDigest) parts.push('+digest')
  if (stats.sendTextCount > 0)     parts.push(plus('send-text', stats.sendTextCount))
  // Thread watchlist — loud events only. Updates/cools are intentional
  // no-ops in the footer (would clutter normal conversation).
  if (stats.threadNewCount > 0)      parts.push(plus('thread-new', stats.threadNewCount))
  if (stats.threadTouchCount > 0)    parts.push(plus('thread-touch', stats.threadTouchCount))
  if (stats.threadResolveCount > 0)  parts.push(plus('thread-resolve', stats.threadResolveCount))
  if (stats.threadDropCount > 0)     parts.push(plus('thread-drop', stats.threadDropCount))
  if (stats.threadCompressCount > 0) parts.push(plus('thread-compress', stats.threadCompressCount))

  // Media — counted per-kind from the file list. e.g. +2 image, +video.
  // 'document' shortened to 'doc' to keep the footer tight.
  const mediaKinds = extras?.mediaKinds ?? []
  if (mediaKinds.length > 0) {
    const byKind = new Map<string, number>()
    for (const k of mediaKinds) {
      const short = k === 'document' ? 'doc' : k
      byKind.set(short, (byKind.get(short) ?? 0) + 1)
    }
    for (const [kind, n] of byKind) parts.push(plus(kind, n))
  }

  return `_${parts.join(' · ')}_`
}

function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
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
