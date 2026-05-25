// Trailing-marker parser. Handles tags like [DIGEST: ...], [JOURNAL:...],
// [JOURNAL-NEW:...], [ASYNC: ...] at the end of a reply.
//
// Uses a bracket-depth walk rather than a regex because payloads routinely
// contain nested square brackets (e.g. [ASYNC: read a [config] file] or
// [DIGEST: noted the [JOURNAL:x] pattern]). A naive /\[.*?\]/-style regex
// terminates at the FIRST inner `]` and either misidentifies the tag or
// drops it entirely. That bug leaked two real markers into user-facing
// replies today (DIGEST ~morning, ASYNC later). This parser closes that
// whole class of failure.

import { logger } from '../logger.js'
import { parseTimeExpression } from '../queue/time-expr.js'

const KINDS = [
  'DIGEST',
  'JOURNAL',
  'JOURNAL-NEW',
  'ASYNC',
  'ASYNC-BROWSER',
  'SEND-TEXT',
  'CRON',
  'REMIND',
  'THREAD-NEW',
  'THREAD-UPDATE',
  'THREAD-TOUCH',
  'THREAD-COOL',
  'THREAD-RESOLVE',
  'THREAD-DROP',
  'THREAD-COMPRESS',
  'THREAD-WEIGHT',
] as const

export type JournalFlag = { slug: string; note: string }
export type JournalCreateOp = { slug: string; purpose: string }
export type AsyncTaskFlag = { description: string }

// Cross-chat text send. The agent specifies the destination address
// explicitly. Used when the agent wants to text a *different* chat
// than the one it's currently in — e.g. notifying the owner from a
// group conversation, or vice versa.
export type SendTextFlag = { address: string; body: string }

// Recurring schedule. Recurrence is a standard POSIX cron expression
// (or croner's @every/@daily/@weekly/etc aliases). Variant picks
// what happens at each firing:
//   SAY     — send the body text to the chat (current behavior, no AI)
//   PROMPT  — feed the body to the AI as if the user had typed it
//   ASYNC   — kick the body off as a background async task
//   BROWSER — kick off as a browser task (Playwright on shared Chrome)
// Default is SAY (back-compat). Body is the text-or-prompt-or-task
// description used by the variant.
export type CronVariant = 'SAY' | 'PROMPT' | 'ASYNC' | 'BROWSER'
export type CronFlag = { recurrence: string; variant: CronVariant; body: string }

// One-shot future send. Carries a structured TimeExpression (relative,
// today, tomorrow, weekday, ISO) and resolution to absolute time
// happens at worker level in the SENDER's timezone — not at parse
// time, because the parser doesn't know whose tz to use.
export type RemindFlag = { when: import('../queue/time-expr.js').TimeExpression; body: string }

// Threads — AI-curated relevance watchlist. See queue/threads.ts.
// All operations land here; the worker dispatches each to the
// matching threads.ts function.
export type ThreadNewFlag = {
  title: string
  summary: string
  hotness?: number              // optional override; clamped + capped
  linkedMemory?: string
  category?: string             // optional; else derived from linked_memory or title
}
export type ThreadUpdateFlag = {
  id: number
  title?: string
  summary?: string
  hotness?: number
  linkedMemory?: string
}
export type ThreadIdFlag = { id: number }                          // TOUCH
export type ThreadIdNoteFlag = { id: number; note: string }        // RESOLVE, DROP, COMPRESS
export type ThreadCoolFlag = { id: number; deferDays?: number }    // COOL
export type ThreadWeightFlag = { category: string; weight: number } // WEIGHT

export type FlagResult = {
  clean: string
  digest: string | null
  journals: JournalFlag[]
  journalCreates: JournalCreateOp[]
  asyncTasks: AsyncTaskFlag[]
  asyncBrowserTasks: AsyncTaskFlag[]
  sendTexts: SendTextFlag[]
  crons: CronFlag[]
  reminds: RemindFlag[]
  threadNews: ThreadNewFlag[]
  threadUpdates: ThreadUpdateFlag[]
  threadTouches: ThreadIdFlag[]
  threadCools: ThreadCoolFlag[]
  threadResolves: ThreadIdNoteFlag[]
  threadDrops: ThreadIdNoteFlag[]
  threadCompresses: ThreadIdNoteFlag[]
  threadWeights: ThreadWeightFlag[]
}

// Backward-compat type alias for older imports
export type LegacyFlagResult = { clean: string; flag: string | null }

type PeeledTag = {
  kind: string
  payload: string
  remaining: string
}

