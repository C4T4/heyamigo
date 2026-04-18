import { mkdir, readdir, stat, unlink } from 'fs/promises'
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import {
  downloadMediaMessage,
  extensionForMediaMessage,
  getContentType,
  type WAMessage,
} from 'baileys'
import { config } from '../config.js'
import { logger } from '../logger.js'

export type MediaInfo = {
  mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker'
  mediaPath: string
  mediaMime: string
}

const MEDIA_TYPES: Record<string, MediaInfo['mediaType']> = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
  stickerMessage: 'sticker',
}

function mediaDir(jid: string): string {
  return resolve(process.cwd(), config.storage.mediaDir, jid)
}

export function detectMediaType(
  msg: WAMessage,
): MediaInfo['mediaType'] | null {
  const content = msg.message
  if (!content) return null
  const type = getContentType(content)
  if (!type) return null
  return MEDIA_TYPES[type] ?? null
}

// Baileys' extensionForMediaMessage throws when the media's mimetype is
// undefined — happens on some forwarded documents (notably PDFs shared in
// contexts that strip metadata). Fall back to the filename's extension,
// then to .bin. Never throws.
function resolveMediaExtension(msg: WAMessage): string {
  try {
    const ext = extensionForMediaMessage(msg.message!)
    if (ext) return ext
  } catch {
    // baileys tripped on missing mimetype — try fileName instead
  }
  const content = msg.message
  if (content) {
    const type = getContentType(content)
    if (type) {
      const mediaMsg = (content as Record<string, unknown>)[type] as
        | Record<string, unknown>
        | undefined
      const fileName = mediaMsg?.fileName as string | undefined
      if (fileName) {
        const m = fileName.match(/\.([a-zA-Z0-9]+)$/)
        if (m && m[1]) return m[1].toLowerCase()
      }
    }
  }
  return 'bin'
}

export async function downloadAndSave(
  msg: WAMessage,
  jid: string,
): Promise<MediaInfo | null> {
  const mediaType = detectMediaType(msg)
  if (!mediaType) return null

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {})
    const ext = resolveMediaExtension(msg)
    const id = msg.key.id || `${Date.now()}`
    const dir = mediaDir(jid)
    await mkdir(dir, { recursive: true })
    const filename = `${id}.${ext}`
    const filePath = resolve(dir, filename)
    writeFileSync(filePath, buffer)

    const content = msg.message!
    const messageType = getContentType(content)!
    const mediaMsg = (content as Record<string, unknown>)[
      messageType
    ] as Record<string, unknown> | undefined
    const mimetype =
      (mediaMsg?.mimetype as string) ?? `application/octet-stream`

    logger.debug(
      { jid, mediaType, filename, bytes: buffer.length },
      'media saved',
    )

    return {
      mediaType,
      mediaPath: filePath,
      mediaMime: mimetype,
    }
  } catch (err) {
    logger.error({ err, jid, msgId: msg.key.id }, 'media download failed')
    return null
  }
}

export function mediaPromptTag(info: MediaInfo, caption: string): string {
  const label =
    info.mediaType === 'image'
      ? 'an image'
      : info.mediaType === 'video'
        ? 'a video'
        : info.mediaType === 'audio'
          ? 'a voice message'
          : info.mediaType === 'document'
            ? 'a document'
            : 'a sticker'
  const lines = [
    `[User sent ${label}: ${info.mediaPath}]`,
    `Read this file to see what the user sent.`,
  ]
  if (caption) lines.push(`Caption: "${caption}"`)
  return lines.join('\n')
}

/**
 * Delete media files older than retention period.
 */
export async function pruneMedia(): Promise<void> {
  const days = config.storage.mediaRetentionDays
  if (days <= 0) return
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000
  const baseDir = resolve(process.cwd(), config.storage.mediaDir)
  try {
    const jids = await readdir(baseDir, { withFileTypes: true })
    for (const jidEntry of jids) {
      if (!jidEntry.isDirectory()) continue
      const jidDir = resolve(baseDir, jidEntry.name)
      const files = await readdir(jidDir)
      for (const file of files) {
        const fp = resolve(jidDir, file)
        try {
          const s = await stat(fp)
          if (s.mtimeMs < cutoffMs) {
            await unlink(fp)
          }
        } catch {}
      }
      // remove empty jid dirs
      const remaining = await readdir(jidDir)
      if (remaining.length === 0) {
        await readdir(jidDir).then(() =>
          import('fs/promises').then((fs) => fs.rmdir(jidDir)),
        )
      }
    }
  } catch {}
}
