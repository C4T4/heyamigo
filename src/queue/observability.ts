// Read-only queries that summarize queue + worker state. Used by the
// /queues chat command and any future HTTP dashboard.
//
// All queries are explicit raw SQL via the singleton DB handle so the
// resulting text matches what an operator would see if they opened
// the DB with sqlite3 manually.

import { getRawDb } from '../db/index.js'

export type QueueDepth = {
  queue: string
  pending: number
  claimed: number
  failed: number
  dlq: number
}

export type StuckClaim = {
  queue: string
  id: number
  claimedBy: string | null
  claimedFor: number   // seconds since claim
}

export type WorkerLiveness = {
  id: string
  kind: string
  status: string
  currentJob: string | null
  ageSeconds: number
}

export type RecentFailure = {
  queue: string
  id: number
  attempts: number
  lastError: string | null
  ageSeconds: number
}

export type UpcomingCron = {
  name: string
  enqueueInto: string
  nextRunIn: number  // seconds from now (negative = overdue)
}

export type QueuesSnapshot = {
  takenAt: number
  depths: QueueDepth[]
  stuckClaims: StuckClaim[]
  workers: WorkerLiveness[]
  recentFailures: RecentFailure[]
  upcomingCrons: UpcomingCron[]
}

const QUEUE_TABLES = ['inbound', 'outbound'] as const
const STUCK_TTL_BY_QUEUE: Record<string, number> = {
  inbound: 360,
  outbound: 60,
}

export function takeQueuesSnapshot(): QueuesSnapshot {
  const db = getRawDb()
  const now = Math.floor(Date.now() / 1000)

  // Depths
  const depths: QueueDepth[] = []
  for (const q of QUEUE_TABLES) {
    const rows = db
      .prepare(
        `SELECT status, count(*) AS n FROM ${q} GROUP BY status`,
      )
      .all() as Array<{ status: string; n: number }>
    const counts: Record<string, number> = {
      pending: 0, claimed: 0, failed: 0, dlq: 0,
    }
    for (const r of rows) counts[r.status] = r.n
    depths.push({
      queue: q,
      pending: counts.pending ?? 0,
      claimed: counts.claimed ?? 0,
      failed: counts.failed ?? 0,
      dlq:     counts.dlq ?? 0,
    })
  }

  // Stuck claims. Outbound transitions through status='sending' (the
  // adapter call is in flight); inbound uses 'claimed'. Match either
  // so we catch stuck rows in any queue.
  const stuckClaims: StuckClaim[] = []
  for (const q of QUEUE_TABLES) {
    const ttl = STUCK_TTL_BY_QUEUE[q] ?? 60
    const rows = db
      .prepare(
        `SELECT id, claimed_by, claimed_at
         FROM ${q}
         WHERE status IN ('claimed','sending') AND claimed_at < ?`,
      )
      .all(now - ttl) as Array<{ id: number; claimed_by: string | null; claimed_at: number }>
    for (const r of rows) {
      stuckClaims.push({
        queue: q,
        id: r.id,
        claimedBy: r.claimed_by,
        claimedFor: now - r.claimed_at,
      })
    }
  }

  // Workers
  const wrows = db
    .prepare(
      `SELECT id, kind, status, current_job, last_seen
       FROM workers ORDER BY kind, id`,
    )
    .all() as Array<{
      id: string
      kind: string
      status: string
      current_job: string | null
      last_seen: number
    }>
  const workers = wrows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    currentJob: r.current_job,
    ageSeconds: now - r.last_seen,
  }))

  // Recent failures (top 5 per queue by updated_at desc)
  const recentFailures: RecentFailure[] = []
  for (const q of QUEUE_TABLES) {
    const rows = db
      .prepare(
        `SELECT id, attempts, last_error, updated_at
         FROM ${q}
         WHERE attempts > 0 AND (status='pending' OR status='failed' OR status='dlq')
         ORDER BY updated_at DESC LIMIT 5`,
      )
      .all() as Array<{ id: number; attempts: number; last_error: string | null; updated_at: number }>
    for (const r of rows) {
      recentFailures.push({
        queue: q,
        id: r.id,
        attempts: r.attempts,
        lastError: r.last_error,
        ageSeconds: now - r.updated_at,
      })
    }
  }

  // Upcoming crons (next 5 due)
  const cronRows = db
    .prepare(
      `SELECT name, enqueue_into, next_run_at
       FROM crons WHERE enabled = 1
       ORDER BY next_run_at LIMIT 5`,
    )
    .all() as Array<{ name: string; enqueue_into: string; next_run_at: number }>
  const upcomingCrons = cronRows.map((r) => ({
    name: r.name,
    enqueueInto: r.enqueue_into,
    nextRunIn: r.next_run_at - now,
  }))

  return {
    takenAt: now,
    depths,
    stuckClaims,
    workers,
    recentFailures,
    upcomingCrons,
  }
}

