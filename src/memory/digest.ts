import { parseStreamJson, runClaude, TIMEOUT_MS } from '../ai/spawn.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { logPrompt } from '../promptlog.js'
import { readLast, type StoredMessage } from '../store/messages.js'
import { markCompressedDirty } from './compressed.js'
import {
  readBrief,
  readProfile,
  setLastDigestedAt,
  writeBrief,
  writeProfile,
} from './store.js'

type DigestClaudeOutput = {
  type?: string
  subtype?: string
  result?: string
  is_error?: boolean
}

/**
 * Run a stateless Claude call to consolidate memory.
 * Returns the new content Claude proposed.
 */
async function spawnDigester(prompt: string): Promise<string> {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    config.claude.model,
    '--permission-mode',
    'acceptEdits',
  ]
  const { stdout, stderr, durationMs } = await runClaude({
    args,
    input: prompt,
    timeoutMs: TIMEOUT_MS.background,
    caller: 'digester',
  })
  const startedAt = Date.now() - durationMs

  const parsed = parseStreamJson(stdout)
  if (!parsed) {
    throw new Error(
      `digester stream-json produced no result event: ${stdout.slice(0, 200)}`,
    )
  }
  if (parsed.isError || parsed.subtype !== 'success' || !parsed.result) {
    throw new Error(
      `digester bad output: ${parsed.result || stdout.slice(0, 200)}`,
    )
  }
  const output = parsed.result.trim()
  void logPrompt({
    ts: Math.floor(startedAt / 1000),
    caller: 'digester',
    args,
    input: prompt,
    output,
    durationMs,
    stderr,
    eventTypes: parsed.eventTypes,
  })
  return output
}

function formatMessagesForDigest(messages: StoredMessage[]): string {
  return messages
    .map((m) => {
      const date = new Date(m.timestamp * 1000)
        .toISOString()
        .slice(0, 16)
        .replace('T', ' ')
      const who =
        m.direction === 'out' ? 'assistant' : m.pushName || m.senderNumber || 'user'
      return `${who} (${date}): ${m.text}`
    })
    .join('\n')
}

function profilePrompt(params: {
  number: string
  current: string | null
  messages: StoredMessage[]
  reason: string | null
}): string {
  const { number, current, messages, reason } = params
  const personMessages = messages.filter(
    (m) => m.senderNumber === number && m.direction === 'in',
  )
  const replyMessages = messages.filter((m) => m.direction === 'out')
  const lines = [
    `You are consolidating the long-term profile for a WhatsApp contact.`,
    `Contact number: ${number}`,
    ``,
    `Current profile (may be empty):`,
    current || '(empty)',
    ``,
    reason ? `Reason this update was triggered: ${reason}` : '',
    ``,
    `Recent messages from this person:`,
    personMessages.length
      ? formatMessagesForDigest(personMessages)
      : '(none in window)',
    ``,
    `Recent bot replies (for context):`,
    replyMessages.length
      ? formatMessagesForDigest(replyMessages.slice(-10))
      : '(none)',
    ``,
    `Rewrite the profile in markdown. Structure:`,
    `# <Name if known, else number>`,
    `## Facts`,
    `## Preferences`,
    `## Patterns`,
    `## Recent context`,
    ``,
    `Rules:`,
    `- Keep under 500 tokens.`,
    `- Only append durable observations. Merge redundant items.`,
    `- Remove nothing unless clearly outdated.`,
    `- Do not invent facts.`,
    `- Output ONLY the new markdown profile content. No preamble, no explanation.`,
  ]
  return lines.filter(Boolean).join('\n')
}

function briefPrompt(params: {
  jid: string
  current: string | null
  messages: StoredMessage[]
  reason: string | null
}): string {
  const { jid, current, messages, reason } = params
  const lines = [
    `You are consolidating the long-term brief for a WhatsApp chat.`,
    `Chat JID: ${jid}`,
    ``,
    `Current brief (may be empty):`,
    current || '(empty)',
    ``,
    reason ? `Reason this update was triggered: ${reason}` : '',
    ``,
    `Recent messages in this chat:`,
    messages.length ? formatMessagesForDigest(messages) : '(none in window)',
    ``,
    `Rewrite the brief in markdown. Structure:`,
    `# <Chat name>`,
    `## Purpose`,
    `## Tone and norms`,
    `## Recent topics`,
    `## Decisions and open questions`,
    ``,
    `Rules:`,
    `- Keep under 500 tokens.`,
    `- Focus on durable context useful for future replies.`,
    `- Do not include raw messages or copy verbatim.`,
    `- Output ONLY the new markdown brief. No preamble.`,
  ]
  return lines.filter(Boolean).join('\n')
}

export async function runDigest(params: {
  jid: string
  number?: string
  reason?: string | null
}): Promise<void> {
  const { jid, number, reason } = params
  const now = Math.floor(Date.now() / 1000)

  const messages = await readLast(jid, config.memory.maxHistoryForDigest)
  if (!messages.length) {
    logger.info({ jid }, 'digest skipped: no messages in window')
    return
  }

  // Update brief for the jid
  try {
    const current = readBrief(jid)
    const prompt = briefPrompt({
      jid,
      current,
      messages,
      reason: reason ?? null,
    })
    const next = await spawnDigester(prompt)
    writeBrief(jid, next + '\n')
    setLastDigestedAt('jid', jid, now)
    logger.info({ jid, chars: next.length }, 'brief updated')
  } catch (err) {
    logger.error({ err, jid }, 'brief digest failed')
  }

  // Update profile for the specific person if provided
  if (number) {
    try {
      const current = readProfile(number)
      const prompt = profilePrompt({
        number,
        current,
        messages,
        reason: reason ?? null,
      })
      const next = await spawnDigester(prompt)
      writeProfile(number, next + '\n')
      setLastDigestedAt('person', number, now)
      logger.info({ number, chars: next.length }, 'profile updated')
    } catch (err) {
      logger.error({ err, number }, 'profile digest failed')
    }
  }

  // A profile or brief changed. Mark compressed view dirty so the next
  // session boot or ensureCompressedFresh() call regenerates it.
  markCompressedDirty()
}
