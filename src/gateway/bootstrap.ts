import { config } from '../config.js'
import { readLast, type StoredMessage } from '../store/messages.js'

export type ChatBootstrapMetadata = {
  platform: string
  isGroup: boolean
  chatName?: string
  memberSummary?: string
  externalId?: string
}

export type BuildInitParams = {
  jid: string
  userText: string
  userNumber: string
  chat?: ChatBootstrapMetadata
}

export async function buildInitPayload(
  params: BuildInitParams,
): Promise<string> {
  const { jid, userText, userNumber } = params
  const chat = params.chat ?? {
    platform: 'WhatsApp',
    isGroup: jid.endsWith('@g.us'),
    externalId: jid,
  }
  const lines: string[] = []

  if (config.bootstrap.includeChatMetadata) {
    lines.push(`You are the assistant behind a ${chat.platform} chat.`)
    if (chat.isGroup) {
      lines.push(`Chat type: group`)
      lines.push(`Chat name: "${chat.chatName || 'unknown'}"`)
      if (chat.memberSummary) lines.push(`Members: ${chat.memberSummary}`)
    } else {
      lines.push(`Chat type: direct message`)
    }
    lines.push(`Chat key: ${jid}`)
    if (chat.externalId && chat.externalId !== jid) {
      lines.push(`External id: ${chat.externalId}`)
    }
    lines.push('')
  }

  if (config.bootstrap.includeHistory) {
    const history = await readLast(jid, config.bootstrap.historyDepth)
    const prior = history.slice(0, -1) // exclude current message (appended already)
    if (prior.length) {
      lines.push('[Prior conversation history]')
      for (const m of prior) lines.push(formatLine(m))
      lines.push('')
    }
  }

  lines.push('[Current message]')
  lines.push(`${userNumber}: ${userText}`)
  return lines.join('\n')
}

function formatLine(m: StoredMessage): string {
  const date = new Date(m.timestamp * 1000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ')
  const who =
    m.direction === 'out' ? 'assistant' : m.pushName || m.senderNumber || 'user'
  return `${who} (${date}): ${m.text}`
}

export async function buildRecentContext(
  jid: string,
  depth: number,
): Promise<string> {
  if (depth <= 0) return ''
  const history = await readLast(jid, depth + 1)
  const prior = history.slice(0, -1)
  if (!prior.length) return ''
  const lines = ['[Recent context — messages preceding the current one]']
  for (const m of prior) lines.push(formatLine(m))
  lines.push('')
  return lines.join('\n')
}
