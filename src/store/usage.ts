import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { config } from '../config.js'
import { logger } from '../logger.js'

// Per-user, per-day Claude token usage (input + output combined).
// File layout: storage/usage/YYYY-MM-DD.json
// Contents:    { "<phone-number>": <tokens> }
//
// "Day" is bucketed in the owner's configured timezone so that quotas reset
// at midnight local time rather than UTC.

function usageDir(): string {
  return resolve(process.cwd(), config.storage.messagesDir, '..', 'usage')
}

function dayKey(now: Date = new Date()): string {
  // en-CA gives YYYY-MM-DD; using owner's timezone keeps the reset boundary
  // intuitive for the operator. Falls back gracefully if the tz is bogus.
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.owner.timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    return fmt.format(now)
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  }
}

function fileFor(day: string): string {
  return resolve(usageDir(), `${day}.json`)
}

let dirReady = false
function ensureDir(): void {
  if (dirReady) return
  mkdirSync(usageDir(), { recursive: true })
  dirReady = true
}

function readDay(day: string): Record<string, number> {
  const f = fileFor(day)
  if (!existsSync(f)) return {}
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf-8'))
    if (parsed && typeof parsed === 'object') return parsed as Record<string, number>
    return {}
  } catch (err) {
    logger.warn({ err, file: f }, 'usage file unreadable, treating as empty')
    return {}
  }
}

function writeDay(day: string, data: Record<string, number>): void {
  ensureDir()
  writeFileSync(fileFor(day), JSON.stringify(data) + '\n', 'utf-8')
}

export function getDailyTokens(senderNumber: string): number {
  if (!senderNumber) return 0
  const data = readDay(dayKey())
  return data[senderNumber] ?? 0
}

export function addDailyTokens(senderNumber: string, tokens: number): void {
  if (!senderNumber || tokens <= 0) return
  const day = dayKey()
  const data = readDay(day)
  data[senderNumber] = (data[senderNumber] ?? 0) + tokens
  writeDay(day, data)
}
