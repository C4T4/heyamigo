import { readFileSync } from 'fs'
import { parseFrontmatter, type Frontmatter } from './frontmatter.js'
import {
  entityIndexPath,
  treeRoot,
} from './paths.js'
import { entityExists, listEntities, type Tree } from './store.js'

export type LoadPlan = {
  tree: Tree
  slug: string
  path: string
}

export type RouteInput = {
  jid: string
  senderNumber: string
  recentText: string
  maxBuckets?: number
}

/**
 * Decide which entity indexes to load for this request.
 * Returns paths to their index.md files.
 */
export function routeIndexes(input: RouteInput): LoadPlan[] {
  const { jid, senderNumber, recentText, maxBuckets = 3 } = input
  const plans: LoadPlan[] = []

  // current chat
  if (entityExists('chats', jid)) {
    plans.push({ tree: 'chats', slug: jid, path: entityIndexPath('chats', jid) })
  }

  // current sender
  if (senderNumber && entityExists('persons', senderNumber)) {
    plans.push({
      tree: 'persons',
      slug: senderNumber,
      path: entityIndexPath('persons', senderNumber),
    })
  }

  // buckets: always_load first, then tag-matched
  const buckets = listEntities('buckets')
  const always: LoadPlan[] = []
  const scored: { plan: LoadPlan; score: number }[] = []
  const tokens = tokenize(recentText)

  for (const slug of buckets) {
    const indexPath = entityIndexPath('buckets', slug)
    const fm = readFrontmatter(indexPath)
    if (!fm) continue
    const plan: LoadPlan = { tree: 'buckets', slug, path: indexPath }

    if (fm.always_load === true) {
      always.push(plan)
      continue
    }

    const score = scoreBucket(fm, tokens, jid, senderNumber)
    if (score > 0) scored.push({ plan, score })
  }

  scored.sort((a, b) => b.score - a.score)
  const topMatched = scored.slice(0, maxBuckets).map((s) => s.plan)

  return [...always, ...topMatched, ...plans]
}

function readFrontmatter(path: string): Frontmatter | null {
  try {
    const raw = readFileSync(path, 'utf-8')
    return parseFrontmatter(raw).data
  } catch {
    return null
  }
}

function scoreBucket(
  fm: Frontmatter,
  tokens: Set<string>,
  jid: string,
  senderNumber: string,
): number {
  let score = 0
  const tags = fm.tags
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (typeof t === 'string' && tokens.has(t.toLowerCase())) score += 2
    }
  }
  const linkedJids = fm.linked_jids
  if (Array.isArray(linkedJids) && linkedJids.includes(jid)) score += 3
  const linkedNumbers = fm.linked_numbers
  if (
    Array.isArray(linkedNumbers) &&
    senderNumber &&
    linkedNumbers.includes(senderNumber)
  ) {
    score += 3
  }
  return score
}

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s-]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
  return new Set(words)
}

// convenience: list all buckets regardless of match
export function allBuckets(): string[] {
  return listEntities('buckets')
}
export function allTreeRoots(): string[] {
  return (['buckets', 'persons', 'chats'] as const).map((t) => treeRoot(t))
}
