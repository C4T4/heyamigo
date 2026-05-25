import type { Channel } from '../db/address.js'
import type { ChatBootstrapMetadata } from '../gateway/bootstrap.js'
import type { MediaInfo } from '../store/media.js'

export type TriggerHints = {
  mentionedBot?: boolean
  replyToBot?: boolean
}

export type IncomingMessage = {
  id: string
  externalMsgId: string
  channel: Exclude<Channel, 'system'>
  address: string
  chatKey: string
  accessKey: string
  actorAddress: string | null
  senderKey: string
  senderLabel?: string
  timestamp: number
  text: string
  fromMe: boolean
  isGroup: boolean
  messageType: string
  mediaType?: MediaInfo['mediaType'] | null
  mediaBytes?: number | null
  downloadMedia?: () => Promise<MediaInfo | null>
  quoteMsgId?: string | null
  triggerHints?: TriggerHints
  selfChat?: boolean
  chat?: ChatBootstrapMetadata
  loadChatMetadata?: () => Promise<ChatBootstrapMetadata | undefined>
}

export type IncomingHandler = (msg: IncomingMessage) => Promise<void>

export interface ChannelRuntime {
  readonly channel: Exclude<Channel, 'system'>
  start(handler: IncomingHandler): Promise<void>
  stop(): Promise<void>
}

