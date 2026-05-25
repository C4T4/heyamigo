// Channel-agnostic address shape. Inbound, outbound, async, browser,
// and crons all carry an Address string. Sender worker parses the
// channel prefix and dispatches to the matching ChannelAdapter.
//
// Serialized form (the wire shape stored in DB columns):
//   wa:dm:17867@s.whatsapp.net
//   wa:group:120363@g.us
//   tg:dm:user_12345
//   tg:group:-100123456
//   system:cron:42
//
// First two segments are well-known. The third is the platform-native
// external id, kept verbatim — easier to debug, lossless round-trip.

export type Channel = 'wa' | 'tg' | 'system'
export type Scope = 'dm' | 'group' | 'cron' | 'task'

export type Address = {
  channel: Channel
  scope: Scope
  externalId: string
}

export function formatAddress(addr: Address): string {
  return `${addr.channel}:${addr.scope}:${addr.externalId}`
}

export function parseAddress(s: string): Address {
  const idx1 = s.indexOf(':')
  const idx2 = s.indexOf(':', idx1 + 1)
  if (idx1 < 0 || idx2 < 0) {
    throw new Error(`bad address (need channel:scope:external_id): ${s}`)
  }
  const channel = s.slice(0, idx1) as Channel
  const scope = s.slice(idx1 + 1, idx2) as Scope
  const externalId = s.slice(idx2 + 1)
  if (!externalId) throw new Error(`bad address (empty external id): ${s}`)
  return { channel, scope, externalId }
}

// Convert a raw Baileys JID into our address form. JID suffixes:
//   @s.whatsapp.net → wa:dm
//   @g.us           → wa:group
//   @lid            → wa:dm (LID identities; canonicalized to wa:dm)
//   @newsletter     → wa:group (broadcast/channel, treat as group-like)
//
// The full JID stays in externalId so it round-trips losslessly.
export function jidToAddress(jid: string): Address {
  if (jid.endsWith('@g.us')) {
    return { channel: 'wa', scope: 'group', externalId: jid }
  }
  if (jid.endsWith('@newsletter')) {
    return { channel: 'wa', scope: 'group', externalId: jid }
  }
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) {
    return { channel: 'wa', scope: 'dm', externalId: jid }
  }
  // Unknown WA jid shape — preserve verbatim, default to DM.
  return { channel: 'wa', scope: 'dm', externalId: jid }
}

// Reverse: pull the platform-native id back out. For WA this is the
// JID; ChannelAdapter implementations use it directly.
export function addressToExternalId(addr: Address | string): string {
  const a = typeof addr === 'string' ? parseAddress(addr) : addr
  return a.externalId
}

export function addressToChatKey(addr: Address | string): string {
  const a = typeof addr === 'string' ? parseAddress(addr) : addr
  if (a.channel === 'wa') return a.externalId
  return `${a.channel}_${a.scope}_${a.externalId}`.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

export function actorKeyFromAddress(addr: Address | string): string {
  const a = typeof addr === 'string' ? parseAddress(addr) : addr
  if (a.channel === 'wa') {
    return a.externalId.split('@')[0]?.split(':')[0] ?? a.externalId
  }
  return `${a.channel}_${a.externalId}`.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

// Convenience predicates.
export function isGroup(addr: Address | string): boolean {
  const a = typeof addr === 'string' ? parseAddress(addr) : addr
  return a.scope === 'group'
}

export function isDm(addr: Address | string): boolean {
  const a = typeof addr === 'string' ? parseAddress(addr) : addr
  return a.scope === 'dm'
}

// System addresses for bot-internal flows (cron-fired self-prompts,
// task-spawned messages without an originating chat).
export function systemCronAddress(cronId: string | number): string {
  return `system:cron:${cronId}`
}

export function systemTaskAddress(taskId: string): string {
  return `system:task:${taskId}`
}
