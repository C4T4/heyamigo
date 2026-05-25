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

const KINDS = [
  'DIGEST',
  'JOURNAL',
  'JOURNAL-NEW',
  'ASYNC',
  'ASYNC-BROWSER',
  'SEND-TEXT',
  'CRON',
  'REMIND',
] as const

export type JournalFlag = { slug: string; note: string }
export type JournalCreateOp = { slug: string; purpose: string }
export type AsyncTaskFlag = { description: string }

// Cross-chat text send. The agent specifies the destination address
// explicitly. Used when the agent wants to text a *different* chat
// than the one it's currently in — e.g. notifying the owner from a
// group conversation, or vice versa.
export type SendTextFlag = { address: string; body: string }

// Recurring schedule. Recurrence in cron.ts's canonical format
// (`@every Nu`, `@daily HH:MM`, `@weekly DOW HH:MM`). Body is the
// text to send back to the originating chat at each firing.
export type CronFlag = { recurrence: string; body: string }

// One-shot future send. whenSecondsFromNow is parsed by the
// `in Nu` shorthand. Body is the reminder text.
export type RemindFlag = { whenSecondsFromNow: number; body: string }

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
    } else if (kind === 'CRON') {
      const parsed = parseCronPayload(payload)
      if (parsed) crons.unshift(parsed)
    } else if (kind === 'REMIND') {
      const parsed = parseRemindPayload(payload)
      if (parsed) reminds.unshift(parsed)
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
  }
}

// Legacy helper kept so existing callers still compile.
export function extractDigestFlag(reply: string): LegacyFlagResult {
  const r = extractFlags(reply)
  return { clean: r.clean, flag: r.digest }
}

const JOURNAL_SEP_RE = /\s*(?:[—\-–]|:)\s*/

// Parse `<recurrence> — <body>` payload. recurrence must start with
// '@' to match cron.ts's grammar (@every / @daily / @weekly).
function parseCronPayload(payload: string): CronFlag | null {
  const sepMatch = payload.match(/\s+[—–-]\s+/)
  if (!sepMatch || sepMatch.index === undefined) return null
  const recurrence = payload.slice(0, sepMatch.index).trim()
  const body = payload.slice(sepMatch.index + sepMatch[0].length).trim()
  if (!recurrence || !body) return null
  if (!recurrence.startsWith('@')) return null
  return { recurrence, body }
}

// Parse `in <n><unit> — <body>` payload. Supported units: s,m,h,d.
function parseRemindPayload(payload: string): RemindFlag | null {
  const sepMatch = payload.match(/\s+[—–-]\s+/)
  if (!sepMatch || sepMatch.index === undefined) return null
  const timeSpec = payload.slice(0, sepMatch.index).trim()
  const body = payload.slice(sepMatch.index + sepMatch[0].length).trim()
  if (!timeSpec || !body) return null
  const m = timeSpec.match(/^in\s+(\d+)\s*([smhd])$/i)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  const unit = m[2]!.toLowerCase()
  const mult = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400
  if (n <= 0) return null
  return { whenSecondsFromNow: n * mult, body }
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
