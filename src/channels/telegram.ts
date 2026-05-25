import { readFileSync, statSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { basename, extname, resolve } from 'path'
import { config } from '../config.js'
import {
  actorKeyFromAddress,
  addressToChatKey,
  formatAddress,
  type Address,
} from '../db/address.js'
import { logger } from '../logger.js'
import type { MediaInfo } from '../store/media.js'
import {
  PermanentChannelError,
  TransientChannelError,
  type ChannelAdapter,
  type OutboundMessage,
  type SendResult,
} from './adapter.js'
import type { ChannelRuntime, IncomingHandler, IncomingMessage } from './runtime.js'

type TelegramApiResponse<T> = {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

type TelegramChat = {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

type TelegramUser = {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

type TelegramFileRef = {
  file_id: string
  file_unique_id?: string
  file_size?: number
}

type TelegramDocument = TelegramFileRef & {
  file_name?: string
  mime_type?: string
}

type TelegramMessage = {
  message_id: number
  date: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
  caption?: string
  photo?: TelegramFileRef[]
  document?: TelegramDocument
  video?: TelegramDocument
  audio?: TelegramDocument
  voice?: TelegramDocument
  sticker?: TelegramDocument
  reply_to_message?: TelegramMessage
}

type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
}

type TelegramSentMessage = {
  message_id: number
}

type TelegramGetMe = TelegramUser & {
  username: string
}

type TelegramGetFile = {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_path?: string
}

type TelegramMediaRef = {
  mediaType: MediaInfo['mediaType']
  fileId: string
  bytes: number | null
  mime: string
  fileName?: string
}

let running = false
let loopPromise: Promise<void> | null = null
let botIdentity: TelegramGetMe | null = null

function botToken(): string {
  const token = config.telegram.botToken?.trim()
  if (!token) {
    throw new PermanentChannelError('telegram.botToken is not configured')
  }
  return token
}

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${botToken()}/${method}`
}

function fileUrl(path: string): string {
  return `https://api.telegram.org/file/bot${botToken()}/${path}`
}

async function parseTelegramResponse<T>(res: Response): Promise<T> {
  let body: TelegramApiResponse<T>
  try {
    body = await res.json() as TelegramApiResponse<T>
  } catch (err) {
    if (res.status >= 500 || res.status === 429) {
      throw new TransientChannelError(`telegram HTTP ${res.status}`, err)
    }
    throw new PermanentChannelError(`telegram HTTP ${res.status}`, err)
  }

  if (!res.ok || !body.ok || body.result === undefined) {
    const message = body.description || `telegram HTTP ${res.status}`
    if (res.status >= 500 || res.status === 429 || body.error_code === 429) {
      throw new TransientChannelError(message)
    }
    throw new PermanentChannelError(message)
  }
  return body.result
}

async function telegramJson<T>(
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(apiUrl(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return parseTelegramResponse<T>(res)
}

async function telegramForm<T>(method: string, form: FormData): Promise<T> {
  const res = await fetch(apiUrl(method), {
    method: 'POST',
    body: form,
  })
  return parseTelegramResponse<T>(res)
}

function classifyUnexpected(err: unknown): TransientChannelError | PermanentChannelError {
  if (err instanceof TransientChannelError || err instanceof PermanentChannelError) {
    return err
  }
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  if (
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('econnreset')
  ) {
    return new TransientChannelError(message, err)
  }
  return new PermanentChannelError(message, err)
}

function mimeFor(filePath: string, fallback?: string): string {
  if (fallback) return fallback
  const ext = extname(filePath).toLowerCase()
  return MIME_MAP[ext] ?? 'application/octet-stream'
}

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
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

function appendReply(form: FormData, msg: OutboundMessage): void {
  if (msg.quoteMsgId) form.append('reply_to_message_id', msg.quoteMsgId)
}

function appendMediaFile(
  form: FormData,
  field: string,
  msg: OutboundMessage,
): void {
  if (!msg.mediaPath) {
    throw new PermanentChannelError(`${msg.kind} outbound missing mediaPath`)
  }
  const { buf } = requireFile(msg.mediaPath)
  const blob = new Blob([buf], { type: mimeFor(msg.mediaPath, msg.mediaMime) })
  form.append(field, blob, basename(msg.mediaPath))
}

async function sendMedia(
  method: string,
  field: string,
  chatId: string,
  msg: OutboundMessage,
): Promise<SendResult> {
  const form = new FormData()
  form.append('chat_id', chatId)
  appendMediaFile(form, field, msg)
  if (msg.text && msg.kind !== 'audio') form.append('caption', msg.text)
  appendReply(form, msg)
  const sent = await telegramForm<TelegramSentMessage>(method, form)
  return { msgId: String(sent.message_id) }
}

export const telegramAdapter: ChannelAdapter = {
  channel: 'tg',
  async sendTyping(externalId, state) {
    if (state === 'paused') return
    try {
      await telegramJson('sendChatAction', {
        chat_id: externalId,
        action: 'typing',
      })
    } catch {
      // typing is a UX hint; never block real work on it
    }
  },
  async send(externalId, msg) {
    try {
      switch (msg.kind) {
        case 'text': {
          if (!msg.text) throw new PermanentChannelError('text outbound has no body')
          const sent = await telegramJson<TelegramSentMessage>('sendMessage', {
            chat_id: externalId,
            text: msg.text,
            reply_to_message_id: msg.quoteMsgId,
          })
          return { msgId: String(sent.message_id) }
        }
        case 'image':
          return sendMedia('sendPhoto', 'photo', externalId, msg)
        case 'video':
          return sendMedia('sendVideo', 'video', externalId, msg)
        case 'audio':
          return sendMedia('sendAudio', 'audio', externalId, msg)
        case 'document':
          return sendMedia('sendDocument', 'document', externalId, msg)
      }
    } catch (err) {
      throw classifyUnexpected(err)
    }
  },
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function ensureBotIdentity(): Promise<TelegramGetMe> {
  if (botIdentity) return botIdentity
  botIdentity = await telegramJson<TelegramGetMe>('getMe', {})
  return botIdentity
}

async function pollLoop(handler: IncomingHandler): Promise<void> {
  const me = await ensureBotIdentity()
  let offset = 0
  logger.info(
    { username: me.username },
    'telegram polling started',
  )

  while (running) {
    try {
      const updates = await telegramJson<TelegramUpdate[]>('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message'],
      })
      for (const update of updates) {
        offset = update.update_id + 1
        if (!update.message) continue
        const incoming = toIncomingMessage(update.message, me)
        if (!incoming) continue
        await handler(incoming)
      }
    } catch (err) {
      logger.error({ err }, 'telegram polling failed')
      await delay(config.telegram.pollIntervalMs)
    }
  }
}

export const telegramRuntime: ChannelRuntime = {
  channel: 'tg',
  async start(handler) {
    if (!config.telegram.enabled) return
    if (running) {
      logger.warn('telegram runtime already started; ignoring')
      return
    }
    running = true
    loopPromise = pollLoop(handler).catch((err) => {
      running = false
      logger.error({ err }, 'telegram polling stopped')
    })
  },
  async stop() {
    running = false
    await loopPromise?.catch(() => undefined)
    loopPromise = null
  },
}

function nameForUser(user: TelegramUser | undefined): string | undefined {
  if (!user) return undefined
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  if (user.username && full) return `${full} (@${user.username})`
  return full || (user.username ? `@${user.username}` : undefined)
}

function chatName(chat: TelegramChat): string | undefined {
  if (chat.title) return chat.title
  const full = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim()
  if (chat.username && full) return `${full} (@${chat.username})`
  return full || (chat.username ? `@${chat.username}` : undefined)
}

function addressForChat(chat: TelegramChat): string {
  const scope: Address['scope'] = chat.type === 'private' ? 'dm' : 'group'
  return formatAddress({
    channel: 'tg',
    scope,
    externalId: String(chat.id),
  })
}

function mediaRef(msg: TelegramMessage): TelegramMediaRef | null {
  const photo = msg.photo?.slice().sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).at(-1)
  if (photo) {
    return {
      mediaType: 'image',
      fileId: photo.file_id,
      bytes: photo.file_size ?? null,
      mime: 'image/jpeg',
      fileName: `${msg.message_id}.jpg`,
    }
  }
  if (msg.video) return fileRef('video', msg.video, 'video/mp4')
  if (msg.audio) return fileRef('audio', msg.audio, msg.audio.mime_type ?? 'audio/mpeg')
  if (msg.voice) return fileRef('audio', msg.voice, msg.voice.mime_type ?? 'audio/ogg')
  if (msg.document) return fileRef('document', msg.document, msg.document.mime_type ?? 'application/octet-stream')
  if (msg.sticker) return fileRef('sticker', msg.sticker, msg.sticker.mime_type ?? 'image/webp')
  return null
}

function fileRef(
  mediaType: MediaInfo['mediaType'],
  doc: TelegramDocument,
  fallbackMime: string,
): TelegramMediaRef {
  return {
    mediaType,
    fileId: doc.file_id,
    bytes: doc.file_size ?? null,
    mime: doc.mime_type ?? fallbackMime,
    fileName: doc.file_name,
  }
}

function toIncomingMessage(
  msg: TelegramMessage,
  me: TelegramGetMe,
): IncomingMessage | null {
  if (msg.from?.id === me.id) return null
  if (msg.chat.type === 'channel') return null

  const address = addressForChat(msg.chat)
  const actorAddress = msg.from
    ? formatAddress({ channel: 'tg', scope: 'dm', externalId: String(msg.from.id) })
    : null
  const media = mediaRef(msg)
  const text = msg.text ?? msg.caption ?? ''
  const lowerText = text.toLowerCase()
  const botMention = me.username
    ? lowerText.includes(`@${me.username.toLowerCase()}`)
    : false

  return {
    id: String(msg.message_id),
    externalMsgId: `tg:${msg.chat.id}:${msg.message_id}`,
    channel: 'tg',
    address,
    chatKey: addressToChatKey(address),
    accessKey: address,
    actorAddress,
    senderKey: actorAddress ? actorKeyFromAddress(actorAddress) : 'tg_unknown',
    senderLabel: nameForUser(msg.from),
    timestamp: msg.date,
    text,
    fromMe: false,
    isGroup: msg.chat.type !== 'private',
    messageType: messageType(msg),
    mediaType: media?.mediaType ?? null,
    mediaBytes: media?.bytes ?? null,
    downloadMedia: media ? () => downloadTelegramMedia(media, address, msg.message_id) : undefined,
    quoteMsgId: String(msg.message_id),
    triggerHints: {
      mentionedBot: botMention,
      replyToBot: msg.reply_to_message?.from?.id === me.id,
    },
    chat: {
      platform: 'Telegram',
      isGroup: msg.chat.type !== 'private',
      chatName: chatName(msg.chat),
      externalId: String(msg.chat.id),
    },
  }
}

function messageType(msg: TelegramMessage): string {
  if (msg.text) return 'text'
  if (msg.photo) return 'photo'
  if (msg.video) return 'video'
  if (msg.audio) return 'audio'
  if (msg.voice) return 'voice'
  if (msg.document) return 'document'
  if (msg.sticker) return 'sticker'
  return 'unknown'
}

function extForMedia(media: TelegramMediaRef, filePath?: string): string {
  const fromName = media.fileName && extname(media.fileName)
  if (fromName) return fromName
  const fromPath = filePath && extname(filePath)
  if (fromPath) return fromPath
  for (const [ext, mime] of Object.entries(MIME_MAP)) {
    if (mime === media.mime) return ext
  }
  return '.bin'
}

async function downloadTelegramMedia(
  media: TelegramMediaRef,
  address: string,
  messageId: number,
): Promise<MediaInfo | null> {
  try {
    const file = await telegramJson<TelegramGetFile>('getFile', {
      file_id: media.fileId,
    })
    if (!file.file_path) {
      logger.warn({ messageId }, 'telegram getFile returned no file_path')
      return null
    }
    const res = await fetch(fileUrl(file.file_path))
    if (!res.ok) {
      logger.warn(
        { status: res.status, messageId },
        'telegram media download failed',
      )
      return null
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    const dir = resolve(process.cwd(), config.storage.mediaDir, addressToChatKey(address))
    await mkdir(dir, { recursive: true })
    const ext = extForMedia(media, file.file_path)
    const filename = `${messageId}${ext}`
    const filePath = resolve(dir, filename)
    await writeFile(filePath, buffer)
    return {
      mediaType: media.mediaType,
      mediaPath: filePath,
      mediaMime: media.mime,
      bytes: buffer.length,
    }
  } catch (err) {
    logger.error({ err, messageId }, 'telegram media download failed')
    return null
  }
}
