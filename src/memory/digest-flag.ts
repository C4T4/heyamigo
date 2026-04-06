const DIGEST_RE = /\[DIGEST:\s*([^\]]+)\]\s*$/i

export type FlagResult = {
  clean: string
  flag: string | null
}

export function extractDigestFlag(reply: string): FlagResult {
  const match = reply.match(DIGEST_RE)
  if (!match) return { clean: reply, flag: null }
  const clean = reply.slice(0, match.index).trimEnd()
  return { clean, flag: match[1]?.trim() ?? '' }
}
