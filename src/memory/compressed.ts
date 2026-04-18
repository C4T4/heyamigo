import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs'
import { dirname, resolve } from 'path'
import { mkdirSync } from 'fs'
import { parseStreamJson, runClaude, TIMEOUT_MS } from '../ai/spawn.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { logPrompt } from '../promptlog.js'
import { listJournals, readEntries } from './journals.js'
import { memoryRoot, treeRoot, entityIndexPath } from './paths.js'

// The compressed view is a rolling index across all memory: people, chats,
// buckets, active journals. 1-3 lines per entity. Purpose: every fresh
// session starts with enough state to respond to a passing mention without
// re-reading any file. Deep context still lives in the full profile/brief/
// entries files — Claude reads those on demand.
//
// Regenerated on: boot, and after any digest that edits a memory file
// (marked dirty, lazily rebuilt on next access).

export function compressedPath(): string {
  return resolve(memoryRoot(), 'compressed.md')
}

function compressedStatePath(): string {
  return resolve(memoryRoot(), 'compressed-state.json')
}

type CompressedState = {
  lastBuiltAt: number
  dirty: boolean
}

function loadState(): CompressedState {
  const raw = readIfExists(compressedStatePath())
  if (!raw) return { lastBuiltAt: 0, dirty: true }
  try {
    const parsed = JSON.parse(raw) as Partial<CompressedState>
    return {
      lastBuiltAt: parsed.lastBuiltAt ?? 0,
      dirty: parsed.dirty ?? false,
    }
  } catch {
    return { lastBuiltAt: 0, dirty: true }
  }
}

function saveState(state: CompressedState): void {
  const path = compressedStatePath()
  ensureDirFor(path)
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8')
}

function ensureDirFor(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

export function markCompressedDirty(): void {
  const state = loadState()
  state.dirty = true
  saveState(state)
}

export function readCompressed(): string | null {
  return readIfExists(compressedPath())
}

// ---------- generator ----------

function collectPersons(): Array<{ number: string; profile: string }> {
  const dir = treeRoot('persons')
  if (!existsSync(dir)) return []
  const out: Array<{ number: string; profile: string }> = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const profilePath = resolve(dir, d.name, 'profile.md')
    const profile = readIfExists(profilePath)
    if (profile) out.push({ number: d.name, profile })
  }
  return out
}

function collectChats(): Array<{ jid: string; brief: string }> {
  const dir = treeRoot('chats')
  if (!existsSync(dir)) return []
  const out: Array<{ jid: string; brief: string }> = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const briefPath = resolve(dir, d.name, 'brief.md')
    const brief = readIfExists(briefPath)
    if (brief) out.push({ jid: d.name, brief })
  }
  return out
}

function collectBuckets(): Array<{ slug: string; index: string }> {
  const dir = treeRoot('buckets')
  if (!existsSync(dir)) return []
  const out: Array<{ slug: string; index: string }> = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const idx = readIfExists(entityIndexPath('buckets', d.name))
    if (idx) out.push({ slug: d.name, index: idx })
  }
  return out
}

type JournalView = {
  slug: string
  purpose: string
  status: string
  cadence: string
  lastEntries: string[]
}

function collectJournals(): JournalView[] {
  return listJournals()
    .filter((j) => j.status === 'active')
    .map((j) => {
      const cadenceBits: string[] = []
      if (j.cadence.checkin) cadenceBits.push(`check-in ${j.cadence.checkin}`)
      if (j.cadence.nudge_if_silent)
        cadenceBits.push(`silent-nudge ${j.cadence.nudge_if_silent}`)
      const recent = readEntries(j.slug, 2)
      return {
        slug: j.slug,
        purpose: j.purpose,
        status: j.status,
        cadence: cadenceBits.join(', '),
        lastEntries: recent.map((e) => {
          const d = new Date(e.ts * 1000)
            .toISOString()
            .slice(0, 10)
          return `[${d}] ${e.note}`
        }),
      }
    })
}

