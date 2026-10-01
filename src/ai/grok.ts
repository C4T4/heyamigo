// Grok Build CLI provider. Maps the neutral AiProvider contract onto
// `grok` headless mode (`--prompt-file` + `--output-format json`).
//
// Grok Build is a local coding-agent CLI, not a plain API model. It already
// knows how to inspect repo config, use MCP, run shell tools, and resume
// sessions. This adapter keeps the same heyamigo contract Claude/Codex use:
// one prompt in, one reply out, opaque provider-native session ids.
//
// Browser jobs cannot use Grok's ambient MCP set: a global `playwright`
// server without --cdp-endpoint would launch a fresh unauthenticated
// browser. There is no Claude `--strict-mcp-config` flag, so isolation is
// a throwaway GROK_HOME + cwd that contains only the task-scoped MCP.

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  AMIGOSPACE_MCP_SERVER_NAME,
  configuredAmigospaceMcp,
  withAmigospaceRoutingContext,
} from '../amigospace/connector.js'
import { browserTaskMcpSpec } from '../browser/task-mcp-command.js'
import { grokHttpMcpServers } from '../mcp/registry.js'
import { composeSystemPrompt } from '../pack/loader.js'
import { config } from '../config.js'
import { dbPath } from '../db/index.js'
import { logger } from '../logger.js'
import { logPrompt, type PromptLogEntry } from '../promptlog.js'
import {
  buildGrokIsolatedConfigToml,
  grokBrowserIsolationArgs,
  grokBrowserIsolationEnv,
  grokBrowserPermissionMode,
  type GrokMcpServer,
} from './grok-settings.js'
import type {
  AiProvider,
  AskParams,
  AskResult,
  AskUsage,
  RunTaskParams,
  RunTaskResult,
  TaskMode,
} from './provider.js'
import { stripControlTokens } from './provider.js'
import { runClaude, TIMEOUT_MS } from './spawn.js'

let cachedSystemPrompt: string | null = null

function systemPrompt(): string {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt
  const personality = readFileSync(
    resolve(process.cwd(), config.claude.personalityFile),
    'utf-8',
  )
  let memoryInstructions = ''
  try {
    memoryInstructions = readFileSync(
      resolve(process.cwd(), config.memory.instructionsFile),
      'utf-8',
    )
  } catch {
    // memory instructions optional
  }
  cachedSystemPrompt = composeSystemPrompt(personality, memoryInstructions)
  return cachedSystemPrompt
}

function reloadSystemPrompt(): void {
  cachedSystemPrompt = null
}

function permissionModeFor(mode: TaskMode): string {
  switch (mode) {
    case 'read-only':
      return 'plan'
    case 'auto':
      return 'acceptEdits'
    case 'full':
      return 'bypassPermissions'
  }
}

function laneTimeoutMs(lane: RunTaskParams['lane']): number {
  return TIMEOUT_MS[lane]
}

function hasWebTool(tools: string[]): boolean {
  return tools.some((tool) => /web(fetch|search)?/i.test(tool))
}

