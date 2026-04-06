import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, resolve } from 'path'
import { config } from '../config.js'
import { serializeFrontmatter, type Frontmatter } from './frontmatter.js'
import {
  digestStatePath,
  entityDir,
  entityFilePath,
  entityIndexPath,
  masterIndexPath,
  memoryRoot,
  treeIndexPath,
  treeRoot,
} from './paths.js'

export type Tree = 'buckets' | 'persons' | 'chats'

export type DigestState = {
  jids: Record<string, { lastDigestedAt: number }>
  persons: Record<string, { lastDigestedAt: number }>
}

// ---------- low-level helpers ----------

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

function ensureDirFor(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8')
}

function writeFile(path: string, content: string): void {
  ensureDirFor(path)
  writeFileSync(path, content, 'utf-8')
}

// ---------- master + tree indexes ----------

export function ensureScaffold(): void {
  ensureDir(memoryRoot())
  ensureDir(treeRoot('buckets'))
  ensureDir(treeRoot('persons'))
  ensureDir(treeRoot('chats'))

  if (!existsSync(masterIndexPath())) {
    writeFile(
      masterIndexPath(),
      `# Memory\n\nLong-term memory for the bot.\n\n- buckets/ — topics, projects, global knowledge\n- persons/ — people I've interacted with\n- chats/ — conversation briefs per chat\n\nEach tree has its own index.md and each entity has its own index.md listing files.\n`,
    )
  }
  for (const tree of ['buckets', 'persons', 'chats'] as const) {
    if (!existsSync(treeIndexPath(tree))) {
      writeFile(
        treeIndexPath(tree),
        `# ${tree}\n\n(empty)\n`,
      )
    }
  }
}

export function listEntities(tree: Tree): string[] {
  const root = treeRoot(tree)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export function refreshTreeIndex(tree: Tree): void {
  const entities = listEntities(tree)
  const lines = [`# ${tree}`, '']
  if (entities.length === 0) {
    lines.push('(empty)')
  } else {
    for (const slug of entities) {
      const idx = readIfExists(entityIndexPath(tree, slug))
      const title = extractTitle(idx) || slug
      lines.push(`- ${slug}/ — ${title}`)
    }
  }
  lines.push('')
  writeFile(treeIndexPath(tree), lines.join('\n'))
}

function extractTitle(indexContent: string | null): string | null {
  if (!indexContent) return null
  // prefer first markdown H1 after frontmatter
  const m = indexContent.match(/^#\s+(.+)$/m)
  return m?.[1]?.trim() ?? null
}

// ---------- entity-level I/O ----------

export function readEntityIndex(
  tree: Tree,
  slug: string,
): string | null {
  return readIfExists(entityIndexPath(tree, slug))
}

export function writeEntityIndex(
  tree: Tree,
  slug: string,
  frontmatter: Frontmatter,
  body: string,
): void {
  const content = serializeFrontmatter(frontmatter, body)
  writeFile(entityIndexPath(tree, slug), content)
  refreshTreeIndex(tree)
}

export function entityExists(tree: Tree, slug: string): boolean {
  return existsSync(entityDir(tree, slug))
}

export function readEntityFile(
  tree: Tree,
  slug: string,
  filename: string,
): string | null {
  return readIfExists(entityFilePath(tree, slug, filename))
}

export function writeEntityFile(
  tree: Tree,
  slug: string,
  filename: string,
  content: string,
): void {
  writeFile(entityFilePath(tree, slug, filename), content)
}

export function listEntityFiles(tree: Tree, slug: string): string[] {
  const dir = entityDir(tree, slug)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((n) => n.endsWith('.md'))
    .sort()
}

// ---------- per-chat brief ----------

export function readBrief(jid: string): string | null {
  return readEntityFile('chats', jid, 'brief.md')
}

export function writeBrief(jid: string, content: string): void {
  writeEntityFile('chats', jid, 'brief.md', content)
  // maintain index.md
  const body = [
    `# ${jid}`,
    '',
    'Chat brief.',
    '',
    '## Files',
    '- brief.md — purpose, tone, recent topics',
    '',
  ].join('\n')
  writeEntityIndex(
    'chats',
    jid,
    {
      jid,
      scope: 'chat',
      updated_at: new Date().toISOString().slice(0, 10),
    },
    body,
  )
}

// ---------- per-person profile ----------

export function readProfile(number: string): string | null {
  if (!number) return null
  return readEntityFile('persons', number, 'profile.md')
}

export function writeProfile(number: string, content: string): void {
  if (!number) return
  writeEntityFile('persons', number, 'profile.md', content)
  const body = [
    `# ${number}`,
    '',
    'Person profile.',
    '',
    '## Files',
    '- profile.md — facts, preferences, patterns',
    '',
  ].join('\n')
  writeEntityIndex(
    'persons',
    number,
    {
      number,
      scope: 'person',
      updated_at: new Date().toISOString().slice(0, 10),
    },
    body,
  )
}

export function profileExists(number: string): boolean {
  if (!number) return false
  return existsSync(entityFilePath('persons', number, 'profile.md'))
}

export function briefExists(jid: string): boolean {
  return existsSync(entityFilePath('chats', jid, 'brief.md'))
}

// ---------- digest state ----------

export function loadDigestState(): DigestState {
  const raw = readIfExists(digestStatePath())
  if (!raw) return { jids: {}, persons: {} }
  try {
    const parsed = JSON.parse(raw) as Partial<DigestState>
    return { jids: parsed.jids ?? {}, persons: parsed.persons ?? {} }
  } catch {
    return { jids: {}, persons: {} }
  }
}

export function saveDigestState(state: DigestState): void {
  writeFile(digestStatePath(), JSON.stringify(state, null, 2) + '\n')
}

export function getLastDigestedAt(
  state: DigestState,
  kind: 'jid' | 'person',
  key: string,
): number {
  const bucket = kind === 'jid' ? state.jids : state.persons
  return bucket[key]?.lastDigestedAt ?? 0
}

export function setLastDigestedAt(
  kind: 'jid' | 'person',
  key: string,
  ts: number,
): void {
  const state = loadDigestState()
  const bucket = kind === 'jid' ? state.jids : state.persons
  bucket[key] = { lastDigestedAt: ts }
  saveDigestState(state)
}

export function jsonlMtimeFor(jid: string): number {
  const path = resolve(
    process.cwd(),
    config.storage.messagesDir,
    `${jid}.jsonl`,
  )
  if (!existsSync(path)) return 0
  return Math.floor(statSync(path).mtimeMs / 1000)
}