// Walk backwards from the end of the string, tracking bracket depth, to find
// the `[` that matches the final `]`. Returns the tag kind, its payload, and
// everything before the tag. Returns null if the tail doesn't cleanly look
// like a supported tag — caller should stop peeling.
function peelTrailingTag(raw: string): PeeledTag | null {
  const trimmed = raw.replace(/\s+$/, '')
  if (trimmed.length === 0) return null
  if (trimmed[trimmed.length - 1] !== ']') return null

  // Walk right-to-left counting depth. `]` pushes, `[` pops. The opening `[`
  // that brings depth back to 0 is the match for the trailing `]`.
  let depth = 0
  let openIdx = -1
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const c = trimmed[i]
    if (c === ']') {
      depth++
    } else if (c === '[') {
      depth--
      if (depth === 0) {
        openIdx = i
        break
      }
    }
  }
  if (openIdx < 0) return null // unbalanced — don't try to interpret

  const inside = trimmed.slice(openIdx + 1, trimmed.length - 1)
  const colonIdx = inside.indexOf(':')
  if (colonIdx < 0) return null

  const tagCandidate = inside.slice(0, colonIdx).trim().toUpperCase()
  if (!(KINDS as readonly string[]).includes(tagCandidate)) return null

  const payload = inside.slice(colonIdx + 1).trim()
  const remaining = trimmed.slice(0, openIdx).replace(/\s+$/, '')
  return { kind: tagCandidate, payload, remaining }
}

// Peel trailing tags off the end of a reply. Supported:
//   [DIGEST: <reason>]
//   [JOURNAL:<slug> — <note>]                  (append entry)
//   [JOURNAL-NEW:<slug> — <purpose>]           (create journal)
//   [ASYNC: <self-sufficient task description>]         (general async lane)
//   [ASYNC-BROWSER: <self-sufficient task description>] (browser lane,
//                                                        serialized, 1)
// Multiple tags supported in any order at the tail. Tags must be the LAST
// thing in the reply (after trimming trailing whitespace).
//
// Payload can contain arbitrary characters including `[` and `]` as long as
// the brackets are balanced within the payload.
export function extractFlags(reply: string): FlagResult {
  let current = reply
  let digest: string | null = null
  const journals: JournalFlag[] = []
  const journalCreates: JournalCreateOp[] = []
  const asyncTasks: AsyncTaskFlag[] = []
  const asyncBrowserTasks: AsyncTaskFlag[] = []
  const sendTexts: SendTextFlag[] = []
  const crons: CronFlag[] = []
  const reminds: RemindFlag[] = []
  const threadNews: ThreadNewFlag[] = []
  const threadUpdates: ThreadUpdateFlag[] = []
  const threadTouches: ThreadIdFlag[] = []
  const threadCools: ThreadCoolFlag[] = []
  const threadResolves: ThreadIdNoteFlag[] = []
  const threadDrops: ThreadIdNoteFlag[] = []
  const threadCompresses: ThreadIdNoteFlag[] = []
  const threadWeights: ThreadWeightFlag[] = []

  while (true) {
    const peeled = peelTrailingTag(current)
    if (!peeled) break
    const { kind, payload, remaining } = peeled
    current = remaining

    if (kind === 'DIGEST') {
      if (digest === null && payload.length > 0) digest = payload
    } else if (kind === 'JOURNAL') {
      const parsed = parseJournalPayload(payload)
      if (parsed) journals.unshift(parsed)
    } else if (kind === 'JOURNAL-NEW') {
      const parsed = parseJournalPayload(payload)
      if (parsed) {
        journalCreates.unshift({ slug: parsed.slug, purpose: parsed.note })
      }
    } else if (kind === 'ASYNC') {
      if (payload.length >= 8) {
        asyncTasks.unshift({ description: payload })
      }
    } else if (kind === 'ASYNC-BROWSER') {
      if (payload.length >= 8) {
        asyncBrowserTasks.unshift({ description: payload })
      }
    } else if (kind === 'SEND-TEXT') {
      const parsed = parseSendTextPayload(payload)
      if (parsed) sendTexts.unshift(parsed)
      else logger.warn({ payload }, 'SEND-TEXT tag dropped: unparseable payload')
    } else if (kind === 'CRON') {
      const parsed = parseCronPayload(payload)
      if (parsed) crons.unshift(parsed)
      else logger.warn({ payload }, 'CRON tag dropped: unparseable payload')
    } else if (kind === 'REMIND') {
      const parsed = parseRemindPayload(payload)
      if (parsed) reminds.unshift(parsed)
      else logger.warn({ payload }, 'REMIND tag dropped: unparseable payload')
    } else if (kind === 'THREAD-NEW') {
      const parsed = parseThreadNewPayload(payload)
      if (parsed) threadNews.unshift(parsed)
      else logger.warn({ payload }, 'THREAD-NEW tag dropped: unparseable payload')
    } else if (kind === 'THREAD-UPDATE') {
      const parsed = parseThreadUpdatePayload(payload)
      if (parsed) threadUpdates.unshift(parsed)
      else logger.warn({ payload }, 'THREAD-UPDATE tag dropped: unparseable payload')
    } else if (kind === 'THREAD-TOUCH') {
      const id = parseThreadId(payload)
      if (id !== null) threadTouches.unshift({ id })
      else logger.warn({ payload }, 'THREAD-TOUCH tag dropped: unparseable id')
    } else if (kind === 'THREAD-COOL') {
      const parsed = parseThreadCoolPayload(payload)
      if (parsed) threadCools.unshift(parsed)
      else logger.warn({ payload }, 'THREAD-COOL tag dropped: unparseable payload')
    } else if (kind === 'THREAD-RESOLVE') {
      const parsed = parseThreadIdNotePayload(payload)
      if (parsed) threadResolves.unshift(parsed)
      else logger.warn({ payload }, 'THREAD-RESOLVE tag dropped: unparseable payload')
    } else if (kind === 'THREAD-DROP') {
      const parsed = parseThreadIdNotePayload(payload)
      if (parsed) threadDrops.unshift(parsed)
      else logger.warn({ payload }, 'THREAD-DROP tag dropped: unparseable payload')
    } else if (kind === 'THREAD-COMPRESS') {
      const parsed = parseThreadIdNotePayload(payload)
      if (parsed) threadCompresses.unshift(parsed)
      else logger.warn({ payload }, 'THREAD-COMPRESS tag dropped: unparseable payload')
    } else if (kind === 'THREAD-WEIGHT') {
      const parsed = parseThreadWeightPayload(payload)
      if (parsed) threadWeights.unshift(parsed)
      else logger.warn({ payload }, 'THREAD-WEIGHT tag dropped: unparseable payload')
    }
  }

  return {
    clean: current,
    digest,
    journals,
    journalCreates,
    asyncTasks,
    asyncBrowserTasks,
    sendTexts,
    crons,
    reminds,
    threadNews,
    threadUpdates,
    threadTouches,
    threadCools,
    threadResolves,
    threadDrops,
    threadCompresses,
    threadWeights,
  }
}

