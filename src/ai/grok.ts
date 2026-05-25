// Grok Build CLI provider. Maps the neutral AiProvider contract onto
// `grok` headless mode (`--prompt-file` + `--output-format json`).
//
// Grok Build is a local coding-agent CLI, not a plain API model. It already
// knows how to inspect repo config, use MCP, run shell tools, and resume
// sessions. This adapter keeps the same heyamigo contract Claude/Codex use:
// one prompt in, one reply out, opaque provider-native session ids.

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { logPrompt, type PromptLogEntry } from '../promptlog.js'
import type {
  AiProvider,
  AskParams,
  AskResult,
  AskUsage,
  RunTaskParams,
  RunTaskResult,
  TaskMode,
} from './provider.js'
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
  cachedSystemPrompt = memoryInstructions
    ? `${personality}\n\n---\n\n${memoryInstructions}`
    : personality
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
}): { args: string[]; prompt: string } {
  const cfg = config.grok
  let prompt = params.prompt
  const args: string[] = [
    '--cwd',
    process.cwd(),
    '--output-format',
    'json',
    '--permission-mode',
    permissionModeFor(params.mode),
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

  if (params.allowedTools && params.allowedTools !== 'all') {
    if (params.allowedTools.length > 0) {
      args.push('--allow', params.allowedTools.join(','))
    }
    if (!hasWebTool(params.allowedTools)) {
      args.push('--disable-web-search')
    }
  }

  for (const extra of cfg.extraArgs) args.push(extra)

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
    reply: reply.trim(),
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
        reply: reply.trim(),
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

async function runGrokTask(params: RunTaskParams): Promise<RunTaskResult> {
  const tmp = createPromptFile(params.input)
  let args: string[] = []
  let promptForFile = params.input
  try {
    const built = buildArgs({
      mode: params.mode,
      sessionId: params.sessionId,
      includeSystemPrompt: params.includeSystemPrompt,
      prompt: params.input,
      allowedTools: params.allowedTools,
      promptFile: tmp.path,
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
      },
      'spawning grok',
    )

    const { stdout, stderr, durationMs } = await runClaude({
      args,
      input: '',
      timeoutMs: laneTimeoutMs(params.lane),
      caller: params.caller as PromptLogEntry['caller'],
      bin: config.grok.bin,
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
  contextWindow: config.grok.contextWindow,
  // The current Grok Build headless JSON output does not expose reliable
  // per-turn token usage, so treat any reported counts as this invocation only.
  usageReportingMode: 'per-turn',
  ask: askGrok,
  runTask: runGrokTask,
  reloadSystemPrompt,
}
