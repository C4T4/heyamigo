// Owner-global learned weights for thread categories. A category is
// the AI's coarse classification of what a thread is about — derived
// from linked_memory (e.g. 'journals/health' → 'health') or set
// explicitly by the AI when opening the thread.
//
// The weight (0-100) is used as the starting hotness when the AI
// creates a new thread in this category. Implicit signals nudge it
// over time:
//   - user engages with a surfaced thread        → weight up
//   - user explicitly drops a thread             → weight down
//   - user manually overrides via /threads weight → set absolute
//
// Aggregate, not per-thread. The point is the AI learns that "Jana
// stuff" matters to this owner, so future Jana-related threads start
// hot. Or "general work threads" don't matter much, so they start
// quiet and need real signal to climb.
//
// User voice always wins — the manual override (/threads weight) sets
// an absolute value and bumps samples high so subsequent implicit
// nudges have less effect (already-confident weight is harder to
// move).

import { eq, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { threadCategoryWeights } from '../db/schema.js'

const DEFAULT_WEIGHT = 50
const MAX_WEIGHT = 100
const MIN_WEIGHT = 0

export function getCategoryWeight(category: string): number {
  if (!category) return DEFAULT_WEIGHT
  const db = getDb()
  const row = db
    .select({ weight: threadCategoryWeights.weight })
    .from(threadCategoryWeights)
    .where(eq(threadCategoryWeights.category, category))
    .get()
  return row?.weight ?? DEFAULT_WEIGHT
}

// Implicit signal — small delta, learns over many samples. Caller
// passes a delta like +5 (engagement) or -10 (explicit drop). Clamps
// to [0,100]. Insert-or-update so a brand-new category starts at
// DEFAULT_WEIGHT before the first nudge.
export function nudgeCategoryWeight(category: string, delta: number): void {
  if (!category || delta === 0) return
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const existing = db
    .select()
    .from(threadCategoryWeights)
    .where(eq(threadCategoryWeights.category, category))
    .get()

  if (existing) {
    const next = clamp(existing.weight + delta)
    db.update(threadCategoryWeights)
      .set({
        weight:    next,
        samples:   sql`${threadCategoryWeights.samples} + 1`,
        updatedAt: now,
      })
      .where(eq(threadCategoryWeights.category, category))
      .run()
    return
  }

  db.insert(threadCategoryWeights)
    .values({
      category,
      weight:    clamp(DEFAULT_WEIGHT + delta),
      samples:   1,
      updatedAt: now,
    })
    .run()
}

// Manual override from /threads weight <category> <0-100>. Sets the
// absolute value, bumps samples so this manual value carries
// confidence and isn't immediately drowned out.
export function setCategoryWeight(category: string, weight: number): void {
  if (!category) return
  const w = clamp(weight)
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const existing = db
    .select()
    .from(threadCategoryWeights)
    .where(eq(threadCategoryWeights.category, category))
    .get()
  if (existing) {
    db.update(threadCategoryWeights)
      .set({
        weight:    w,
        samples:   sql`${threadCategoryWeights.samples} + 10`,  // manual override = high confidence
        updatedAt: now,
      })
      .where(eq(threadCategoryWeights.category, category))
      .run()
    return
  }
  db.insert(threadCategoryWeights)
    .values({ category, weight: w, samples: 10, updatedAt: now })
    .run()
}

export function listCategoryWeights(): Array<{
  category: string
  weight: number
  samples: number
}> {
  const db = getDb()
  return db
    .select()
    .from(threadCategoryWeights)
    .all()
    .map((r) => ({ category: r.category, weight: r.weight, samples: r.samples }))
}

// Derive a coarse category from a linked_memory path or fall back to
// extracting the first word of the title. Used when the AI doesn't
// pass a category explicitly.
//   'journals/health/entries.jsonl' → 'health'
//   'persons/5491234567890/profile.md' → 'jana' (no — we'd need
//     identity resolution; for now → 'persons')
//   'buckets/work-dms/index.md'    → 'work-dms'
//   no link → first word of title, lowercased
export function deriveCategory(
  linkedMemory: string | null | undefined,
  title: string,
): string {
  if (linkedMemory) {
    const segments = linkedMemory.split('/').filter(Boolean)
    if (segments.length >= 2) {
      // 'journals/health/...' → 'health'
      // 'buckets/work-dms/...' → 'work-dms'
      // 'persons/<phone>/...' → 'persons' (don't leak phone numbers
      //   into category names; the AI can pass an explicit category
      //   for per-person tracking)
      if (segments[0] === 'persons') return 'persons'
      return segments[1]!
    }
    return segments[0] ?? 'general'
  }
  // Fall back: first token of the title, lowercased.
  const firstWord = title.trim().split(/\s+/)[0]?.toLowerCase()
  return firstWord || 'general'
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_WEIGHT
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Math.round(n)))
}
