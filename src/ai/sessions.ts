import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { config } from '../config.js'
import { logger } from '../logger.js'
import type { ProviderName } from './provider.js'

export type SessionUsage = {
  // Per-turn (the delta of the last turn). What the /status footer
  // shows; what totalContextTokens is computed from.
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
  totalContextTokens: number
  numTurns: number
  updatedAt: number
  // Cumulative running totals across the entire resume thread.
  // Used by worker.ts as the baseline for the next turn's delta
  // computation when the provider reports usage cumulatively (Codex).
  // For per-turn providers (Claude), these accumulate the
  // per-turn deltas and aren't load-bearing, but kept consistent so
  // /status can report whole-thread stats too.
  cumulativeInputTokens?: number
  cumulativeCacheReadTokens?: number
  cumulativeCacheCreationTokens?: number
  cumulativeOutputTokens?: number
}

export type Session = {
  sessionId: string
  usage?: SessionUsage
}

// Sessions are keyed by (jid, provider). Each provider's CLI emits its own
// opaque session ids that mean nothing to the other provider, so we can't
// share storage. Swapping `ai.provider` doesn't invalidate or migrate
// existing sessions — they just sit dormant until you swap back.
type ProviderSessions = Partial<Record<ProviderName, Session>>
type SessionMap = Record<string, ProviderSessions>

function sessionsPath(): string {
  return resolve(process.cwd(), config.storage.sessionsFile)
}

let sessions: SessionMap = load()

// Migration from v0.8.x flat format: previously `sessions.json` held either
// `{ jid: "session-string" }` or `{ jid: { sessionId, usage } }`. Both meant
// "Claude session for this jid" because Claude was the only provider. We
// attribute legacy entries to `claude` so existing installs don't lose state
// when they upgrade.
function load(): SessionMap {
  const path = sessionsPath()
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<
      string,
      unknown
    >
    const out: SessionMap = {}
    for (const [jid, v] of Object.entries(raw)) {
      if (typeof v === 'string') {
        // legacy flat string
        out[jid] = { claude: { sessionId: v } }
      } else if (v && typeof v === 'object') {
        const obj = v as Record<string, unknown>
        // Detect already-namespaced format: at least one key is a known
        // ProviderName whose value looks like a Session.
        const isNamespaced =
          ('claude' in obj &&
            typeof obj.claude === 'object' &&
            obj.claude !== null &&
            'sessionId' in (obj.claude as object)) ||
          ('codex' in obj &&
            typeof obj.codex === 'object' &&
            obj.codex !== null &&
            'sessionId' in (obj.codex as object))
        if (isNamespaced) {
          out[jid] = obj as ProviderSessions
        } else if ('sessionId' in obj) {
          // legacy single-Session shape
          out[jid] = { claude: obj as Session }
        }
      }
    }
    return out
  } catch (err) {
    logger.warn(
      { err, path },
      'failed to load sessions.json, starting empty',
    )
    return {}
  }
}

function save(): void {
  const path = sessionsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(sessions, null, 2) + '\n', 'utf-8')
}

export function getSession(
  jid: string,
  provider: ProviderName,
): string | undefined {
  return sessions[jid]?.[provider]?.sessionId
}

export function getSessionInfo(
  jid: string,
  provider: ProviderName,
): Session | undefined {
  return sessions[jid]?.[provider]
}

export function setSession(
  jid: string,
  provider: ProviderName,
  sessionId: string,
): void {
  const bucket = sessions[jid] ?? {}
  const existing = bucket[provider]
  bucket[provider] = { sessionId, usage: existing?.usage }
  sessions[jid] = bucket
  save()
}

export function setUsage(
  jid: string,
  provider: ProviderName,
  usage: SessionUsage,
): void {
  const existing = sessions[jid]?.[provider]
  if (!existing) return
  const bucket = sessions[jid]!
  bucket[provider] = { ...existing, usage }
  save()
}

// Clears the session for one provider on this jid. Returns true if a session
// was actually removed. Other providers' sessions on the same jid are left
// alone — they're independent.
export function clearSession(
  jid: string,
  provider: ProviderName,
): boolean {
  const bucket = sessions[jid]
  if (!bucket || !bucket[provider]) return false
  delete bucket[provider]
  if (Object.keys(bucket).length === 0) {
    delete sessions[jid]
  } else {
    sessions[jid] = bucket
  }
  save()
  return true
}

// Returns every (jid, provider) pair currently stored. Used by the sweeper to
// discover jids with activity — it doesn't care which provider produced the
// session id.
export function listSessions(): Readonly<SessionMap> {
  return sessions
}
