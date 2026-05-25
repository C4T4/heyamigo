// Baileys (WhatsApp) channel adapter. Wraps the existing wa/sender.ts
// behind the ChannelAdapter interface so the sender worker stays
// channel-agnostic.
//
// The WASocket is created in src/wa/socket.ts and replaced on each
// reconnect. Boot path (or the connection callback) calls
// setBaileysSocket(sock) so the adapter always points at the live one.

import { readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'
import type { WAMessage, WASocket } from 'baileys'
import {
  PermanentChannelError,
  TransientChannelError,
  type ChannelAdapter,
  type OutboundMessage,
  type SendResult,
} from './adapter.js'

let activeSocket: WASocket | null = null

export function setBaileysSocket(sock: WASocket | null): void {
  activeSocket = sock
}

const MIME_MAP: Record<string, string> = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.mp4':  'video/mp4',
  '.avi':  'video/avi',
  '.mov':  'video/quicktime',
  '.mkv':  'video/x-matroska',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a':  'audio/mp4',
  '.wav':  'audio/wav',
  '.pdf':  'application/pdf',
  '.doc':  'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':  'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv':  'text/csv',
  '.txt':  'text/plain',
  '.zip':  'application/zip',
}

function mimeFor(filePath: string, fallback?: string): string {
  if (fallback) return fallback
  const ext = extname(filePath).toLowerCase()
  return MIME_MAP[ext] ?? 'application/octet-stream'
}

function requireSocket(): WASocket {
  if (!activeSocket) {
    // Socket isn't ready — sender worker should not have tried. This
    // becomes "retry later" so the message stays in queue until WA
    // reconnects.
    throw new TransientChannelError('baileys socket not connected')
  }
  return activeSocket
}

function requireFile(path: string): { buf: Buffer; bytes: number } {
  try {
    const stat = statSync(path)
    const buf = readFileSync(path)
    return { buf, bytes: stat.size }
  } catch (err) {
    throw new PermanentChannelError(
      `media file unreadable: ${path} (${(err as Error).message})`,
      err,
    )
  }
}

// Map a Baileys send error onto our transient/permanent classification.
// Network/connection issues → transient. Anything else (invalid jid,
// payload, etc.) → permanent.
function classifyBaileysError(err: unknown): TransientChannelError | PermanentChannelError {
  const message = err instanceof Error ? err.message : String(err)
  // Heuristic: Baileys throws "connection closed" / "timed out" /
  // "socket" for transient stuff; everything else assume permanent.
  const transientHints = [
    'connection closed',
    'connection lost',
    'timed out',
    'timeout',
    'socket',
    'lost connection',
    'no connection',
  ]
  const lower = message.toLowerCase()
  if (transientHints.some((h) => lower.includes(h))) {
    return new TransientChannelError(message, err)
  }
  return new PermanentChannelError(message, err)
}

async function sendOne(
  sock: WASocket,
  jid: string,
  msg: OutboundMessage,
): Promise<WAMessage | undefined> {
  const quoteOpts = msg.quoteMsgId
    ? // Baileys quoting actually needs the full WAMessage to embed in
      // contextInfo; we only have the id. For now we send without
      // quoting in that case (future: cache recent WAMessages keyed
      // by id so we can rehydrate the quote target).
      undefined
    : undefined

  switch (msg.kind) {
    case 'text':
      if (!msg.text) {
        throw new PermanentChannelError('text outbound has no body')
      }
      return sock.sendMessage(jid, { text: msg.text }, quoteOpts)

    case 'image': {
      if (!msg.mediaPath) {
        throw new PermanentChannelError('image outbound missing mediaPath')
      }
      const { buf } = requireFile(msg.mediaPath)
      return sock.sendMessage(
        jid,
        { image: buf, caption: msg.text ?? undefined },
        quoteOpts,
      )
    }

    case 'video': {
      if (!msg.mediaPath) {
        throw new PermanentChannelError('video outbound missing mediaPath')
      }
      const { buf } = requireFile(msg.mediaPath)
      return sock.sendMessage(
        jid,
        {
          video: buf,
          caption: msg.text ?? undefined,
          mimetype: mimeFor(msg.mediaPath, msg.mediaMime),
        },
        quoteOpts,
      )
    }

    case 'audio': {
      if (!msg.mediaPath) {
        throw new PermanentChannelError('audio outbound missing mediaPath')
      }
      const { buf } = requireFile(msg.mediaPath)
      return sock.sendMessage(
        jid,
        { audio: buf, mimetype: mimeFor(msg.mediaPath, msg.mediaMime) },
        quoteOpts,
      )
    }

    case 'document': {
      if (!msg.mediaPath) {
        throw new PermanentChannelError('document outbound missing mediaPath')
      }
      const { buf } = requireFile(msg.mediaPath)
      return sock.sendMessage(
        jid,
        {
          document: buf,
          mimetype: mimeFor(msg.mediaPath, msg.mediaMime),
          fileName: basename(msg.mediaPath),
          caption: msg.text ?? undefined,
        },
        quoteOpts,
      )
    }
  }
}

export const baileysAdapter: ChannelAdapter = {
  channel: 'wa',
  async send(externalId, msg) {
    const sock = requireSocket()
    let sent: WAMessage | undefined
    try {
      sent = await sendOne(sock, externalId, msg)
    } catch (err) {
      throw classifyBaileysError(err)
    }
    const msgId = sent?.key?.id
    if (!msgId) {
      // Baileys returned without an id; treat as transient so we retry
      // (rather than silently losing track of whether the send happened).
      throw new TransientChannelError('baileys send returned no message id')
    }
    return { msgId } satisfies SendResult
  },
}