function buildArgs(params: {
  mode: TaskMode
  sessionId?: string
  includeSystemPrompt?: boolean
  prompt: string
  allowedTools?: string[] | 'all'
  promptFile: string
  browserHome?: string
}): { args: string[]; prompt: string } {
  const cfg = config.grok
  let prompt = params.prompt
  const args: string[] = [
    '--output-format',
    'json',
    '--permission-mode',
    params.browserHome || (cfg.alwaysApprove && params.mode !== 'read-only')
      ? grokBrowserPermissionMode()
      : permissionModeFor(params.mode),
    '--verbatim',
  ]

  if (cfg.model) args.push('-m', cfg.model)

  if (params.mode === 'read-only') {
    args.push('--sandbox', 'read-only')
  } else if (cfg.alwaysApprove) {
    args.push('--always-approve')
  }

  if (cfg.memory) {
    args.push('--experimental-memory')
  } else {
    args.push('--no-memory')
  }

  for (const extra of cfg.extraArgs) args.push(extra)

  if (params.browserHome) {
    // After extraArgs so cwd/leader/web isolation cannot be overridden.
    args.push(...grokBrowserIsolationArgs(params.browserHome))
  } else {
    args.push('--cwd', process.cwd())
    if (params.allowedTools && params.allowedTools !== 'all') {
      if (params.allowedTools.length > 0) {
        args.push('--allow', params.allowedTools.join(','))
      }
      if (!hasWebTool(params.allowedTools)) {
        args.push('--disable-web-search')
      }
    }
  }

  if (params.sessionId) {
    args.push('--resume', params.sessionId)
  } else if (params.includeSystemPrompt) {
    // Keep this in the prompt file instead of argv so large personalities and
    // memory instructions don't hit ARG_MAX.
    prompt = `${systemPrompt()}\n\n---\n\n${prompt}`
  }

  args.push('--prompt-file', params.promptFile)
  return { args, prompt }
}

type GrokOutput = {
  text?: unknown
  output_text?: unknown
  result?: unknown
  message?: unknown
  reply?: unknown
  type?: unknown
  data?: unknown
  message_id?: unknown
  sessionId?: unknown
  session_id?: unknown
  requestId?: unknown
  request_id?: unknown
  stopReason?: unknown
  stop_reason?: unknown
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    prompt_tokens?: number
    completion_tokens?: number
    cached_input_tokens?: number
    input_tokens?: number
    output_tokens?: number
  }
  [key: string]: unknown
}

function usageFrom(raw: GrokOutput): AskUsage {
  const usage = raw.usage
  return {
    inputTokens:
      usage?.inputTokens ?? usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
    cacheReadTokens:
      usage?.cacheReadTokens ?? usage?.cached_input_tokens ?? 0,
    cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
    outputTokens:
      usage?.outputTokens ?? usage?.output_tokens ?? usage?.completion_tokens ?? 0,
    numTurns: 0,
  }
}

function textFrom(raw: GrokOutput): string | null {
  for (const value of [
    raw.text,
    raw.output_text,
    raw.result,
    raw.reply,
    raw.message,
  ]) {
    if (typeof value === 'string') return value
  }
  return null
}

function parseJsonObject(stdout: string): GrokOutput | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as GrokOutput
  } catch {
    // Grok may emit log lines before/after JSON on some failures. Try the
    // broadest JSON-looking slice before giving up.
    const first = trimmed.indexOf('{')
    const last = trimmed.lastIndexOf('}')
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1)) as GrokOutput
      } catch {
        return null
      }
    }
    return null
  }
}

function parseStreamingJson(stdout: string): RunTaskResult | null {
  let reply = ''
  let sessionId: string | undefined
  let error: string | null = null

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let ev: GrokOutput
    try {
      ev = JSON.parse(trimmed) as GrokOutput
    } catch {
      continue
    }

    if (ev.type === 'text' && typeof ev.data === 'string') {
      reply += ev.data
    } else if (typeof ev.type === 'string' && ev.type.includes('tool')) {
      // Status text before a tool call is not the reply.
      reply = ''
    } else if (ev.type === 'end') {
      const id = ev.sessionId ?? ev.session_id
      if (typeof id === 'string') sessionId = id
    } else if (ev.type === 'error') {
      error = textFrom(ev) ?? (typeof ev.data === 'string' ? ev.data : null)
    }
  }

  if (error) throw new Error(`grok returned error: ${error}`)
  if (!reply) return null

  return {
    // Checked !reply above on the raw accumulation so a stream that produced
    // only control markers still returns a result (with an empty reply) rather
    // than null, which the caller would read as "no output to parse".
    reply: stripControlTokens(reply),
    sessionId,
    usage: {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      numTurns: 0,
    },
  }
}

