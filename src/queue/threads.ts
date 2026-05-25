// Threads — the AI-curated relevance watchlist. See schema.ts header
// comment for the conceptual model. This module is the CRUD surface
// the worker calls when processing THREAD-* tags.
//
// Hotness invariants:
//   - 0-100, clamped on every write
//   - new threads start at min(category_weight, hotnessCapOnCreate)
//     (default cap 70) so the AI can't open a brand-new thread at
//     full hotness without an established category prior
//   - explicit user signals (resolve/drop, /threads commands) win
//     over implicit AI-emitted updates
//
// Status transitions are one-way: live → resolved | dropped |
// compressed. Once non-live, the row stays for /threads history but
// is filtered out of the live preamble.

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { logger } from '../logger.js'
import { threads } from '../db/schema.js'
import {
  deriveCategory,
  getCategoryWeight,
  nudgeCategoryWeight,
} from './thread-weights.js'

export type ThreadRow = typeof threads.$inferSelect
export type ThreadStatus = 'live' | 'resolved' | 'dropped' | 'compressed'

const HOTNESS_MIN = 0
const HOTNESS_MAX = 100
const HOTNESS_CAP_ON_CREATE = 70
const DEFAULT_NEXT_REVIEW_DAYS = 1

// Implicit signal deltas — small per-event, AI/system-triggered.
const DELTA_TOUCH         = +5
const DELTA_COOL          = -10
const CATEGORY_NUDGE_TOUCH = +3
const CATEGORY_NUDGE_DROP  = -5

export type CreateThreadInput = {
  targetJid: string
  title: string
  summary: string
  hotness?: number             // optional override; clamped + capped
  linkedMemory?: string | null
  category?: string            // optional explicit category (else derived)
  nextReviewAt?: number        // unix sec; default now + 1 day
}

export function createThread(input: CreateThreadInput): ThreadRow {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const category = input.category ?? deriveCategory(input.linkedMemory, input.title)
  // Default starting hotness = category weight, capped. AI can pass a
  // higher value but it's clamped to the cap so brand-new threads
  // can't open at 95 without history.
  const proposed = input.hotness ?? getCategoryWeight(category)
  const hotness = clampHotness(Math.min(proposed, HOTNESS_CAP_ON_CREATE))
  const nextReview = input.nextReviewAt ?? now + DEFAULT_NEXT_REVIEW_DAYS * 86400

  const row = db
    .insert(threads)
    .values({
      targetJid:     input.targetJid,
      title:         input.title,
      summary:       input.summary,
      hotness,
      status:        'live',
      linkedMemory:  input.linkedMemory ?? null,
      openedAt:      now,
      lastTouchedAt: now,
      nextReviewAt:  nextReview,
      createdAt:     now,
    })
    .returning()
    .get()
  logger.info(
    { id: row.id, jid: row.targetJid, title: row.title, hotness, category },
    'thread opened',
  )
  return row
}

export type UpdateThreadInput = {
  id: number
  title?: string
  summary?: string
  hotness?: number            // absolute set; clamped to [0,100]
  linkedMemory?: string | null
  nextReviewAt?: number
}

export function updateThread(input: UpdateThreadInput): ThreadRow | null {
  const db = getDb()
  const existing = db.select().from(threads).where(eq(threads.id, input.id)).get()
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const next = {
    title:         input.title ?? existing.title,
    summary:       input.summary ?? existing.summary,
    hotness:       input.hotness !== undefined ? clampHotness(input.hotness) : existing.hotness,
    linkedMemory:  input.linkedMemory ?? existing.linkedMemory,
    nextReviewAt:  input.nextReviewAt ?? existing.nextReviewAt,
    lastTouchedAt: now,
  }
  const row = db
    .update(threads)
    .set(next)
    .where(eq(threads.id, input.id))
    .returning()
    .get()
  return row ?? null
}

// TOUCH — small hotness bump + category-weight nudge. Called when the
// AI brings up a thread naturally or the user references its topic.
export function touchThread(id: number): ThreadRow | null {
  const db = getDb()
  const existing = db.select().from(threads).where(eq(threads.id, id)).get()
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const next = clampHotness(existing.hotness + DELTA_TOUCH)
  const row = db
    .update(threads)
    .set({ hotness: next, lastTouchedAt: now })
    .where(eq(threads.id, id))
    .returning()
    .get()
  const category = deriveCategory(existing.linkedMemory, existing.title)
  nudgeCategoryWeight(category, CATEGORY_NUDGE_TOUCH)
  return row ?? null
}

// COOL — drop hotness + push next review out. Tag form:
//   [THREAD-COOL:<id> — wait 3d]
// Pass deferDays explicitly when the AI specifies a wait; otherwise
// just lowers hotness without rescheduling.
export function coolThread(id: number, deferDays?: number): ThreadRow | null {
  const db = getDb()
  const existing = db.select().from(threads).where(eq(threads.id, id)).get()
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const next = clampHotness(existing.hotness + DELTA_COOL)
  const review =
    deferDays && deferDays > 0
      ? now + deferDays * 86400
      : existing.nextReviewAt
  const row = db
    .update(threads)
    .set({ hotness: next, nextReviewAt: review, lastTouchedAt: now })
    .where(eq(threads.id, id))
    .returning()
    .get()
  return row ?? null
}

