const TRAILING_TAG_RE =
  /\[(DIGEST|JOURNAL|JOURNAL-NEW|ASYNC):\s*([^\]]+)\]\s*$/i

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

// Peel trailing tags off the end of a reply. Supported:
//   [DIGEST: <reason>]
//   [JOURNAL:<slug> — <note>]         (append entry)
//   [JOURNAL-NEW:<slug> — <purpose>]  (create journal)
//   [ASYNC: <self-sufficient task description>]
// Multiple tags supported, any order at the tail. Tags must be the LAST
// thing in the reply (after trimming trailing whitespace).
//
// Journal pause/resume/archive is intentionally NOT a marker. If the owner
// wants those, Claude edits the journal's index.md frontmatter directly.
// Keeping the marker vocabulary small keeps Claude's context tight.
export function extractFlags(reply: string): FlagResult {
  let current = reply
  let digest: string | null = null
  const journals: JournalFlag[] = []
  const journalCreates: JournalCreateOp[] = []
  const asyncTasks: AsyncTaskFlag[] = []

  while (true) {
    const trimmed = current.replace(/\s+$/, '')
    const match = trimmed.match(TRAILING_TAG_RE)
    if (!match) break

    const kind = match[1]!.toUpperCase()
    const payload = (match[2] ?? '').trim()

    if (kind === 'DIGEST') {
      if (digest === null) digest = payload
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

    current = trimmed.slice(0, match.index).trimEnd()
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