function buildInputForGenerator(): string {
  const lines: string[] = []

  const persons = collectPersons()
  if (persons.length) {
    lines.push('## PEOPLE (raw profiles)')
    for (const p of persons) {
      lines.push(`### ${p.number}`)
      lines.push(p.profile.trim())
      lines.push('')
    }
  }

  const chats = collectChats()
  if (chats.length) {
    lines.push('## CHATS (raw briefs)')
    for (const c of chats) {
      lines.push(`### ${c.jid}`)
      lines.push(c.brief.trim())
      lines.push('')
    }
  }

  const buckets = collectBuckets()
  if (buckets.length) {
    lines.push('## BUCKETS (raw indexes)')
    for (const b of buckets) {
      lines.push(`### ${b.slug}`)
      lines.push(b.index.trim())
      lines.push('')
    }
  }

  const journals = collectJournals()
  if (journals.length) {
    lines.push('## JOURNALS (active)')
    for (const j of journals) {
      lines.push(`### ${j.slug}`)
      lines.push(`purpose: ${j.purpose}`)
      if (j.cadence) lines.push(`cadence: ${j.cadence}`)
      if (j.lastEntries.length) {
        lines.push('last entries:')
        for (const e of j.lastEntries) lines.push(`  ${e}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n') || '(no memory yet)'
}

function generatorPrompt(raw: string): string {
  return `Write the line you'd want to see if you woke up with amnesia and were about to answer this person. That's the whole job.

You are producing a rolling "state of the world" index. Every fresh Claude session starts by reading it. It is NOT a summary. It is an INDEX with load-bearing excerpts, pointing at full files for depth.

RULES (enforce ruthlessly):
- Every phrase must change a response. If removing it wouldn't change how you'd reply, cut it.
- Staccato. No filler verbs (is, was, has, tends to). No hedges (maybe, usually, often).
- Behavior-shifting facts only: identity (pronouns, name), hard rules ("always English", "don't X"), current state ("gut recovering", "bulk to 63kg"), key constraints.
- NO biography. Age, location, occupation are NOT load-bearing unless they directly change a response.
- Cap: one to three lines per entity. Closer to one is better.
- High word/meaning ratio. "Trolls, verify." does the work of a paragraph.

OUTPUT FORMAT (exact):

# State: current

## People

- <name> (<number>): <phrase>. <phrase>. <phrase>.
  → storage/memory/persons/<number>/profile.md

(one entry per person, three phrases MAX)

## Chats

- <jid> "<chat name if known>": <one line of norms + current state>.
  → storage/memory/chats/<jid>/brief.md

## Buckets

- <slug>: <one line — what this is + current status>.
  → storage/memory/buckets/<slug>/index.md

## Journals (active, open todos)

- <slug>: <purpose, tight>.
  last: <copy the most recent entry VERBATIM, do not paraphrase>
  cadence: <check-in / silent-nudge as applicable>
  → storage/memory/journals/<slug>/

RAW SOURCES:

${raw}

Output ONLY the compressed index in the exact format above. No preamble, no explanation, no code fences.`
}

type GenResult = {
  type?: string
  subtype?: string
  result?: string
  is_error?: boolean
}

async function spawnGenerator(prompt: string): Promise<string> {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    config.claude.model,
    '--permission-mode',
    'acceptEdits',
  ]
  const { stdout, stderr, durationMs } = await runClaude({
    args,
    input: prompt,
    timeoutMs: TIMEOUT_MS.background,
    caller: 'compressed',
  })
  const startedAt = Date.now() - durationMs

  const parsed = parseStreamJson(stdout)
  if (!parsed) {
    throw new Error(
      `compressed stream-json produced no result event: ${stdout.slice(0, 200)}`,
    )
  }
  if (parsed.isError || parsed.subtype !== 'success' || !parsed.result) {
    throw new Error(
      `compressed bad output: ${parsed.result || stdout.slice(0, 200)}`,
    )
  }
  const output = parsed.result.trim()
  void logPrompt({
    ts: Math.floor(startedAt / 1000),
    caller: 'compressed',
    args,
    input: prompt,
    output,
    durationMs,
    stderr,
    eventTypes: parsed.eventTypes,
  })
  return output
}

let buildInFlight: Promise<void> | null = null

export async function rebuildCompressed(): Promise<void> {
  if (buildInFlight) return buildInFlight
  buildInFlight = (async () => {
    const raw = buildInputForGenerator()
    if (raw === '(no memory yet)') {
      const empty = '# State: current\n\n(no memory yet)\n'
      const path = compressedPath()
      ensureDirFor(path)
      writeFileSync(path, empty, 'utf-8')
      saveState({ lastBuiltAt: Math.floor(Date.now() / 1000), dirty: false })
      logger.info('compressed: empty scaffold written (no memory yet)')
      return
    }
    const prompt = generatorPrompt(raw)
    const output = await spawnGenerator(prompt)
    const path = compressedPath()
    ensureDirFor(path)
    writeFileSync(path, output + '\n', 'utf-8')
    saveState({ lastBuiltAt: Math.floor(Date.now() / 1000), dirty: false })
    logger.info(
      { chars: output.length },
      'compressed: rebuilt',
    )
  })()
  try {
    await buildInFlight
  } finally {
    buildInFlight = null
  }
}

// Regenerate only if dirty or missing. Used in boot + lazy access paths.
export async function ensureCompressedFresh(): Promise<void> {
  const state = loadState()
  const exists = existsSync(compressedPath())
  if (!state.dirty && exists) return
  try {
    await rebuildCompressed()
  } catch (err) {
    logger.error({ err }, 'compressed: rebuild failed')
  }
}
