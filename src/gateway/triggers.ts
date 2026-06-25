import { config } from '../config.js'
import type { TriggerMode } from '../config.js'

export type TriggerResult = {
  triggered: boolean
  reason: string
}

type AudioAliasMatch = {
  alias: string
  variant: string
}

const AUDIO_ALIAS_VARIANTS: Record<string, string[]> = {
  heyamigo: [
    'hey amigo',
    'hey amigos',
    'hey amego',
    'hey amico',
    'hey a migo',
    'hay amigo',
    'hi amigo',
  ],
  amigo: [
    'a migo',
    'amego',
    'amico',
    'amigos',
    'amiga',
    'migo',
  ],
  claude: [
    'cloud',
    'clawd',
    'clawed',
    'clod',
    'clode',
    'cload',
    'clout',
    'claut',
    'clause',
    'claus',
  ],
  clawd: [
    'claude',
    'cloud',
    'clawed',
    'clod',
    'clode',
    'cload',
    'clout',
    'claut',
  ],
  grok: [
    'grock',
    'grog',
    'gronk',
    'grawk',
    'groc',
  ],
  codex: [
    'code x',
    'codec',
    'codecs',
    'codecks',
    'codicks',
    'kodeks',
    'codacs',
  ],
  xai: [
    'x ai',
    'x a i',
    'ex ai',
    'ex a i',
    'x.ai',
  ],
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

function normalizeAudioText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function phraseMatches(normalizedText: string, phrase: string): boolean {
  const normalizedPhrase = normalizeAudioText(phrase)
  if (!normalizedPhrase) return false
  const re = new RegExp(`(^| )${escapeRegex(normalizedPhrase)}($| )`, 'i')
  return re.test(normalizedText)
}

function wakePhraseMatches(normalizedText: string, phrase: string): boolean {
  const normalizedPhrase = normalizeAudioText(phrase)
  if (!normalizedPhrase) return false
  const wake = '(hey|hi|hello|yo|ok|okay|oye|hola)'
  const re = new RegExp(
    `(^| )${wake} ${escapeRegex(normalizedPhrase)}($| )`,
    'i',
  )
  return re.test(normalizedText)
}

function audioAliasMatches(
  transcript: string,
  aliases: string[],
): AudioAliasMatch | null {
  const normalizedTranscript = normalizeAudioText(transcript)
  if (!normalizedTranscript) return null

  for (const alias of aliases) {
    const normalizedAlias = normalizeAudioText(alias)
    if (phraseMatches(normalizedTranscript, normalizedAlias)) {
      return { alias, variant: normalizedAlias }
    }

    const variants = new Set<string>([
      ...(AUDIO_ALIAS_VARIANTS[normalizedAlias] ?? []),
    ])
    for (const variant of variants) {
      if (wakePhraseMatches(normalizedTranscript, variant)) {
        return { alias, variant: normalizeAudioText(variant) }
      }
    }
  }
  return null
}

export function checkTrigger(params: {
  mode: TriggerMode
  text: string
  audioTranscript?: string
  mentionedBot?: boolean
  replyToBot?: boolean
}): TriggerResult {
  const { mode, text } = params

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

  const audioAlias = params.audioTranscript
    ? audioAliasMatches(params.audioTranscript, config.triggers.aliases)
    : null
  if (audioAlias) {
    return {
      triggered: true,
      reason: `audio-alias:${audioAlias.alias}~${audioAlias.variant}`,
    }
  }

  // 2. Channel-provided mention signal, e.g. WhatsApp @mention or
  // Telegram bot username mention.
  if (params.mentionedBot) return { triggered: true, reason: 'mention' }

  // 3. Reply to a bot/owner message
  if (config.triggers.replyToBotCounts && params.replyToBot) {
    return { triggered: true, reason: 'reply to bot' }
  }

  return { triggered: false, reason: 'no trigger match' }
}
