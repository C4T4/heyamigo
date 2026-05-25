// Channel adapter registry. Sender worker calls getChannelAdapter(name)
// keyed off the parsed address.channel.

import type { Channel } from '../db/address.js'
import type { ChannelAdapter } from './adapter.js'
import { baileysAdapter } from './baileys.js'
import { telegramAdapter } from './telegram.js'

const REGISTRY: Partial<Record<Channel, ChannelAdapter>> = {
  wa: baileysAdapter,
  tg: telegramAdapter,
}

export function getChannelAdapter(channel: Channel): ChannelAdapter {
  const adapter = REGISTRY[channel]
  if (!adapter) {
    throw new Error(`no channel adapter registered for channel="${channel}"`)
  }
  return adapter
}

export { setBaileysSocket } from './baileys.js'
export type { ChannelAdapter, OutboundMessage, SendResult } from './adapter.js'
export {
  PermanentChannelError,
  TransientChannelError,
} from './adapter.js'
