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

const KINDS = ['DIGEST', 'JOURNAL', 'JOURNAL-NEW', 'ASYNC'] as const

export type JournalFlag = { slug: string; note: string }
export type JournalCreateOp = { slug: string; purpose: string }
export type AsyncTaskFlag = { description: string }

export type FlagResult = {
  clean: string
  digest: string | null
  journals: JournalFlag[]
  journalCreates: JournalCreateOp[]
  asyncTasks: AsyncTaskFlag[]
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
//   [JOURNAL:<slug> — <note>]         (append entry)
//   [JOURNAL-NEW:<slug> — <purpose>]  (create journal)
//   [ASYNC: <self-sufficient task description>]
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
    }
  }

  return { clean: current, digest, journals, journalCreates, asyncTasks }
}

// Legacy helper kept so existing callers still compile.
export function extractDigestFlag(reply: string): LegacyFlagResult {
  const r = extractFlags(reply)
  return { clean: r.clean, flag: r.digest }
}

const JOURNAL_SEP_RE = /\s*(?:[—\-–]|:)\s*/

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
