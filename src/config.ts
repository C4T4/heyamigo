import { readFileSync } from 'fs'
import { resolve } from 'path'
import { z } from 'zod'

export const TriggerModeSchema = z.enum(['all', 'mention', 'command', 'off'])
export type TriggerMode = z.infer<typeof TriggerModeSchema>

const ConfigSchema = z.object({
  whatsapp: z.object({
    enabled: z.boolean().default(true),
    authDir: z.string(),
    browserName: z.string(),
  }),
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      botToken: z.string().optional(),
      pollIntervalMs: z.number().int().positive().default(1000),
    })
    .default({
      enabled: false,
      pollIntervalMs: 1000,
    }),
  owner: z.object({
    number: z.string(),
    treatAsAllowedEverywhere: z.boolean(),
    timezone: z.string().default('UTC'),
  }),
  triggers: z.object({
    aliases: z.array(z.string()),
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
      provider: z.enum(['claude', 'codex', 'grok']).default('claude'),
    })
    .default({ provider: 'claude' }),
  audio: z
    .object({
      transcription: z
        .object({
          enabled: z.boolean().default(true),
        })
        .default({
          enabled: true,
        }),
    })
    .default({
      transcription: {
        enabled: true,
      },
    }),
  voice: z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(['elevenlabs']).default('elevenlabs'),
      apiKeyEnv: z.string().default('ELEVENLABS_API_KEY'),
      voiceId: z.string().default(''),
      modelId: z.string().default('eleven_multilingual_v2'),
      outputFormat: z.string().default('mp3_44100_128'),
      maxChars: z.number().int().positive().default(1200),
      timeoutMs: z.number().int().positive().default(30000),
    })
    .default({
      enabled: false,
      provider: 'elevenlabs',
      apiKeyEnv: 'ELEVENLABS_API_KEY',
      voiceId: '',
      modelId: 'eleven_multilingual_v2',
      outputFormat: 'mp3_44100_128',
      maxChars: 1200,
      timeoutMs: 30000,
    }),
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
  browser: z
    .object({
      // How many browser tasks can run in parallel on the shared
      // Chrome. Each worker drives its own tab. Persistent agent
      // session was dropped in Phase 4; every task is fresh.
      maxWorkers: z.number().int().positive().default(3),
    })
    .default({ maxWorkers: 3 }),
  codex: z
    .object({
      // Optional model override. If unset, Codex uses its default. Passed
      // as `-m <model>` to `codex exec`.
      model: z.string().optional(),
      contextWindow: z.number().int().positive().default(200000),
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
  grok: z
    .object({
      // Binary name or absolute path. xAI's installer puts `grok` on PATH,
      // but some desktop installs expose it from an app bundle.
      bin: z.string().default('grok'),
      // Optional model override. If unset, Grok Build uses its configured
      // default. Passed as `-m <model>`.
      model: z.string().optional(),
      contextWindow: z.number().int().positive().default(1000000),
      // Headless Grok can prompt for tool approvals. In the bot runtime there
      // is no human TUI, so auto-approval is the practical default for write
      // modes; read-only tasks still use plan/read-only settings.
      alwaysApprove: z.boolean().default(true),
      // Keep Grok's own cross-session memory out of heyamigo's explicit memory
      // files unless the operator opts in.
      memory: z.boolean().default(false),
      // Appended verbatim to every `grok` invocation. Escape hatch for CLI
      // version drift without changing code.
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
    // Send a quick acknowledgement when an incoming message has media.
    // Bridge for the typing-indicator regression in Phase 4 — without
    // this, users wait silently while the chat worker processes the
    // image. Set false to disable.
    ackOnMedia: z.boolean().default(true),
    mediaAckText: z.string().default('looking…'),
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
  // Threads — AI-curated relevance watchlist. See src/queue/threads.ts.
  // On by default. Reactive surface only in v1: the agent decides
  // when to open loops, brings them up if naturally relevant, never
  // sends unsolicited messages. To turn off, set enabled=false in
  // config.local.json. Proactive review tick (silent-chat check-ins)
  // is the bit that would be default-off if/when it ships.
  threads: z
    .object({
      enabled: z.boolean().default(true),
      preamblePerChat: z.number().int().positive().default(5),
      // Soft caps used by future cleanup jobs; the worker doesn't read
      // these yet but they're here so config.json can be authored once.
      maxActivePerChat: z.number().int().positive().default(10),
      hotnessCapOnCreate: z.number().int().min(0).max(100).default(70),
      decayPerDay: z.number().int().min(0).default(2),
    })
    .default({
      enabled: true,
      preamblePerChat: 5,
      maxActivePerChat: 10,
      hotnessCapOnCreate: 70,
      decayPerDay: 2,
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
