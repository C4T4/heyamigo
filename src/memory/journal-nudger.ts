import { parseStreamJson, runClaude, TIMEOUT_MS } from '../ai/spawn.js'
import { config } from '../config.js'
import { initiate } from '../gateway/outgoing.js'
import { logger } from '../logger.js'
import { logPrompt } from '../promptlog.js'
import { readLast, type StoredMessage } from '../store/messages.js'
import { canSendProactive } from '../wa/whitelist.js'
import {
  isInQuietHours,
  nextFireTs,
  parseCadence,
} from './journal-cadence.js'
import {
  listJournals,
  loadNudgeState,
  readEntries,
  saveNudgeState,
  type Journal,
  type NudgeState,
} from './journals.js'

type NudgeKind = 'checkin' | 'silent'

type ComposerOutput = {
  type?: string
  subtype?: string
  result?: string
  is_error?: boolean
}

// Default nudge target: owner's self-DM. Group/other-chat nudges would require
// explicit opt-in via access.json; we don't schedule those automatically in v1.
function defaultNudgeJid(): string | null {
  if (!config.owner.number) return null
  return `${config.owner.number}@s.whatsapp.net`
}

async function spawnComposer(prompt: string): Promise<string> {
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
    caller: 'journal-nudger',
  })
  const startedAt = Date.now() - durationMs

  const parsed = parseStreamJson(stdout)
  if (!parsed) {
    throw new Error(
      `nudger stream-json produced no result event: ${stdout.slice(0, 200)}`,
    )
  }
  if (parsed.isError || parsed.subtype !== 'success' || !parsed.result) {
    throw new Error(
      `nudger bad output: ${parsed.result || stdout.slice(0, 200)}`,
    )
  }
  const output = parsed.result.trim()
  void logPrompt({
    ts: Math.floor(startedAt / 1000),
    caller: 'journal-nudger',
    args,
    input: prompt,
    output,
    durationMs,
    stderr,
    eventTypes: parsed.eventTypes,
  })
  return output
}

function formatMsg(m: StoredMessage): string {
  const who =
    m.direction === 'out' ? 'assistant' : m.pushName || m.senderNumber || 'user'
  return `${who}: ${m.text}`
}

function buildPrompt(params: {
  journal: Journal
  kind: NudgeKind
  nowLocal: string
  recentEntries: { ts: number; note: string }[]
  recentMessages: StoredMessage[]
}): string {
  const { journal, kind, nowLocal, recentEntries, recentMessages } = params
  const kindDescription =
    kind === 'checkin'
      ? "This is a scheduled recurring check-in for this journal. Ask the owner to log whatever belongs in the journal right now (e.g. for a health journal at night: how did you sleep, any symptoms, anything else)."
      : "The owner has been silent on this journal's topic for a while. Send a gentle, natural nudge asking how things are going. Do not list every field; pick one thread."

  const lines = [
    `You are composing a proactive WhatsApp message to the owner from their personal assistant bot.`,
    ``,
    `CONTEXT:`,
    `- Journal: ${journal.name} (slug: ${journal.slug})`,
    `- Purpose: ${journal.purpose}`,
    journal.fields.length
      ? `- Fields typically captured: ${journal.fields.join(', ')}`
      : '',
    `- Local time now: ${nowLocal}`,
    `- Nudge type: ${kind}. ${kindDescription}`,
    ``,
    `RECENT JOURNAL ENTRIES (for continuity):`,
    recentEntries.length
      ? recentEntries
          .map((e) => {
            const d = new Date(e.ts * 1000).toISOString().slice(0, 16).replace('T', ' ')
            return `- [${d}] ${e.note}`
          })
          .join('\n')
      : '(none yet)',
    ``,
    `RECENT CONVERSATION (so you sound like yourself, not a stranger):`,
    recentMessages.length
      ? recentMessages.slice(-10).map(formatMsg).join('\n')
      : '(none)',
    ``,
    `RULES:`,
    `- Stay fully in character (your personality file defines tone; you are NOT customer service and NOT a reminder app).`,
    `- Short. One message, a few sentences max. No bullet lists, no headers.`,
    `- Do not open with validation, greetings, or "hope you're doing well" fillers. Get to the point.`,
    `- Be specific to the journal and what you know about the owner from recent entries and conversation.`,
    `- If previous entries show a pattern or an unresolved thread, reference it.`,
    `- Do NOT include any [TAG: ...] markers. This message is sent raw.`,
    `- If you truly think sending nothing is better right now (e.g. you just talked about this an hour ago), output the single word: SKIP`,
    ``,
    `OUTPUT: either the message text, or the single word SKIP. No preamble, no explanation.`,
  ]
  return lines.filter(Boolean).join('\n')
}

