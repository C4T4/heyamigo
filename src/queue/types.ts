export type Job = {
  jid: string
  text: string
  input: string
  sessionId?: string
  senderNumber: string
  fromMe: boolean
  role?: string
  allowedTools?: string[] | 'all'
  // Tag allowlist for this sender's role. Undefined or 'all' = no
  // restriction. Set by gateway/incoming.ts from the resolved role.
  allowedTags?: string[] | 'all'
  // Set when this job was synthesized by a [CRON: ... PROMPT — ...]
  // firing. The chat worker attributes token usage back to this cron
  // row via addCronUsage() so /crons can show cumulative cost.
  cronId?: number
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

// A user-facing "this is in flight" message the chat track adds to
// the reply queue after the agent's response chunks, so the user
// sees an ETA for delegated async/browser work. Sent through the
// normal outbound path (idempotency, retry, channel adapter all
// reused).
export type JobCard = {
  text: string                  // pre-formatted, includes ETA + truncated description
  idempotencyKey: string
}

export type Result = {
  reply: string
  stats?: ReplyStats
  jobCards?: JobCard[]
}
