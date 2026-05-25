import { readFileSync } from 'fs'
import { resolve } from 'path'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { logPrompt, type PromptLogEntry } from '../promptlog.js'
import type {
  AiProvider,
  AskParams,
  AskResult,
  RunTaskParams,
  RunTaskResult,
  TaskMode,
} from './provider.js'
import { parseStreamJson, runClaude, TIMEOUT_MS } from './spawn.js'

// Back-compat aliases — older callers import these names.
export type AskClaudeParams = AskParams
export type AskClaudeResult = AskResult

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

export function reloadSystemPrompt(): void {
  cachedSystemPrompt = null
}

function buildArgs(params: AskClaudeParams): string[] {
  // stream-json gives per-event visibility into the agent loop (system init,
  // assistant messages, tool_use, tool_result, final result). We parse the
  // final 'result' event for the return shape, and log event types for
  // diagnostic purposes.
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    config.claude.model,
    '--permission-mode',
    'acceptEdits',
  ]

  if (params.sessionId) {
    args.push('--resume', params.sessionId)
  } else {
    args.push('--append-system-prompt', systemPrompt())
    for (const dir of config.claude.addDirs) {
      args.push('--add-dir', resolve(process.cwd(), dir))
    }
  }

  // Memory + media dirs for file access (only effective if tools allow Read)
  args.push('--add-dir', resolve(process.cwd(), config.memory.dir))
  args.push('--add-dir', resolve(process.cwd(), config.storage.mediaDir))

  // Tool restriction per role
  if (
    params.allowedTools &&
    params.allowedTools !== 'all' &&
    params.allowedTools.length > 0
  ) {
    args.push('--allowedTools', params.allowedTools.join(','))
  }

  return args
}

export async function askClaude(
  params: AskClaudeParams,
): Promise<AskClaudeResult> {
  const args = buildArgs(params)
  logger.debug(
    { resume: !!params.sessionId, inputChars: params.input.length },
    'spawning claude',
  )

  const { stdout, stderr, durationMs } = await runClaude({
    args,
    input: params.input,
    timeoutMs: TIMEOUT_MS.main,
    caller: 'worker',
  })

  const startedAt = Date.now() - durationMs
  const parsed = parseStreamJson(stdout)

  if (!parsed) {
    throw new Error(
      `claude stream-json produced no result event; stdout: ${stdout.slice(0, 500)}`,
    )
  }
  if (parsed.isError || parsed.subtype !== 'success') {
    throw new Error(
      `claude returned error (subtype=${parsed.subtype}): ${parsed.result}`,
    )
  }
  if (!parsed.result || !parsed.sessionId) {
    throw new Error(
      `claude output missing result or session_id: ${stdout.slice(0, 200)}`,
    )
  }

  const result: AskClaudeResult = {
    reply: parsed.result,
    sessionId: parsed.sessionId,
    usage: {
      inputTokens: parsed.usage?.input_tokens ?? 0,
      cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
      numTurns: parsed.numTurns ?? 0,
    },
  }

  void logPrompt({
    ts: Math.floor(startedAt / 1000),
    caller: 'worker',
    args,
    input: params.input,
    output: result.reply,
    sessionId: result.sessionId,
    usage: result.usage,
    durationMs,
    stderr,
    eventTypes: parsed.eventTypes,
  })

  return result
}

// Claude's per-mode permission + tool defaults. The caller can still override
// allowedTools explicitly; mode just sets the floor.
function permissionModeFor(mode: TaskMode): string {
  switch (mode) {
    case 'read-only':
      return 'default' // prompts on writes; we layer allowedTools to enforce
    case 'auto':
    case 'full':
      return 'acceptEdits'
  }
}

function defaultAllowedToolsFor(mode: TaskMode): string[] | undefined {
  if (mode === 'read-only') return ['Read', 'Grep', 'Glob', 'WebFetch']
  return undefined // no restriction
}

function buildTaskArgs(params: RunTaskParams): string[] {
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    config.claude.model,
    '--permission-mode',
    permissionModeFor(params.mode),
  ]

  if (params.sessionId) {
    args.push('--resume', params.sessionId)
  } else if (params.includeSystemPrompt) {
    args.push('--append-system-prompt', systemPrompt())
  }

  // On fresh sessions, fold the configured baseline read dirs in too. On
  // resume Claude already has them baked into the session state.
  if (!params.sessionId && params.includeSystemPrompt) {
    for (const dir of config.claude.addDirs) {
      args.push('--add-dir', resolve(process.cwd(), dir))
    }
  }

  for (const dir of params.addDirs ?? []) {
    args.push('--add-dir', resolve(process.cwd(), dir))
  }

  const allowedTools =
    params.allowedTools && params.allowedTools !== 'all'
      ? params.allowedTools
      : defaultAllowedToolsFor(params.mode)
  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','))
  }

  return args
}

function laneTimeoutMs(lane: RunTaskParams['lane']): number {
  return TIMEOUT_MS[lane]
}

export async function runClaudeTask(
  params: RunTaskParams,
): Promise<RunTaskResult> {
  const args = buildTaskArgs(params)
  const { stdout, stderr, durationMs } = await runClaude({
    args,
    input: params.input,
    timeoutMs: laneTimeoutMs(params.lane),
    caller: params.caller as PromptLogEntry['caller'],
  })
  const startedAt = Date.now() - durationMs

  const parsed = parseStreamJson(stdout)
  if (!parsed) {
    throw new Error(
      `${params.caller} stream-json produced no result event: ${stdout.slice(0, 200)}`,
    )
  }
  if (parsed.isError || parsed.subtype !== 'success' || !parsed.result) {
    throw new Error(
      `${params.caller} bad output: ${parsed.result || stdout.slice(0, 200)}`,
    )
  }

  const reply = parsed.result.trim()
  const usage = {
    inputTokens: parsed.usage?.input_tokens ?? 0,
    cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
    numTurns: parsed.numTurns ?? 0,
  }

  void logPrompt({
    ts: Math.floor(startedAt / 1000),
    caller: params.caller as PromptLogEntry['caller'],
    args,
    input: params.input,
    output: reply,
    sessionId: parsed.sessionId ?? undefined,
    usage,
    durationMs,
    stderr,
    eventTypes: parsed.eventTypes,
  })

  return {
    reply,
    sessionId: parsed.sessionId ?? undefined,
    usage,
  }
}

export const claudeProvider: AiProvider = {
  name: 'claude',
  // Claude CLI's `result` event reports per-turn usage (just the
  // tokens consumed by this single resume invocation).
  usageReportingMode: 'per-turn',
  ask: askClaude,
  runTask: runClaudeTask,
  reloadSystemPrompt,
}