// Strip flags that the sender's role isn't permitted to emit. The
// agent's reply still goes out as text — only the side-effect markers
// get suppressed. allowedTags='all' or undefined → no filtering.
export function filterFlagsByRole(
  flags: FlagResult,
  allowedTags: 'all' | readonly string[] | undefined,
): FlagResult {
  if (allowedTags === 'all' || allowedTags === undefined) return flags
  const allowed = new Set(allowedTags)
  // 'THREAD' acts as a single allow-all-thread-ops bucket so role
  // configs don't have to list all 8 THREAD-* variants individually.
  const threadOk = allowed.has('THREAD')
  return {
    clean:             flags.clean,
    digest:            allowed.has('DIGEST') ? flags.digest : null,
    journals:          allowed.has('JOURNAL') ? flags.journals : [],
    journalCreates:    allowed.has('JOURNAL-NEW') ? flags.journalCreates : [],
    asyncTasks:        allowed.has('ASYNC') ? flags.asyncTasks : [],
    asyncBrowserTasks: allowed.has('ASYNC-BROWSER') ? flags.asyncBrowserTasks : [],
    sendTexts:         allowed.has('SEND-TEXT') ? flags.sendTexts : [],
    crons:             allowed.has('CRON') ? flags.crons : [],
    reminds:           allowed.has('REMIND') ? flags.reminds : [],
    threadNews:        threadOk ? flags.threadNews : [],
    threadUpdates:     threadOk ? flags.threadUpdates : [],
    threadTouches:     threadOk ? flags.threadTouches : [],
    threadCools:       threadOk ? flags.threadCools : [],
    threadResolves:    threadOk ? flags.threadResolves : [],
    threadDrops:       threadOk ? flags.threadDrops : [],
    threadCompresses:  threadOk ? flags.threadCompresses : [],
    threadWeights:     threadOk ? flags.threadWeights : [],
  }
}

