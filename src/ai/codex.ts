// Codex CLI provider. Maps the neutral AiProvider contract onto
// `codex exec --json`. Flag names match the public CLI docs as of writing
// (developers.openai.com/codex/cli/features); if your local Codex version
// uses different flags, the small surface here is the only place to adjust.
//
// What's wired:
//   - exec mode with --json (NDJSON event stream on stdout)
//   - --add-dir for extra writable roots
//   - --sandbox-mode for tier (read-only / workspace-write / danger-full-access)
//   - --resume <id> for session continuation
//   - prompt passed on stdin (matches the spawn plumbing that already
//     pipes input to child.stdin)
//
// What's deliberately coarse:
//   - allowedTools is ignored on this provider. Codex has no per-tool
//     allowlist; the sandbox mode is the only knob. The mode argument
//     covers the practical cases (read vs. write vs. full).

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

// Codex sandbox vocabulary. The CLI flag is --sandbox-mode (or --sandbox in
// some builds); values are: read-only, workspace-write, danger-full-access.
function sandboxFor(mode: TaskMode): string {
  switch (mode) {
    case 'read-only':
      return 'read-only'
    case 'auto':
      return 'workspace-write'
    case 'full':
      return 'danger-full-access'
  }
}

function laneTimeoutMs(lane: RunTaskParams['lane']): number {
  return TIMEOUT_MS[lane]
}

function buildExecArgs(params: {
  mode: TaskMode
  addDirs?: string[]
  sessionId?: string
  includeSystemPrompt?: boolean
  prompt: string
}): string[] {
  const args: string[] = ['exec', '--json']

  args.push('--sandbox-mode', sandboxFor(params.mode))

  if (params.sessionId) {
    // Resume keeps the prior conversation; system prompt and add-dirs
    // were baked in on the original turn.
    args.push('--resume', params.sessionId)
  } else {
    for (const dir of params.addDirs ?? []) {
      args.push('--add-dir', resolve(process.cwd(), dir))
    }
    if (params.includeSystemPrompt) {
      // Codex doesn't have Claude's --append-system-prompt. The portable
      // approach is to inline the personality at the top of the prompt.
      // (An alternative is writing AGENTS.md into cwd; we don't do that
      // here because it'd mutate the repo.)
      params.prompt = `${systemPrompt()}\n\n---\n\n${params.prompt}`
    }
  }

  // Prompt as positional arg. `codex exec` reads stdin only with `-`, and
  // passing it positionally avoids ambiguity with the spawn pipe.
  args.push(params.prompt)
  return args
}

// Codex's --json emits NDJSON events. The exact event shape is version-
// dependent; this parser looks for the well-known event types and falls
// back to extracting any final assistant message.
type CodexEvent = {
  type?: string
  msg?: { type?: string; message?: string; content?: unknown }
  session_id?: string
  conversation_id?: string
  response_id?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cached_input_tokens?: number
  }
  [key: string]: unknown
}

function parseCodexOutput(stdout: string): RunTaskResult | null {
  const events: CodexEvent[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed) as CodexEvent)
    } catch {
      // Codex occasionally emits non-JSON preamble; skip it.
    }
  }
  if (events.length === 0) return null

  // Find the final agent message. Codex labels it variously across
  // versions — try the common shapes in order.
  let reply: string | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!
    if (
      ev.msg?.type === 'agent_message' &&
      typeof ev.msg.message === 'string'
    ) {
      reply = ev.msg.message
      break
    }
    if (typeof (ev as { message?: unknown }).message === 'string') {
      reply = (ev as { message: string }).message
      break
    }
    if (typeof (ev as { text?: unknown }).text === 'string') {
      reply = (ev as { text: string }).text
      break
    }
  }
  if (reply === null) return null

  // Session id — Codex uses different field names across versions.
  let sessionId: string | undefined
  for (const ev of events) {
    const id = ev.session_id ?? ev.conversation_id ?? ev.response_id
    if (typeof id === 'string' && id) {
      sessionId = id
      break
    }
  }

  // Usage — last event with a usage object wins (final turn totals).
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const u = events[i]!.usage
    if (u) {
      inputTokens = u.input_tokens ?? 0
      outputTokens = u.output_tokens ?? 0
      cacheReadTokens = u.cached_input_tokens ?? 0
      break
    }
  }

  return {
    reply: reply.trim(),
    sessionId,
    usage: {
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0,
      outputTokens,
      numTurns: 0,
    },
  }
}

async function runCodexTask(
  params: RunTaskParams,
): Promise<RunTaskResult> {
  const args = buildExecArgs({
    mode: params.mode,
    addDirs: params.addDirs,
    sessionId: params.sessionId,
    includeSystemPrompt: params.includeSystemPrompt,
    prompt: params.input,
  })

  logger.debug(
    { caller: params.caller, resume: !!params.sessionId },
    'spawning codex exec',
  )

  // input is empty here — the prompt rides in argv (Codex exec semantics).
  // Empty stdin end() is harmless.
  const { stdout, stderr, durationMs } = await runClaude({
    args,
    input: '',
    timeoutMs: laneTimeoutMs(params.lane),
    caller: params.caller as PromptLogEntry['caller'],
    bin: 'codex',
  })
  const startedAt = Date.now() - durationMs

  const parsed = parseCodexOutput(stdout)
  if (!parsed) {
    throw new Error(
      `codex produced no parseable result; stdout: ${stdout.slice(0, 500)}`,
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
}

async function askCodex(params: AskParams): Promise<AskResult> {
  const result = await runCodexTask({
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
    throw new Error('codex ask: response missing session id')
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

export const codexProvider: AiProvider = {
  name: 'codex',
  ask: askCodex,
  runTask: runCodexTask,
  reloadSystemPrompt,
}