function parseGrokOutput(stdout: string): RunTaskResult | null {
  const raw = parseJsonObject(stdout)
  if (raw) {
    if (raw.type === 'error') {
      throw new Error(
        `grok returned error: ${textFrom(raw) ?? stdout.slice(0, 500)}`,
      )
    }

    const reply = textFrom(raw)
    if (reply !== null) {
      const id = raw.sessionId ?? raw.session_id
      return {
        reply: stripControlTokens(reply),
        sessionId: typeof id === 'string' ? id : undefined,
        usage: usageFrom(raw),
      }
    }
  }

  return parseStreamingJson(stdout)
}

function createPromptFile(prompt: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'heyamigo-grok-'))
  const path = join(dir, 'prompt.txt')
  writeFileSync(path, prompt, 'utf-8')
  return { dir, path }
}

function removePromptFile(tmp: { dir: string; path: string }): void {
  try {
    unlinkSync(tmp.path)
  } catch {}
  try {
    rmSync(tmp.dir, { recursive: true, force: true })
  } catch {}
}

function realGrokHome(): string {
  return process.env.GROK_HOME || join(homedir(), '.grok')
}

function unquoteToml(value: string): string {
  const v = value.trim()
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    try {
      return JSON.parse(
        v.startsWith("'") ? `"${v.slice(1, -1).replace(/"/g, '\\"')}"` : v,
      ) as string
    } catch {
      return v.slice(1, -1)
    }
  }
  return v
}

/** HTTP MCPs from the real user Grok config. Isolated homes must not copy Playwright. */
const ISOLATED_GROK_MCP_BLOCKLIST = new Set(['playwright'])

function userGrokHttpMcps(): Record<string, { url: string; headers: Record<string, string> }> {
  const path = join(realGrokHome(), 'config.toml')
  if (!existsSync(path)) return {}
  const text = readFileSync(path, 'utf-8')
  const servers: Record<
    string,
    { url: string; headers: Record<string, string>; enabled: boolean }
  > = {}
  let current: string | null = null
  let inHeaders = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const headerMatch = line.match(/^\[mcp_servers\.([^\].]+)\]$/)
    const headersMatch = line.match(/^\[mcp_servers\.([^\].]+)\.headers\]$/)
    if (headersMatch) {
      current = headersMatch[1]
      inHeaders = true
      if (!servers[current]) servers[current] = { url: '', headers: {}, enabled: true }
      continue
    }
    if (headerMatch) {
      current = headerMatch[1]
      inHeaders = false
      if (!servers[current]) servers[current] = { url: '', headers: {}, enabled: true }
      continue
    }
    if (line.startsWith('[')) {
      current = null
      inHeaders = false
      continue
    }
    if (!current) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = unquoteToml(line.slice(eq + 1))
    if (inHeaders) {
      servers[current].headers[key] = val
      continue
    }
    if (key === 'url') servers[current].url = val
    if (key === 'enabled') servers[current].enabled = val !== 'false'
  }
  const out: Record<string, { url: string; headers: Record<string, string> }> = {}
  for (const [name, spec] of Object.entries(servers)) {
    if (ISOLATED_GROK_MCP_BLOCKLIST.has(name)) continue
    if (!spec.url || spec.enabled === false) continue
    out[name] = { url: spec.url, headers: spec.headers }
  }
  return out
}

function linkGrokHomeFile(src: string, dest: string): void {
  try {
    symlinkSync(src, dest)
  } catch {
    copyFileSync(src, dest)
  }
}

