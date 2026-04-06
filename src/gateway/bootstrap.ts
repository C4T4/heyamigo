import { isJidGroup, type WASocket } from 'baileys'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { readLast, type StoredMessage } from '../store/messages.js'

export type BuildInitParams = {
  jid: string
  sock: WASocket
  userText: string
  userNumber: string
}

export async function buildInitPayload(
  params: BuildInitParams,
): Promise<string> {
  const { jid, sock, userText, userNumber } = params
  const isGroup = isJidGroup(jid) === true
  const lines: string[] = []

  if (config.bootstrap.includeChatMetadata) {
    lines.push('You are the assistant behind a WhatsApp chat.')
    if (isGroup) {
      let subject = 'unknown'
      let participantSummary = ''
      try {
        const meta = await sock.groupMetadata(jid)
        subject = meta.subject || subject
        if (meta.participants?.length) {
          participantSummary = `${meta.participants.length} participants`
        }
      } catch (err) {
        logger.warn({ err, jid }, 'group metadata fetch failed in bootstrap')
      }
      lines.push(`Chat type: group`)
      lines.push(`Chat name: "${subject}"`)
      if (participantSummary) lines.push(`Members: ${participantSummary}`)
    } else {
      lines.push(`Chat type: direct message`)
    }
    lines.push(`JID: ${jid}`)
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