// Legacy helper kept so existing callers still compile.
export function extractDigestFlag(reply: string): LegacyFlagResult {
  const r = extractFlags(reply)
  return { clean: r.clean, flag: r.digest }
}

const JOURNAL_SEP_RE = /\s*(?:[—\-–]|:)\s*/

// Parse `<recurrence> [VARIANT] — <body>` payload.
// Recurrence is a standard POSIX cron expression OR a croner alias
// (@every / @hourly / @daily / @weekly / @monthly / @yearly).
// VARIANT is optional, defaults to SAY for back-compat. Recognized
// variants: SAY | PROMPT | ASYNC | BROWSER (case-insensitive).
const VARIANT_RE = /\s+(SAY|PROMPT|ASYNC|BROWSER)$/i
function parseCronPayload(payload: string): CronFlag | null {
  const sepMatch = payload.match(/\s+[—–-]\s+/)
  if (!sepMatch || sepMatch.index === undefined) return null
  let recurrencePart = payload.slice(0, sepMatch.index).trim()
  const body = payload.slice(sepMatch.index + sepMatch[0].length).trim()
  if (!recurrencePart || !body) return null

  // Strip trailing variant verb (if present) off the recurrence side.
  let variant: CronVariant = 'SAY'
  const verbMatch = VARIANT_RE.exec(recurrencePart)
  if (verbMatch) {
    variant = verbMatch[1]!.toUpperCase() as CronVariant
    recurrencePart = recurrencePart.slice(0, verbMatch.index).trim()
  }

  // Recurrence may start with '@' (alias) or a digit / star (5-field
  // cron). Reject obviously-malformed.
  if (!recurrencePart) return null
  return { recurrence: recurrencePart, variant, body }
}

// Parse `<time-spec> — <body>` payload. Time spec is anything the
// TimeExpression parser accepts: `in 30m`, `at 10:30am`, `tomorrow
// at 9am`, `mon at 9am`, `YYYY-MM-DD HH:MM`. Resolution happens
// later in the worker using the sender's timezone.
function parseRemindPayload(payload: string): RemindFlag | null {
  const sepMatch = payload.match(/\s+[—–-]\s+/)
  if (!sepMatch || sepMatch.index === undefined) return null
  const timeSpec = payload.slice(0, sepMatch.index).trim()
  const body = payload.slice(sepMatch.index + sepMatch[0].length).trim()
  if (!timeSpec || !body) return null
  const when = parseTimeExpression(timeSpec)
  if (!when) return null
  return { when, body }
}

// Parse `address=<addr> body="..."` style key=value payload.
// Body is delimited by double quotes; everything else by whitespace.
// Returns null if address or body is missing.
function parseSendTextPayload(payload: string): SendTextFlag | null {
  // Grab body="..." first (longest match so quoted body can contain spaces)
  const bodyMatch = payload.match(/\bbody\s*=\s*"((?:[^"\\]|\\.)*)"/)
  if (!bodyMatch) return null
  const body = bodyMatch[1]!
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
  if (!body.trim()) return null

  // Strip the body=... portion so address parsing doesn't trip on it
  const withoutBody = payload.replace(bodyMatch[0], '').trim()
  const addrMatch = withoutBody.match(/\baddress\s*=\s*([^\s]+)/)
  if (!addrMatch) return null

  return { address: addrMatch[1]!, body }
}

function parseJournalPayload(payload: string): JournalFlag | null {
  // Split on first em-dash, en-dash, hyphen, or colon between slug and note.
  const match = payload.match(/^([a-zA-Z0-9][a-zA-Z0-9-]*)(.*)$/)
  if (!match) return null
  const slug = match[1]!.toLowerCase()
  const rest = match[2] ?? ''
  const sepMatch = rest.match(JOURNAL_SEP_RE)
  if (!sepMatch || sepMatch.index !== 0) return null
  const note = rest.slice(sepMatch[0].length).trim()
  if (!note) return null
  return { slug, note }
}

// ──────────────────────────────────────────────────────────────────
// THREAD-* payload parsers
// ──────────────────────────────────────────────────────────────────
//
// Two payload shapes:
//   [THREAD-NEW: key="quoted" key=value]          key/value form
//   [THREAD-RESOLVE:42 — note]                    id-and-note form

