// The ADHD skill is instructions. Models still emit a status sentence before
// tool calls, and the CLI glues that sentence onto the answer. This drops
// that prefix before WhatsApp sees it. If stripping would leave nothing,
// the original text is kept.

const ANNOUNCER =
  /I['’]ll|I will|Let me|Looking at|I['’]m (?:checking|going to|looking)|Great question|To answer/i

const LEADING_SENTENCE =
  /^(?:I['’]ll|I will|Let me|Looking at|Sure[!,.]|Great question|To answer|I['’]m (?:checking|going to|looking))\b/i

const CLOSER =
  /\b(?:let me know|hope this helps|anything else|happy to|feel free to ask)\b/i

function dropGluedStatus(text: string): string {
  const idx = text.indexOf('**')
  if (idx <= 0 || idx > 900) return text
  const prefix = text.slice(0, idx)
  if (!ANNOUNCER.test(prefix)) return text
  if (prefix.includes('\n\n')) return text
  return text.slice(idx)
}

function firstSentenceEnd(text: string): number {
  const match = /[.!?](?:\s|$)/.exec(text)
  if (!match) return -1
  return match.index + 1
}

function dropLeadingAnnouncements(text: string): string {
  let out = text.trim()
  for (let i = 0; i < 3; i++) {
    if (!LEADING_SENTENCE.test(out)) break
    const end = firstSentenceEnd(out)
    if (end <= 0 || end >= out.length) break
    out = out.slice(end).trim()
  }
  return out
}

function dropClosingPleasantry(text: string): string {
  const trimmed = text.trim()
  const parts = trimmed.split(/(?<=[.!?])\s+/)
  if (parts.length < 2) return trimmed
  const last = parts[parts.length - 1] ?? ''
  if (!CLOSER.test(last)) return trimmed
  return parts.slice(0, -1).join(' ').trim()
}

export function enforceReplyShape(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  const shaped = dropClosingPleasantry(
    dropLeadingAnnouncements(dropGluedStatus(trimmed)),
  ).trim()
  return shaped.length ? shaped : trimmed
}
