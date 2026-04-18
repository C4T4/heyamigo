import { readFileSync } from 'fs'
import { resolve } from 'path'
import { z } from 'zod'

const TriggerModeSchema = z.enum(['all', 'mention', 'command', 'off'])

const ConfigSchema = z.object({
  whatsapp: z.object({
    authDir: z.string(),
    browserName: z.string(),
  }),
  owner: z.object({
    number: z.string(),
    treatAsAllowedEverywhere: z.boolean(),
    timezone: z.string().default('UTC'),
  }),
  triggers: z.object({
    aliases: z.array(z.string()),
    groupMode: TriggerModeSchema,
    dmMode: TriggerModeSchema,
    replyToBotCounts: z.boolean(),
  }),
  commands: z.object({
    prefix: z.string(),
    reset: z.array(z.string()),
    status: z.array(z.string()),
    reload: z.array(z.string()),
  }),
  claude: z.object({
    model: z.string(),
    personalityFile: z.string(),
    addDirs: z.array(z.string()),
    outputFormat: z.enum(['json', 'text', 'stream-json']),
    contextWindow: z.number(),
  }),
  bootstrap: z.object({
    historyDepth: z.number(),
    includeHistory: z.boolean(),
    includeChatMetadata: z.boolean(),
    recentContextDepth: z.number().default(3),
  }),
  reply: z.object({
    quoteInGroups: z.boolean(),
    chunkChars: z.number(),
    chunkDelayMs: z.number(),
    typingIndicator: z.boolean(),
    errorMessage: z.string(),
    maxMessageAgeMs: z.number(),
    showStats: z.boolean().default(true),
  }),
  storage: z.object({
    messagesDir: z.string(),
    sessionsFile: z.string(),
    mediaDir: z.string(),
    mediaRetentionDays: z.number(),
  }),
  memory: z.object({
    dir: z.string(),
    instructionsFile: z.string(),
    importInstructionsFile: z.string(),
    importPermissionMode: z.enum(['acceptEdits', 'bypass']),
    digestDebounceMs: z.number(),
    sweepIntervalMs: z.number(),
    sweepMinNewMessages: z.number(),
    maxHistoryForDigest: z.number(),
  }),
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
    promptRetentionDays: z.number(),
  }),
})

export type Config = z.infer<typeof ConfigSchema>

function loadJsonIfExists(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base
  if (typeof override !== 'object' || Array.isArray(override)) return override as T
  if (base === null || base === undefined) return override as T
  if (typeof base !== 'object' || Array.isArray(base)) return override as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v)
  }
  return out as T
}

function loadConfig(): Config {
  const cwd = process.cwd()
  const baseFile = resolve(cwd, 'config/config.json')
  const localFile = resolve(cwd, 'config/config.local.json')
  const base = loadJsonIfExists(baseFile)
  if (base === undefined) throw new Error(`Missing config file: ${baseFile}`)
  const local = loadJsonIfExists(localFile)
  const merged = local ? deepMerge(base, local) : base
  return ConfigSchema.parse(merged)
}

export const config = loadConfig()
