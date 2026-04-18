import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { dirname, resolve } from 'path'
import { logger } from '../logger.js'
import {
  parseFrontmatter,
  serializeFrontmatter,
  type Frontmatter,
} from './frontmatter.js'
import { memoryRoot } from './paths.js'

export type JournalStatus = 'active' | 'paused' | 'archived'

export type Journal = {
  slug: string
  name: string
  purpose: string
  fields: string[]
  cadence: {
    checkin?: string
    followup_after?: string
    nudge_if_silent?: string
  }
  status: JournalStatus
  quiet_hours?: string
  created_at: string
  updated_at: string
  body: string
}

export type JournalEntry = {
  ts: number
  source: 'reactive' | 'observer' | 'manual'
  jid?: string
  senderNumber?: string
  note: string
}

// ---------- paths ----------

function journalsRoot(): string {
  return resolve(memoryRoot(), 'journals')
}

function journalDir(slug: string): string {
  return resolve(journalsRoot(), slug)
}

function journalIndexPath(slug: string): string {
  return resolve(journalDir(slug), 'index.md')
}

function journalEntriesPath(slug: string): string {
  return resolve(journalDir(slug), 'entries.jsonl')
}

function journalsIndexPath(): string {
  return resolve(journalsRoot(), 'index.md')
}

function journalObserverStatePath(slug: string): string {
  return resolve(journalDir(slug), 'observer-state.json')
}

function journalNudgeStatePath(slug: string): string {
  return resolve(journalDir(slug), 'nudge-state.json')
}

// ---------- low-level fs ----------

function ensureDirFor(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8')
}

// ---------- scaffold ----------

export function ensureJournalsScaffold(): void {
  mkdirSync(journalsRoot(), { recursive: true })
  if (!existsSync(journalsIndexPath())) {
    writeFileSync(
      journalsIndexPath(),
      '# journals\n\n(empty)\n',
      'utf-8',
    )
  }
}

// ---------- slug rules ----------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug)
}

// ---------- parse / serialize ----------

function parseJournal(slug: string, raw: string): Journal | null {
  const { data, body } = parseFrontmatter(raw)
  const name = typeof data.name === 'string' ? data.name : slug
  const purpose = typeof data.purpose === 'string' ? data.purpose : ''
  const fields = Array.isArray(data.fields)
    ? data.fields.map(String)
    : []
  const status =
    data.status === 'paused' || data.status === 'archived'
      ? data.status
      : 'active'
  const cadence = {
    checkin: pickString(data.checkin),
    followup_after: pickString(data.followup_after),
    nudge_if_silent: pickString(data.nudge_if_silent),
  }
  const created_at =
    typeof data.created_at === 'string' ? data.created_at : ''
  const updated_at =
    typeof data.updated_at === 'string' ? data.updated_at : created_at
  return {
    slug,
    name,
    purpose,
    fields,
    cadence,
    status,
    quiet_hours: pickString(data.quiet_hours),
    created_at,
    updated_at,
    body,
  }
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function journalToFrontmatter(j: Journal): Frontmatter {
  const fm: Frontmatter = {
    slug: j.slug,
    name: j.name,
    purpose: j.purpose,
    fields: j.fields,
    status: j.status,
    created_at: j.created_at,
    updated_at: j.updated_at,
  }
  if (j.cadence.checkin) fm.checkin = j.cadence.checkin
  if (j.cadence.followup_after) fm.followup_after = j.cadence.followup_after
  if (j.cadence.nudge_if_silent)
    fm.nudge_if_silent = j.cadence.nudge_if_silent
  if (j.quiet_hours) fm.quiet_hours = j.quiet_hours
  return fm
}

// ---------- CRUD ----------

export function listJournals(): Journal[] {
  const root = journalsRoot()
  if (!existsSync(root)) return []
  const slugs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  const out: Journal[] = []
  for (const slug of slugs) {
    const raw = readIfExists(journalIndexPath(slug))
    if (!raw) continue
    const j = parseJournal(slug, raw)
    if (j) out.push(j)
  }
  return out
}

export function getJournal(slug: string): Journal | null {
  if (!isValidSlug(slug)) return null
  const raw = readIfExists(journalIndexPath(slug))
  if (!raw) return null
  return parseJournal(slug, raw)
}

export function journalExists(slug: string): boolean {
  return isValidSlug(slug) && existsSync(journalIndexPath(slug))
}

export type CreateJournalInput = {
  slug: string
  name: string
  purpose: string
  fields?: string[]
  cadence?: Journal['cadence']
  quiet_hours?: string
  body?: string
}

export function createJournal(input: CreateJournalInput): Journal {
  if (!isValidSlug(input.slug)) {
    throw new Error(
      `Invalid journal slug "${input.slug}". Use lowercase letters, digits, and hyphens (max 48 chars, must start with letter/digit).`,
    )
  }
  if (journalExists(input.slug)) {
    throw new Error(`Journal "${input.slug}" already exists.`)
  }
  const now = new Date().toISOString().slice(0, 10)
  // Default cadence: nudge after 3 days of silence on this topic. No daily
  // check-in by default — that would be too pushy for most journals. Owner
  // can tune by editing the journal's index.md frontmatter directly.
  const cadence: Journal['cadence'] = input.cadence ?? {
    nudge_if_silent: '3d',
  }
  const journal: Journal = {
    slug: input.slug,
    name: input.name,
    purpose: input.purpose,
    fields: input.fields ?? [],
    cadence,
    status: 'active',
    quiet_hours: input.quiet_hours,
    created_at: now,
    updated_at: now,
    body:
      input.body ??
      `# ${input.name}\n\n${input.purpose}\n\n## How this journal is used\n\nEntries are captured by the assistant when topics relevant to this journal come up. See entries.jsonl for the log.\n`,
  }
  writeJournal(journal)
  refreshJournalsIndex()
  logger.info({ slug: journal.slug }, 'journal created')
  return journal
}

export function writeJournal(j: Journal): void {
  const content = serializeFrontmatter(journalToFrontmatter(j), j.body)
  const path = journalIndexPath(j.slug)
  ensureDirFor(path)
  writeFileSync(path, content, 'utf-8')
}

export function updateJournalStatus(
  slug: string,
  status: JournalStatus,
): Journal | null {
  const j = getJournal(slug)
  if (!j) return null
  j.status = status
  j.updated_at = new Date().toISOString().slice(0, 10)
  writeJournal(j)
  refreshJournalsIndex()
  return j
}

// ---------- entries ----------

export function appendEntry(
  slug: string,
  entry: Omit<JournalEntry, 'ts'> & { ts?: number },
): boolean {
  if (!journalExists(slug)) {
    logger.warn(
      { slug },
      'journal append ignored: unknown slug',
    )
    return false
  }
  const full: JournalEntry = {
    ts: entry.ts ?? Math.floor(Date.now() / 1000),
    source: entry.source,
    jid: entry.jid,
    senderNumber: entry.senderNumber,
    note: entry.note,
  }
  const path = journalEntriesPath(slug)
  ensureDirFor(path)
  appendFileSync(path, JSON.stringify(full) + '\n', 'utf-8')
  logger.info(
    { slug, source: full.source, jid: full.jid },
    'journal entry appended',
  )
  return true
}

export function readEntries(
  slug: string,
  limit = 100,
): JournalEntry[] {
  const raw = readIfExists(journalEntriesPath(slug))
  if (!raw) return []
  const lines = raw.trim().split(/\r?\n/).filter(Boolean)
  const tail = limit > 0 ? lines.slice(-limit) : lines
  const out: JournalEntry[] = []
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as JournalEntry)
    } catch {
      // skip malformed line
    }
  }
  return out
}

