import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { resolve } from 'path'
import { logger } from '../logger.js'
import type { Job } from './types.js'

const QUEUE_DIR = resolve(process.cwd(), 'storage/queue')
const PENDING_FILE = resolve(QUEUE_DIR, 'pending.jsonl')

function ensureDir(): void {
  mkdirSync(QUEUE_DIR, { recursive: true })
}

export function persistJob(job: Job): void {
  ensureDir()
  const line = JSON.stringify({ ...job, enqueuedAt: Date.now() }) + '\n'
  writeFileSync(PENDING_FILE, line, { flag: 'a', encoding: 'utf-8' })
}

export function removeJob(job: Job): void {
  if (!existsSync(PENDING_FILE)) return
  try {
    const lines = readFileSync(PENDING_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
    const remaining = lines.filter((line) => {
      try {
        const parsed = JSON.parse(line) as Job & { enqueuedAt?: number }
        return !(parsed.jid === job.jid && parsed.text === job.text)
      } catch {
        return false
      }
    })
    if (remaining.length === 0) {
      unlinkSync(PENDING_FILE)
    } else {
      writeFileSync(PENDING_FILE, remaining.join('\n') + '\n', 'utf-8')
    }
  } catch {
    // best-effort cleanup
  }
}

export function loadPendingJobs(): Job[] {
  if (!existsSync(PENDING_FILE)) return []
  try {
    const lines = readFileSync(PENDING_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
    const jobs: Job[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Job
        jobs.push(parsed)
      } catch {
        logger.warn({ line: line.slice(0, 100) }, 'skipping malformed pending job')
      }
    }
    logger.info({ count: jobs.length }, 'loaded pending jobs from disk')
    return jobs
  } catch {
    return []
  }
}

export function clearPending(): void {
  if (existsSync(PENDING_FILE)) unlinkSync(PENDING_FILE)
}
