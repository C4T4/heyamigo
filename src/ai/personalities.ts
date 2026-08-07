import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, resolve } from 'path'
import { config } from '../config.js'

const PERSONALITY_NAME = /^[a-z0-9][a-z0-9-]*$/

function personalitiesDir(): string {
  return resolve(process.cwd(), 'config', 'personalities')
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function configuredPersonalityFile(raw: Record<string, unknown> | null): unknown {
  const claude = raw?.claude
  return claude && typeof claude === 'object'
    ? (claude as Record<string, unknown>).personalityFile
    : undefined
}

export function listPersonalities(): string[] {
  try {
    return readdirSync(personalitiesDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -3))
      .filter((name) => PERSONALITY_NAME.test(name))
      .sort()
  } catch {
    return []
  }
}

export function currentPersonality(): string {
  return basename(config.claude.personalityFile, '.md')
}

export function personalityLabel(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function resolvePersonalityName(input: string): string | null {
  const normalized = input.trim().toLowerCase()
  const aliases: Record<string, string> = {
    realist: 'unfiltered-realist',
    unfiltered: 'unfiltered-realist',
  }
  const requested = aliases[normalized] ?? normalized
  return listPersonalities().includes(requested) ? requested : null
}

export function setActivePersonality(name: string): string {
  if (!PERSONALITY_NAME.test(name) || !listPersonalities().includes(name)) {
    throw new Error(`Unknown personality: ${name}`)
  }

  const relativeFile = `./config/personalities/${name}.md`
  const personalityPath = resolve(personalitiesDir(), `${name}.md`)
  if (!existsSync(personalityPath)) {
    throw new Error(`Personality file not found: ${personalityPath}`)
  }

  const basePath = resolve(process.cwd(), 'config', 'config.json')
  const localPath = resolve(process.cwd(), 'config', 'config.local.json')
  const local = readJson(localPath)
  // Respect the existing config layering. If config.local.json already owns
  // this setting, update it; otherwise keep setup's canonical config.json.
  const targetPath = typeof configuredPersonalityFile(local) === 'string'
    ? localPath
    : basePath
  const target = readJson(targetPath)
  if (!target) throw new Error(`Could not read configuration: ${targetPath}`)

  const claude = target.claude && typeof target.claude === 'object'
    ? target.claude as Record<string, unknown>
    : {}
  claude.personalityFile = relativeFile
  target.claude = claude
  writeFileSync(targetPath, JSON.stringify(target, null, 2) + '\n', 'utf-8')

  // Config is parsed once at boot. Keep the live process aligned with the
  // persisted value before prompt caches are reloaded.
  config.claude.personalityFile = relativeFile
  return relativeFile
}