// ---------- index ----------

export function refreshJournalsIndex(): void {
  const journals = listJournals()
  const lines = ['# journals', '']
  if (journals.length === 0) {
    lines.push('(empty)')
  } else {
    for (const j of journals) {
      lines.push(`- ${j.slug}/ [${j.status}] — ${j.purpose || j.name}`)
    }
  }
  lines.push('')
  const path = journalsIndexPath()
  ensureDirFor(path)
  writeFileSync(path, lines.join('\n'), 'utf-8')
}

// ---------- preamble helper ----------

// Short one-liner per active journal for the [Journals: active] preamble block.
// Only returns active journals (not paused/archived).
export function buildJournalsPreambleBlock(): string | null {
  const journals = listJournals().filter((j) => j.status === 'active')
  if (journals.length === 0) return null
  const lines: string[] = []
  for (const j of journals) {
    const cadence = summarizeCadence(j.cadence)
    const cadenceSuffix = cadence ? ` (${cadence})` : ''
    lines.push(`- ${j.slug}: ${j.purpose || j.name}${cadenceSuffix}`)
  }
  return lines.join('\n')
}

function summarizeCadence(c: Journal['cadence']): string {
  const bits: string[] = []
  if (c.checkin) bits.push(`check-in ${c.checkin}`)
  if (c.followup_after) bits.push(`follow-up ${c.followup_after}`)
  if (c.nudge_if_silent) bits.push(`nudge if silent ${c.nudge_if_silent}`)
  return bits.join('; ')
}

// ---------- observer state ----------

type ObserverState = {
  jids: Record<string, { lastScannedTs: number }>
}

export function loadObserverState(slug: string): ObserverState {
  const raw = readIfExists(journalObserverStatePath(slug))
  if (!raw) return { jids: {} }
  try {
    const parsed = JSON.parse(raw) as Partial<ObserverState>
    return { jids: parsed.jids ?? {} }
  } catch {
    return { jids: {} }
  }
}

export function saveObserverState(slug: string, state: ObserverState): void {
  const path = journalObserverStatePath(slug)
  ensureDirFor(path)
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

export function getLastScannedTs(slug: string, jid: string): number {
  const state = loadObserverState(slug)
  return state.jids[jid]?.lastScannedTs ?? 0
}

export function setLastScannedTs(
  slug: string,
  jid: string,
  ts: number,
): void {
  const state = loadObserverState(slug)
  state.jids[jid] = { lastScannedTs: ts }
  saveObserverState(slug, state)
}

// ---------- nudge state ----------

export type NudgeState = {
  lastCheckinTs: number
  lastSilentNudgeTs: number
  snoozedUntilTs: number
}

export function loadNudgeState(slug: string): NudgeState {
  const raw = readIfExists(journalNudgeStatePath(slug))
  if (!raw)
    return { lastCheckinTs: 0, lastSilentNudgeTs: 0, snoozedUntilTs: 0 }
  try {
    const parsed = JSON.parse(raw) as Partial<NudgeState>
    return {
      lastCheckinTs: parsed.lastCheckinTs ?? 0,
      lastSilentNudgeTs: parsed.lastSilentNudgeTs ?? 0,
      snoozedUntilTs: parsed.snoozedUntilTs ?? 0,
    }
  } catch {
    return { lastCheckinTs: 0, lastSilentNudgeTs: 0, snoozedUntilTs: 0 }
  }
}

export function saveNudgeState(slug: string, state: NudgeState): void {
  const path = journalNudgeStatePath(slug)
  ensureDirFor(path)
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

