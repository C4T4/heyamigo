import { parseStreamJson, runClaude, TIMEOUT_MS } from '../ai/spawn.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { logPrompt } from '../promptlog.js'
import { readLast, type StoredMessage } from '../store/messages.js'
import {
  appendEntry,
  getLastScannedTs,
  getJournal,
  readEntries,
  setLastScannedTs,
  type Journal,
} from './journals.js'

type ObserverClaudeOutput = {
  type?: string
  subtype?: string
  result?: string
  is_error?: boolean
}

// How many recent messages to include in the scan window on each sweep.
// Observer runs every memory.sweepIntervalMs (default 3h), so this window
// must cover at least that much chat activity to avoid gaps.
const SCAN_WINDOW = 200

// How many recent entries to show Claude for dedup context.
const DEDUP_WINDOW = 20

async function spawnObserver(prompt: string): Promise<string> {
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
    caller: 'journal-observer',
  })
  const startedAt = Date.now() - durationMs

  const parsed = parseStreamJson(stdout)
  if (!parsed) {
    throw new Error(
      `journal observer stream-json produced no result event: ${stdout.slice(0, 200)}`,
    )
  }
  if (parsed.isError || parsed.subtype !== 'success' || !parsed.result) {
    throw new Error(
      `journal observer bad output: ${parsed.result || stdout.slice(0, 200)}`,
    )
  }
  const output = parsed.result.trim()
  void logPrompt({
    ts: Math.floor(startedAt / 1000),
    caller: 'journal-observer',
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
  const date = new Date(m.timestamp * 1000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ')
  const who =
    m.direction === 'out' ? 'assistant' : m.pushName || m.senderNumber || 'user'
  return `[${m.timestamp}] ${who} (${date}): ${m.text}`
}

function buildPrompt(params: {
  journal: Journal
  recentEntries: { ts: number; note: string }[]
  messages: StoredMessage[]
}): string {
  const { journal, recentEntries, messages } = params
  const lines = [
    `You are a silent observer for a long-running journal called "${journal.name}" (slug: ${journal.slug}).`,
    ``,
    `PURPOSE: ${journal.purpose}`,
    journal.fields.length
      ? `FIELDS TO CAPTURE: ${journal.fields.join(', ')}`
      : '',
    ``,
    `Your job: scan the new messages below and decide if any of them contain content that belongs in this journal. Extract zero or more new entries.`,
    ``,
    `RECENT ENTRIES (to avoid duplicates — do not re-log anything already captured here):`,
    recentEntries.length
      ? recentEntries
          .map((e) => {
            const d = new Date(e.ts * 1000).toISOString().slice(0, 16).replace('T', ' ')
            return `- [${d}] ${e.note}`
          })
          .join('\n')
      : '(none yet)',
    ``,
    `NEW MESSAGES TO SCAN:`,
    messages.map(formatMsg).join('\n'),
    ``,
    `RULES:`,
    `- Only extract content that genuinely belongs in the "${journal.name}" journal based on its purpose.`,
    `- Ignore small talk, logistics, unrelated topics.`,
    `- Do not invent or infer things the messages don't say.`,
    `- If the owner mentioned the same thing twice in this window, log it once.`,
    `- Skip anything already in RECENT ENTRIES above.`,
    ``,
    `OUTPUT FORMAT:`,
    `- If there are no new entries to log, output exactly the single word: NONE`,
    `- Otherwise, output one JSON object per line (JSONL), each with this exact shape:`,
    `  {"note": "<one-line summary of the entry>"}`,
    `- No preamble, no trailing text, no markdown, no code fences.`,
  ]
  return lines.filter(Boolean).join('\n')
}

function parseOutput(raw: string): { note: string }[] {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.toUpperCase() === 'NONE') return []
  const out: { note: string }[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim()
    if (!l) continue
    try {
      const parsed = JSON.parse(l) as { note?: unknown }
      if (typeof parsed.note === 'string' && parsed.note.trim()) {
        out.push({ note: parsed.note.trim() })
      }
    } catch {
      // skip malformed line
    }
  }
  return out
}

// Default scan scope: owner's self-DM. Journals can override later by adding a
// scan_jids frontmatter field (not yet implemented — this keeps the default
// behavior safe).
function defaultScanJids(): string[] {
  if (!config.owner.number) return []
  return [`${config.owner.number}@s.whatsapp.net`]
}

export async function runJournalObserverForJid(params: {
  slug: string
  jid: string
}): Promise<{ appended: number; scanned: number }> {
  const { slug, jid } = params
  const journal = getJournal(slug)
  if (!journal) {
    logger.warn({ slug }, 'journal observer: slug not found, skipping')
    return { appended: 0, scanned: 0 }
  }
  if (journal.status !== 'active') {
    return { appended: 0, scanned: 0 }
  }

  const since = getLastScannedTs(slug, jid)
  const recent = await readLast(jid, SCAN_WINDOW)
  const newMessages = recent.filter((m) => m.timestamp > since)
  if (newMessages.length === 0) {
    return { appended: 0, scanned: 0 }
  }

  const recentEntries = readEntries(slug, DEDUP_WINDOW).map((e) => ({
    ts: e.ts,
    note: e.note,
  }))

  const prompt = buildPrompt({
    journal,
    recentEntries,
    messages: newMessages,
  })

  let output: string
  try {
    output = await spawnObserver(prompt)
  } catch (err) {
    logger.error({ err, slug, jid }, 'journal observer pass failed')
    return { appended: 0, scanned: newMessages.length }
  }

  const entries = parseOutput(output)
  for (const e of entries) {
    appendEntry(slug, {
      source: 'observer',
      jid,
      note: e.note,
    })
  }

  const maxTs = newMessages[newMessages.length - 1]!.timestamp
  setLastScannedTs(slug, jid, maxTs)

  logger.info(
    { slug, jid, scanned: newMessages.length, appended: entries.length },
    'journal observer pass complete',
  )
  return { appended: entries.length, scanned: newMessages.length }
}

export async function runJournalObserverSweep(): Promise<void> {
  const { listJournals } = await import('./journals.js')
  const journals = listJournals().filter((j) => j.status === 'active')
  if (journals.length === 0) return
  const jids = defaultScanJids()
  if (jids.length === 0) {
    logger.warn('journal observer: no owner.number configured, skipping sweep')
    return
  }
  for (const journal of journals) {
    for (const jid of jids) {
      try {
        await runJournalObserverForJid({ slug: journal.slug, jid })
      } catch (err) {
        logger.error(
          { err, slug: journal.slug, jid },
          'journal observer sweep error',
        )
      }
    }
  }
}
