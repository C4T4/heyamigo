import { readFileSync } from 'fs'
import { basename, extname } from 'path'
import type { WAMessage, WASocket } from 'baileys'

export async function sendText(
  sock: WASocket,
  jid: string,
  text: string,
  quoted?: WAMessage,
): Promise<WAMessage | undefined> {
  return sock.sendMessage(
    jid,
    { text },
    quoted ? { quoted } : undefined,
  )
}

export type MediaType = 'image' | 'video' | 'audio' | 'document'

const EXT_MAP: Record<string, MediaType> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.mp4': 'video',
  '.avi': 'video',
  '.mov': 'video',
  '.mkv': 'video',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.opus': 'audio',
  '.m4a': 'audio',
  '.wav': 'audio',
  '.pdf': 'document',
  '.doc': 'document',
  '.docx': 'document',
  '.xls': 'document',
  '.xlsx': 'document',
  '.csv': 'document',
  '.txt': 'document',
  '.zip': 'document',
}

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.avi': 'video/avi',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
}

export function detectMediaType(filePath: string): MediaType {
  const ext = extname(filePath).toLowerCase()
  return EXT_MAP[ext] ?? 'document'
}

export async function sendFile(
  sock: WASocket,
  jid: string,
  filePath: string,
  caption?: string,
  quoted?: WAMessage,
): Promise<WAMessage | undefined> {
  const buffer = readFileSync(filePath)
  const ext = extname(filePath).toLowerCase()
  const mime = MIME_MAP[ext] ?? 'application/octet-stream'
  const type = detectMediaType(filePath)
  const opts = quoted ? { quoted } : undefined

  switch (type) {
    case 'image':
      return sock.sendMessage(
        jid,
        { image: buffer, caption: caption || undefined },
        opts,
      )
    case 'video':
      return sock.sendMessage(
        jid,
        { video: buffer, caption: caption || undefined, mimetype: mime },
        opts,
      )
    case 'audio':
      return sock.sendMessage(
        jid,
        { audio: buffer, mimetype: mime },
        opts,
      )
    case 'document':
      return sock.sendMessage(
        jid,
        {
          document: buffer,
          mimetype: mime,
          fileName: basename(filePath),
          caption: caption || undefined,
        },
        opts,
      )
  }
}