// Pull `key="quoted-value"` and `key=word-value` pairs out of a
// payload. Returns a map. Supports backslash-escaped quotes inside
// quoted values.
function parseKeyValuePayload(payload: string): Record<string, string> {
  const out: Record<string, string> = {}
  // Quoted values first (greedy enough to capture spaces, escaped quotes)
  const quotedRe = /\b([a-z_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/gi
  let rest = payload
  for (const m of payload.matchAll(quotedRe)) {
    const key = m[1]!.toLowerCase()
    const val = m[2]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    out[key] = val
    rest = rest.replace(m[0], '')
  }
  // Then unquoted single-word values
  const wordRe = /\b([a-z_]+)\s*=\s*(\S+)/gi
  for (const m of rest.matchAll(wordRe)) {
    const key = m[1]!.toLowerCase()
    if (key in out) continue
    out[key] = m[2]!
  }
  return out
}

function parseThreadNewPayload(payload: string): ThreadNewFlag | null {
  const kv = parseKeyValuePayload(payload)
  const title = kv['title']?.trim()
  const summary = kv['summary']?.trim()
  if (!title || !summary) return null
  const out: ThreadNewFlag = { title, summary }
  if (kv['hotness'] !== undefined) {
    const n = parseInt(kv['hotness'], 10)
    if (Number.isFinite(n)) out.hotness = n
  }
  if (kv['linked_memory']) out.linkedMemory = kv['linked_memory']
  if (kv['category']) out.category = kv['category'].toLowerCase()
  return out
}

function parseThreadUpdatePayload(payload: string): ThreadUpdateFlag | null {
  // Leading id, then key=value pairs
  const idMatch = payload.match(/^\s*(\d+)\b/)
  if (!idMatch) return null
  const id = parseInt(idMatch[1]!, 10)
  if (!Number.isFinite(id) || id <= 0) return null
  const rest = payload.slice(idMatch[0].length)
  const kv = parseKeyValuePayload(rest)
  const out: ThreadUpdateFlag = { id }
  if (kv['title']) out.title = kv['title'].trim()
  if (kv['summary']) out.summary = kv['summary'].trim()
  if (kv['hotness'] !== undefined) {
    const n = parseInt(kv['hotness'], 10)
    if (Number.isFinite(n)) out.hotness = n
  }
  if (kv['linked_memory']) out.linkedMemory = kv['linked_memory']
  return out
}

// `<id>` alone — for TOUCH.
function parseThreadId(payload: string): number | null {
  const m = payload.match(/^\s*(\d+)\s*$/)
  if (!m) return null
  const id = parseInt(m[1]!, 10)
  return Number.isFinite(id) && id > 0 ? id : null
}

// `<id> — <note>` shape used by RESOLVE / DROP / COMPRESS. Note is
// the rest of the payload after the first em/en/hyphen separator.
const ID_NOTE_SEP_RE = /\s+[—–-]\s+/
function parseThreadIdNotePayload(payload: string): ThreadIdNoteFlag | null {
  const idMatch = payload.match(/^\s*(\d+)\b/)
  if (!idMatch) return null
  const id = parseInt(idMatch[1]!, 10)
  if (!Number.isFinite(id) || id <= 0) return null
  const rest = payload.slice(idMatch[0].length)
  const sep = rest.match(ID_NOTE_SEP_RE)
  if (!sep || sep.index === undefined) return { id, note: '' }
  const note = rest.slice(sep.index + sep[0].length).trim()
  return { id, note }
}

// `<id>` or `<id> — wait Nd|Nh` for COOL.
function parseThreadCoolPayload(payload: string): ThreadCoolFlag | null {
  const idMatch = payload.match(/^\s*(\d+)\b/)
  if (!idMatch) return null
  const id = parseInt(idMatch[1]!, 10)
  if (!Number.isFinite(id) || id <= 0) return null
  const rest = payload.slice(idMatch[0].length).trim()
  if (!rest) return { id }
  // Look for "wait <N><d|h>" anywhere in the rest
  const waitMatch = rest.match(/wait\s+(\d+)\s*([dh])/i)
  if (!waitMatch) return { id }
  const n = parseInt(waitMatch[1]!, 10)
  const unit = waitMatch[2]!.toLowerCase()
  if (!Number.isFinite(n) || n <= 0) return { id }
  const deferDays = unit === 'h' ? n / 24 : n
  return { id, deferDays }
}

// `<category> <weight>` for WEIGHT.
function parseThreadWeightPayload(payload: string): ThreadWeightFlag | null {
  const m = payload.match(/^\s*([a-z0-9][a-z0-9_-]*)\s+(\d+)\s*$/i)
  if (!m) return null
  const category = m[1]!.toLowerCase()
  const weight = parseInt(m[2]!, 10)
  if (!Number.isFinite(weight)) return null
  return { category, weight }
}