export function resolveThread(id: number, note: string): ThreadRow | null {
  const db = getDb()
  const existing = db.select().from(threads).where(eq(threads.id, id)).get()
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const row = db
    .update(threads)
    .set({
      status:         'resolved',
      resolutionNote: note,
      lastTouchedAt:  now,
    })
    .where(eq(threads.id, id))
    .returning()
    .get()
  // Strong positive signal — user got an answer / closed the loop.
  const category = deriveCategory(existing.linkedMemory, existing.title)
  nudgeCategoryWeight(category, CATEGORY_NUDGE_TOUCH)
  logger.info({ id, note }, 'thread resolved')
  return row ?? null
}

export function dropThread(id: number, reason: string): ThreadRow | null {
  const db = getDb()
  const existing = db.select().from(threads).where(eq(threads.id, id)).get()
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const row = db
    .update(threads)
    .set({
      status:         'dropped',
      resolutionNote: reason,
      lastTouchedAt:  now,
    })
    .where(eq(threads.id, id))
    .returning()
    .get()
  // Negative signal — AI thought this mattered, user (or AI realizing
  // it doesn't) decided otherwise. Pull the category down so future
  // threads in this area start cooler.
  const category = deriveCategory(existing.linkedMemory, existing.title)
  nudgeCategoryWeight(category, CATEGORY_NUDGE_DROP)
  logger.info({ id, reason }, 'thread dropped')
  return row ?? null
}

// COMPRESS — thread has stabilized into a fact and the AI is moving
// it into cold memory (typically via a [DIGEST:] or direct write in
// the same reply). We just flip the status here; the actual file
// write is the caller's responsibility.
export function compressThread(id: number, note: string): ThreadRow | null {
  const db = getDb()
  const existing = db.select().from(threads).where(eq(threads.id, id)).get()
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const row = db
    .update(threads)
    .set({
      status:         'compressed',
      resolutionNote: note,
      lastTouchedAt:  now,
    })
    .where(eq(threads.id, id))
    .returning()
    .get()
  logger.info({ id, note }, 'thread compressed to cold memory')
  return row ?? null
}

// Preamble loader — live threads in this chat, ordered hot-first.
// `limit` caps the preamble size (default 5). Threads below
// hotness `minHotness` are excluded (so cold threads don't clutter).
export function listLiveThreads(
  targetJid: string,
  limit = 5,
  minHotness = 10,
): ThreadRow[] {
  const db = getDb()
  return db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.targetJid, targetJid),
        eq(threads.status, 'live'),
        eq(threads.enabled, 1),
      ),
    )
    .orderBy(desc(threads.hotness), desc(threads.lastTouchedAt))
    .limit(limit)
    .all()
    .filter((r) => r.hotness >= minHotness)
}

// /threads — all threads (any status) in a chat. Used by the chat
// command for full listing.
export function listAllThreads(targetJid: string): ThreadRow[] {
  const db = getDb()
  return db
    .select()
    .from(threads)
    .where(eq(threads.targetJid, targetJid))
    .orderBy(asc(threads.status), desc(threads.hotness))
    .all()
}

export function getThread(id: number): ThreadRow | null {
  const db = getDb()
  return db.select().from(threads).where(eq(threads.id, id)).get() ?? null
}

export function setThreadEnabled(id: number, enabled: boolean): boolean {
  const db = getDb()
  const result = db
    .update(threads)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(threads.id, id))
    .returning({ id: threads.id })
    .all()
  return result.length > 0
}

export function deleteThread(id: number): boolean {
  const db = getDb()
  const result = db
    .delete(threads)
    .where(eq(threads.id, id))
    .returning({ id: threads.id })
    .all()
  return result.length > 0
}

// Cost attribution — called when a future proactive review tick burns
// AI inferences. Mirrors addCronUsage in crons.ts.
export function addThreadUsage(
  id: number,
  inputTokens: number,
  outputTokens: number,
): void {
  if (!id || (inputTokens <= 0 && outputTokens <= 0)) return
  const db = getDb()
  db.update(threads)
    .set({
      totalInputTokens:  sql`${threads.totalInputTokens}  + ${inputTokens}`,
      totalOutputTokens: sql`${threads.totalOutputTokens} + ${outputTokens}`,
    })
    .where(eq(threads.id, id))
    .run()
}

function clampHotness(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(HOTNESS_MIN, Math.min(HOTNESS_MAX, Math.round(n)))
}

// Helper for the worker to filter out tags targeting threads in
// other chats (which shouldn't happen — AI shouldn't have IDs from
// other chats in preamble — but defense-in-depth).
export function threadsBelongToJid(
  ids: number[],
  targetJid: string,
): Set<number> {
  if (ids.length === 0) return new Set()
  const db = getDb()
  const rows = db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        inArray(threads.id, ids),
        eq(threads.targetJid, targetJid),
      ),
    )
    .all()
  return new Set(rows.map((r) => r.id))
}