function createIsolatedGrokHome(
  mcpServers: Record<string, GrokMcpServer>,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'heyamigo-grok-browser-'))
  try {
    const realHome = realGrokHome()
    for (const name of ['auth.json', 'models_cache.json'] as const) {
      const src = join(realHome, name)
      if (existsSync(src)) linkGrokHomeFile(src, join(dir, name))
    }
    writeFileSync(join(dir, 'config.toml'), buildGrokIsolatedConfigToml(mcpServers), {
      mode: 0o600,
    })
    return dir
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

function removeIsolatedGrokHome(dir: string | null): void {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

async function runGrokTask(params: RunTaskParams): Promise<RunTaskResult> {
  const amigospace = configuredAmigospaceMcp(params.allowedTools)
  const prompt = withAmigospaceRoutingContext(params.input, !!amigospace)
  const tmp = createPromptFile(prompt)
  let isolatedHome: string | null = null
  let args: string[] = []
  let promptForFile = prompt
  try {
    if (params.browserCdpUrl) {
      if (!params.browserTaskId) {
        throw new Error('browserTaskId is required for task-scoped browser MCP')
      }
      const mcp = browserTaskMcpSpec({
        cdpEndpoint: params.browserCdpUrl,
        taskId: params.browserTaskId,
        databasePath: dbPath(),
      })
      const servers: Record<string, GrokMcpServer> = {
        playwright: mcp,
        ...userGrokHttpMcps(),
        ...grokHttpMcpServers(),
      }
      if (amigospace) servers[AMIGOSPACE_MCP_SERVER_NAME] = amigospace
      isolatedHome = createIsolatedGrokHome(servers)
    }

    const built = buildArgs({
      mode: params.mode,
      sessionId: params.sessionId,
      includeSystemPrompt: params.includeSystemPrompt,
      prompt,
      allowedTools: params.allowedTools,
      promptFile: tmp.path,
      browserHome: isolatedHome ?? undefined,
    })
    args = built.args
    promptForFile = built.prompt
    writeFileSync(tmp.path, promptForFile, 'utf-8')

    logger.info(
      {
        caller: params.caller,
        resume: !!params.sessionId,
        argv: args,
        promptChars: promptForFile.length,
        grokHome: isolatedHome,
      },
      'spawning grok',
    )

    const { stdout, stderr, durationMs } = await runClaude({
      args,
      input: '',
      timeoutMs: laneTimeoutMs(params.lane),
      caller: params.caller as PromptLogEntry['caller'],
      bin: config.grok.bin,
      cwd: isolatedHome ?? undefined,
      env: isolatedHome ? grokBrowserIsolationEnv(isolatedHome) : undefined,
    })
    const startedAt = Date.now() - durationMs

    const parsed = parseGrokOutput(stdout)
    if (!parsed) {
      throw new Error(
        `grok produced no parseable result; stdout: ${stdout.slice(0, 500)}`,
      )
    }

    void logPrompt({
      ts: Math.floor(startedAt / 1000),
      caller: params.caller as PromptLogEntry['caller'],
      args,
      input: params.input,
      output: parsed.reply,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
      durationMs,
      stderr,
    })

    return parsed
  } finally {
    removePromptFile(tmp)
    removeIsolatedGrokHome(isolatedHome)
  }
}

async function askGrok(params: AskParams): Promise<AskResult> {
  const result = await runGrokTask({
    input: params.input,
    caller: 'worker',
    mode: 'auto',
    lane: 'main',
    sessionId: params.sessionId,
    includeSystemPrompt: true,
    allowedTools: params.allowedTools,
    addDirs: [
      config.memory.dir,
      config.storage.mediaDir,
    ],
  })
  if (!result.sessionId) {
    throw new Error('grok ask: response missing session id')
  }
  return {
    reply: result.reply,
    sessionId: result.sessionId,
    usage: result.usage ?? {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      numTurns: 0,
    },
  }
}

export const grokProvider: AiProvider = {
  name: 'grok',
  model: config.grok.model ?? 'grok-default',
  contextWindow: config.grok.contextWindow,
  // The current Grok Build headless JSON output does not expose reliable
  // per-turn token usage, so treat any reported counts as this invocation only.
  usageReportingMode: 'per-turn',
  ask: askGrok,
  runTask: runGrokTask,
  reloadSystemPrompt,
}
