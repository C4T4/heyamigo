import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { loadSharedHttpMcps } from '../mcp/registry.js'

const DEFAULT_PACK = './config/pack.json'
const MANDATORY_SKILL = './config/mandatory/i-have-adhd.md'
const ALWAYS_CAP = 24_000
const MANDATORY_ID = 'i-have-adhd'

export type PackSkill = {
  id: string
  file: string
  mode: 'always' | 'demand'
  source: string
  description: string
}

export type Pack = {
  version: 1
  skills: PackSkill[]
  mcps: string[]
}

export function packPath(): string {
  return resolve(process.cwd(), process.env.HEYAMIGO_PACK || DEFAULT_PACK)
}

function asSkill(raw: unknown): PackSkill | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const file = typeof record.file === 'string' ? record.file.trim() : ''
  if (!id || !file) return null
  const mode = record.mode === 'always' ? 'always' : 'demand'
  const source = typeof record.source === 'string' ? record.source.trim() : ''
  const description =
    typeof record.description === 'string' ? record.description.trim() : ''
  return { id, file, mode, source, description }
}

export function loadPack(): Pack {
  const path = packPath()
  if (!existsSync(path)) return { version: 1, skills: [], mcps: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    throw new Error(`pack is not valid JSON: ${path}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`pack must be an object: ${path}`)
  }
  const record = parsed as Record<string, unknown>
  const skills = Array.isArray(record.skills)
    ? record.skills.map(asSkill).filter((skill): skill is PackSkill => skill !== null)
    : []
  if (skills.some((skill) => skill.id === MANDATORY_ID)) {
    throw new Error(
      `${MANDATORY_ID} is mandatory. Remove it from ${path}. Other skills stay in the pack.`,
    )
  }
  const mcps = Array.isArray(record.mcps)
    ? record.mcps
        .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim())
    : []
  return { version: 1, skills, mcps }
}

function readSkillFile(file: string): string | null {
  const path = resolve(process.cwd(), file)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8').trim()
}

export function readMandatorySkill(): string {
  const path = resolve(process.cwd(), MANDATORY_SKILL)
  if (!existsSync(path)) {
    throw new Error(`mandatory skill missing: ${path}`)
  }
  const body = readFileSync(path, 'utf-8').trim()
  if (!body) throw new Error(`mandatory skill empty: ${path}`)
  return body
}

export function mandatorySkillText(): string {
  return `## Mandatory skill: ${MANDATORY_ID}\n\nNot a pack entry. Every reply, every provider. No off switch.\n\n${readMandatorySkill()}`
}

// Resume turns do not resend the system prompt. Chat ingest appends this
// after the user text so the shape still applies on an old session.
export function mandatoryShapeReminder(): string {
  readMandatorySkill()
  return [
    '[Reply shape]',
    'Mandatory. No off switch. Full rules are the i-have-adhd skill.',
    'First line is the action, command, path, or answer. Not "I\'ll" or "Looking at".',
    'If work has steps, number them. If something is still open, the last line is one next action under 2 minutes.',
    'No preamble, no recap, no closer. Harness tags stay at the end. An empty group reply stays empty.',
  ].join('\n')
}

export function promptStampBytes(): Buffer {
  const packFile = packPath()
  const packBytes = existsSync(packFile) ? readFileSync(packFile) : Buffer.from('')
  return Buffer.concat([
    Buffer.from(readMandatorySkill()),
    Buffer.from('\0'),
    packBytes,
  ])
}

export function alwaysOnSkillText(): string {
  const chunks: string[] = []
  let used = 0
  for (const skill of loadPack().skills) {
    if (skill.mode !== 'always') continue
    const body = readSkillFile(skill.file)
    if (!body) continue
    const block = `### ${skill.id}\n\n${body}`
    if (used + block.length > ALWAYS_CAP) break
    chunks.push(block)
    used += block.length
  }
  if (!chunks.length) return ''
  return `## Pack skills (always on)\n\nThese apply to every reply on every provider until the pack entry is removed or set to mode "demand".\n\n${chunks.join('\n\n')}`
}

export function onDemandSkillCatalog(): string {
  const demand = loadPack().skills.filter((skill) => skill.mode !== 'always')
  if (!demand.length) return ''
  const lines = demand.map((skill) => {
    const desc = skill.description || skill.source || skill.file
    return `- \`${skill.id}\` — ${desc}. Read \`${skill.file}\` when this task matches.`
  })
  return `## Pack skills (on demand)\n\nNot injected. Read the file only when the task matches.\n\n${lines.join('\n')}`
}

export function missingPackMcps(): string[] {
  const have = new Set(Object.keys(loadSharedHttpMcps()))
  return loadPack().mcps.filter((name) => !have.has(name))
}

export function composeSystemPrompt(
  personality: string,
  memoryInstructions: string,
): string {
  const parts = [personality]
  const always = alwaysOnSkillText()
  if (always) parts.push(always)
  const catalog = onDemandSkillCatalog()
  if (catalog) parts.push(catalog)
  if (memoryInstructions) parts.push(memoryInstructions)
  // Last. Personality and memory are long; a skill placed above them gets ignored.
  parts.push(mandatorySkillText())
  return parts.join('\n\n---\n\n')
}
