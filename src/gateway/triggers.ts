import { jidDecode, type WAMessage, type WASocket } from 'baileys'
import { config } from '../config.js'

export type TriggerResult = {
  triggered: boolean
  reason: string
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function aliasMatches(text: string, aliases: string[]): string | null {
  for (const alias of aliases) {
    const re = new RegExp(
      `(^|[^a-zA-Z0-9_])${escapeRegex(alias)}([^a-zA-Z0-9_]|$)`,
      'i',
    )
    if (re.test(text)) return alias
  }
  return null
}

function ownerNumbers(sock: WASocket): Set<string> {
  const out = new Set<string>()
  if (config.owner.number) out.add(config.owner.number)
  const pn = sock.user?.id ? jidDecode(sock.user.id)?.user : undefined
  if (pn) out.add(pn)
  const lid = sock.user?.lid ? jidDecode(sock.user.lid)?.user : undefined
  if (lid) out.add(lid)
  return out
}

export function checkTrigger(params: {
  isGroup: boolean
  text: string
  msg: WAMessage
  sock: WASocket
}): TriggerResult {
  const { isGroup, text, msg, sock } = params
  const mode = isGroup
    ? config.triggers.groupMode
    : config.triggers.dmMode

  if (mode === 'off') return { triggered: false, reason: 'mode=off' }
  if (mode === 'all') return { triggered: true, reason: 'mode=all' }

  const prefix = config.commands.prefix
  if (mode === 'command') {
    return text.trim().startsWith(prefix)
      ? { triggered: true, reason: 'command prefix' }
      : { triggered: false, reason: 'no command prefix' }
  }

  // mode === 'mention'

  // 1. Alias in text (word boundary, case insensitive)
  const alias = aliasMatches(text, config.triggers.aliases)
  if (alias) return { triggered: true, reason: `alias:${alias}` }

  // Extract contextInfo from any message type (text, image, video, etc.)
  const content = msg.message ?? {}
  const contextInfo =
    (content.extendedTextMessage?.contextInfo) ??
    (content.imageMessage?.contextInfo) ??
    (content.videoMessage?.contextInfo) ??
    (content.audioMessage?.contextInfo) ??
    (content.documentMessage?.contextInfo) ??
    (content.documentWithCaptionMessage?.message?.documentMessage?.contextInfo) ??
    (content.stickerMessage?.contextInfo)

  // 2. WA @mention pointing at owner
  const owners = ownerNumbers(sock)
  const mentioned = contextInfo?.mentionedJid ?? []
  for (const m of mentioned) {
    const user = jidDecode(m)?.user
    if (user && owners.has(user)) {
      return { triggered: true, reason: 'wa mention' }
    }
  }

  // 3. Reply to a bot/owner message
  if (config.triggers.replyToBotCounts) {
    const quotedParticipant = contextInfo?.participant
    if (quotedParticipant) {
      const user = jidDecode(quotedParticipant)?.user
      if (user && owners.has(user)) {
        return { triggered: true, reason: 'reply to bot' }
      }
    }
  }

  return { triggered: false, reason: 'no trigger match' }
}
