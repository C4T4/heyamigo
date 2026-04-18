import { readFileSync } from 'fs'
import { resolve } from 'path'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { logPrompt } from '../promptlog.js'
import { parseStreamJson, runClaude, TIMEOUT_MS } from './spawn.js'

export type AskClaudeParams = {
  input: string
  sessionId?: string
  allowedTools?: string[] | 'all'
}

export type AskClaudeResult = {
  reply: string
  sessionId: string
  usage: {
    inputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    outputTokens: number
    numTurns: number
  }
}

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
