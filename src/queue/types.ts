export type Job = {
  jid: string
  text: string
  input: string
  sessionId?: string
  senderNumber: string
  fromMe: boolean
  role?: string
  allowedTools?: string[] | 'all'
}

export type ReplyStats = {
  durationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  totalContextTokens: number
  contextWindow: number
  fresh: boolean
  hasDigest: boolean
  journalSlugs: string[]
  asyncCount: number
}

export type Result = {
  reply: string
  stats?: ReplyStats
}