// Format a snapshot as a single chat-friendly text block. Compact —
// fits comfortably in a WhatsApp message.
export function formatQueuesSnapshot(snap: QueuesSnapshot): string {
  const lines: string[] = []
  lines.push('*queues*')

  // Depths
  for (const d of snap.depths) {
    const parts: string[] = [d.queue]
    parts.push(`${d.pending} pending`)
    if (d.claimed > 0) parts.push(`${d.claimed} in-flight`)
    if (d.failed > 0)  parts.push(`⚠ ${d.failed} failed`)
    if (d.dlq > 0)     parts.push(`⚠ ${d.dlq} dlq`)
    lines.push('  ' + parts.join(' · '))
  }

  // Workers
  lines.push('*workers*')
  const byKind: Record<string, WorkerLiveness[]> = {}
  for (const w of snap.workers) {
    if (!byKind[w.kind]) byKind[w.kind] = []
    byKind[w.kind]!.push(w)
  }
  for (const kind of Object.keys(byKind).sort()) {
    const ws = byKind[kind]!
    const busy = ws.filter((w) => w.status === 'busy').length
    const idle = ws.filter((w) => w.status === 'idle').length
    const draining = ws.filter((w) => w.status === 'draining').length
    const dead = ws.filter((w) => w.status === 'dead').length
    const stale = ws.filter((w) => w.ageSeconds > 30 && w.status !== 'dead').length
    const summary: string[] = []
    if (busy) summary.push(`${busy} busy`)
    if (idle) summary.push(`${idle} idle`)
    if (draining) summary.push(`${draining} draining`)
    if (dead) summary.push(`⚠ ${dead} dead`)
    if (stale) summary.push(`⚠ ${stale} stale`)
    lines.push(`  ${kind}: ${summary.length ? summary.join(' · ') : 'none'}`)
  }

  // Stuck claims
  if (snap.stuckClaims.length > 0) {
    lines.push('*stuck*')
    for (const s of snap.stuckClaims) {
      lines.push(`  ${s.queue}:${s.id} by ${s.claimedBy} for ${humanDur(s.claimedFor)}`)
    }
  }

  // Recent failures
  if (snap.recentFailures.length > 0) {
    lines.push('*failures*')
    for (const f of snap.recentFailures) {
      const err = (f.lastError ?? '').slice(0, 60)
      lines.push(`  ${f.queue}:${f.id} ×${f.attempts} (${humanDur(f.ageSeconds)} ago): ${err}`)
    }
  }

  // Upcoming crons
  if (snap.upcomingCrons.length > 0) {
    lines.push('*crons*')
    for (const c of snap.upcomingCrons) {
      const when = c.nextRunIn <= 0 ? 'due now' : `in ${humanDur(c.nextRunIn)}`
      lines.push(`  ${c.name} → ${c.enqueueInto} (${when})`)
    }
  }

  return lines.join('\n')
}

function humanDur(seconds: number): string {
  const s = Math.abs(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
