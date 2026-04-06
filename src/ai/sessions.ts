import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { config } from '../config.js'
import { logger } from '../logger.js'

export type SessionUsage = {
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
  totalContextTokens: number
  numTurns: number
  updatedAt: number
}

export type Session = {
  sessionId: string
  usage?: SessionUsage
}

type SessionMap = Record<string, Session>

function sessionsPath(): string {
  return resolve(process.cwd(), config.storage.sessionsFile)
}

let sessions: SessionMap = load()

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
        out[jid] = { sessionId: v } // migrate old flat string format
      } else if (v && typeof v === 'object' && 'sessionId' in v) {
        out[jid] = v as Session
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

export function getSession(jid: string): string | undefined {
  return sessions[jid]?.sessionId
}

export function getSessionInfo(jid: string): Session | undefined {
  return sessions[jid]
}

export function setSession(jid: string, sessionId: string): void {
  const existing = sessions[jid]
  sessions[jid] = { sessionId, usage: existing?.usage }
  save()
}

export function setUsage(jid: string, usage: SessionUsage): void {
  const existing = sessions[jid]
  if (!existing) return
  sessions[jid] = { ...existing, usage }
  save()
}

export function clearSession(jid: string): boolean {
  if (!(jid in sessions)) return false
  delete sessions[jid]
  save()
  return true
}

export function listSessions(): Readonly<SessionMap> {
  return sessions
}