function nowLocalString(timezone: string, now: number): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    hour12: false,
  })
  return fmt.format(new Date(now * 1000))
}

async function composeAndSend(params: {
  journal: Journal
  kind: NudgeKind
  jid: string
}): Promise<boolean> {
  const { journal, kind, jid } = params
  const now = Math.floor(Date.now() / 1000)
  const nowLocal = nowLocalString(config.owner.timezone, now)
  const recentMessages = await readLast(jid, 30)
  const recentEntries = readEntries(journal.slug, 10).map((e) => ({
    ts: e.ts,
    note: e.note,
  }))
  const prompt = buildPrompt({
    journal,
    kind,
    nowLocal,
    recentEntries,
    recentMessages,
  })
  let output: string
  try {
    output = await spawnComposer(prompt)
  } catch (err) {
    logger.error(
      { err, slug: journal.slug, kind },
      'nudge composer failed',
    )
    return false
  }
  const text = output.trim()
  if (!text || text.toUpperCase() === 'SKIP') {
    logger.info(
      { slug: journal.slug, kind },
      'nudge composer chose to skip',
    )
    return false
  }
  const sent = await initiate({ jid, text })
  return sent
}

function lastOwnerInboundTs(messages: StoredMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.direction === 'in' && m.senderNumber === config.owner.number) {
      return m.timestamp
    }
  }
  return 0
}

function needCheckin(
  journal: Journal,
  state: NudgeState,
  now: number,
): boolean {
  const cadence = parseCadence(journal.cadence.checkin)
  if (!cadence) return false
  const next = nextFireTs({
    cadence,
    lastFiredTs: state.lastCheckinTs || null,
    now,
    timezone: config.owner.timezone,
  })
  return now >= next
}

function needSilentNudge(params: {
  journal: Journal
  state: NudgeState
  now: number
  lastOwnerActivityTs: number
}): boolean {
  const { journal, state, now, lastOwnerActivityTs } = params
  const cadence = parseCadence(journal.cadence.nudge_if_silent)
  if (!cadence || cadence.kind !== 'interval') return false
  const silenceThresholdSec = cadence.seconds
  if (now - lastOwnerActivityTs < silenceThresholdSec) return false
  // Debounce: don't resend the same silent nudge more often than the threshold.
  if (now - state.lastSilentNudgeTs < silenceThresholdSec) return false
  return true
}

export async function runNudgeTick(): Promise<void> {
  const jid = defaultNudgeJid()
  if (!jid) {
    logger.warn('nudge tick: no owner.number, skipping')
    return
  }
  if (!canSendProactive(jid)) {
    logger.debug(
      { jid },
      'nudge tick: proactive sending not allowed for target jid',
    )
    return
  }
  const now = Math.floor(Date.now() / 1000)
  if (
    isInQuietHours({
      now,
      window: '22:00-08:00',
      timezone: config.owner.timezone,
    })
  ) {
    return
  }
  const journals = listJournals().filter((j) => j.status === 'active')
  for (const journal of journals) {
    const state = loadNudgeState(journal.slug)
    if (state.snoozedUntilTs && now < state.snoozedUntilTs) continue

    // Per-journal quiet hours override
    if (
      isInQuietHours({
        now,
        window: journal.quiet_hours,
        timezone: config.owner.timezone,
      })
    ) {
      continue
    }

    const recent = await readLast(jid, 50)
    const lastOwnerTs = lastOwnerInboundTs(recent)

    if (needCheckin(journal, state, now)) {
      const sent = await composeAndSend({
        journal,
        kind: 'checkin',
        jid,
      })
      if (sent) {
        const fresh = loadNudgeState(journal.slug)
        fresh.lastCheckinTs = now
        saveNudgeState(journal.slug, fresh)
        logger.info(
          { slug: journal.slug, kind: 'checkin' },
          'nudge sent',
        )
      }
      // Don't also send a silent nudge in the same tick for this journal.
      continue
    }

    if (
      needSilentNudge({
        journal,
        state,
        now,
        lastOwnerActivityTs: lastOwnerTs,
      })
    ) {
      const sent = await composeAndSend({
        journal,
        kind: 'silent',
        jid,
      })
      if (sent) {
        const fresh = loadNudgeState(journal.slug)
        fresh.lastSilentNudgeTs = now
        saveNudgeState(journal.slug, fresh)
        logger.info(
          { slug: journal.slug, kind: 'silent' },
          'nudge sent',
        )
      }
    }

  }
}
