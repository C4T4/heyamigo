const TRAILING_TAG_RE =
  /\[(DIGEST|JOURNAL):\s*([^\]]+)\]\s*$/i

export type JournalFlag = { slug: string; note: string }

export type FlagResult = {
  clean: string
  digest: string | null
  journals: JournalFlag[]
}

// Backward-compat type alias for older imports
export type LegacyFlagResult = { clean: string; flag: string | null }

// Peel trailing [DIGEST:...] and [JOURNAL:<slug> — <note>] tags off the end of
// a reply. Multiple tags are supported and can appear in any order at the tail.
// Tags must be the LAST thing in the reply (after trimming trailing whitespace).
export function extractFlags(reply: string): FlagResult {
  let current = reply
  let digest: string | null = null
  const journals: JournalFlag[] = []

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
      if (parsed) journals.unshift(parsed) // unshift to preserve original order
    }

    current = trimmed.slice(0, match.index).trimEnd()
  }

  return { clean: current, digest, journals }
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
