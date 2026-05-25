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

export function checkTrigger(params: {
  isGroup: boolean
  text: string
  mentionedBot?: boolean
  replyToBot?: boolean
}): TriggerResult {
  const { isGroup, text } = params
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

  // 2. Channel-provided mention signal, e.g. WhatsApp @mention or
  // Telegram bot username mention.
  if (params.mentionedBot) return { triggered: true, reason: 'mention' }

  // 3. Reply to a bot/owner message
  if (config.triggers.replyToBotCounts && params.replyToBot) {
    return { triggered: true, reason: 'reply to bot' }
  }

  return { triggered: false, reason: 'no trigger match' }
}
