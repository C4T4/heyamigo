// Channel adapter interface. The sender worker drains the outbound
// queue, parses each row's address (wa:dm:..., tg:dm:..., etc.), and
// dispatches to the adapter for the matching channel. Adapters are
// the *only* place that talks to a channel SDK (Baileys, Telegram bot,
// whatever). Workers stay channel-agnostic.

import type { Channel } from '../db/address.js'

export type OutboundMessage = {
  kind: 'text' | 'image' | 'video' | 'audio' | 'document'
  text?: string                // body or caption
  mediaPath?: string           // absolute path on disk (resolved by caller)
  mediaMime?: string
  quoteMsgId?: string          // reply-to message id, channel-specific
}

export type SendResult = {
  msgId: string                // channel-native id of the sent message
}

export interface ChannelAdapter {
  readonly channel: Channel
  send(externalId: string, msg: OutboundMessage): Promise<SendResult>
}

// Distinguishes between "the channel said no, try again later" and
// "the message itself is broken." Sender worker uses this to decide
// retry vs DLQ.
export class TransientChannelError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'TransientChannelError'
  }
}

export class PermanentChannelError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'PermanentChannelError'
  }
}
