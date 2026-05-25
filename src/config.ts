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
  ai: z
    .object({
      provider: z.enum(['claude', 'codex']).default('claude'),
    })
    .default({ provider: 'claude' }),
  claude: z.object({
    model: z.string(),
    personalityFile: z.string(),
    addDirs: z.array(z.string()),
    outputFormat: z.enum(['json', 'text', 'stream-json']),
    contextWindow: z.number(),
  }),
  chatPool: z
    .object({
      // How many chat workers run in parallel. Per-address
      // serialization means N workers serve up to N different chats
      // concurrently; per-chat ordering is preserved naturally.
      size: z.number().int().positive().default(5),
    })
    .default({ size: 5 }),
  codex: z
    .object({
      // Optional model override. If unset, Codex uses its default. Passed
      // as `-m <model>` to `codex exec`.
      model: z.string().optional(),
      // Emits --yolo, which bundles no-approvals + full sandbox + skip-
      // trust-check. The narrower verbose flag does not subsume the trust
      // gate on all versions and hangs the process, so --yolo is the safe
      // default. Right setting for a headless owner-bot. Set to false to
      // honor runTask's mode-driven sandbox.
      yolo: z.boolean().default(true),
      // When yolo=false, still bypass the trust-directory prompt. Codex
      // refuses to run in an "untrusted" cwd otherwise.
      skipGitRepoCheck: z.boolean().default(true),
      // Appended verbatim to every `codex exec` invocation. Escape hatch
      // for version-specific flags we haven't first-classed (e.g. flip
      // back to --yolo if the canonical name ever goes away).
      extraArgs: z.array(z.string()).default([]),
    })
    .default({}),
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
    // Hard cap on outbound media size enforced by the sender worker.
    // Default 25MB matches WhatsApp's published per-message media limit
    // for most kinds. Set to null to disable the check.
    maxOutboundMediaBytes: z.number().int().positive().nullable().default(25 * 1024 * 1024),
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
