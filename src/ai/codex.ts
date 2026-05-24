// Codex CLI provider. Maps the neutral AiProvider contract onto
// `codex exec --json`. Flag names match the public CLI docs as of writing
// (developers.openai.com/codex/cli/features); if your local Codex version
// uses different flags, the small surface here is the only place to adjust.
//
// What's wired:
//   - exec mode with --json (NDJSON event stream on stdout)
//   - --add-dir for extra writable roots
//   - --sandbox for tier (read-only / workspace-write / danger-full-access)
//   - `resume <id>` subcommand for session continuation (not a flag)
//   - prompt passed as positional arg
//
// Configurable via config.codex:
//   - model: optional `-m <model>` override. Default = Codex's default.
//   - yolo (default true): emits --yolo, which bundles no-approvals +
//     full sandbox + skip-trust-check. The narrower verbose flag
//     (--dangerously-bypass-approvals-and-sandbox) does NOT skip the
//     trust check on all versions and can hang the process — use --yolo.
//     Set false to honor runTask's mode-driven sandbox.
//   - skipGitRepoCheck (default true): adds --skip-git-repo-check when
//     yolo is off. Codex refuses to run in untrusted cwds without it.
//   - extraArgs: appended verbatim. Escape hatch for version drift.
//
// What's deliberately coarse:
//   - allowedTools is ignored on this provider. Codex has no per-tool
//     allowlist; the sandbox mode is the only knob.

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

// Codex sandbox vocabulary. CLI flag is --sandbox; values are: read-only,
// workspace-write, danger-full-access.
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

// Returns { args, prompt }. The prompt is the final text that should be
// piped to stdin (system prompt prepended when applicable). args ends with
// `-` so codex reads from stdin.
function buildExecArgs(params: {
  mode: TaskMode
  addDirs?: string[]
  sessionId?: string
  includeSystemPrompt?: boolean
  prompt: string
}): { args: string[]; prompt: string } {
  const cfg = config.codex
  const args: string[] = ['exec', '--json']

  if (cfg.model) {
    args.push('-m', cfg.model)
  }

  if (cfg.yolo) {
    // --yolo bundles all three bypasses: no approvals, full sandbox,
    // and skip-trust-check. Empirically the right switch — the more
    // narrowly-scoped --dangerously-bypass-approvals-and-sandbox does
    // NOT subsume the trust-directory gate on some Codex versions and
    // causes the process to hang waiting for stdin.
    args.push('--yolo')
  } else {
    if (cfg.skipGitRepoCheck) args.push('--skip-git-repo-check')
    args.push('--sandbox', sandboxFor(params.mode))
  }

  for (const extra of cfg.extraArgs) args.push(extra)

  if (params.sessionId) {
    // Resume is a subcommand of exec, not a flag: `codex exec [opts] resume
    // <SESSION_ID> [prompt]`. System prompt and add-dirs were baked in on
    // the original turn so we don't re-pass them here.
    args.push('resume', params.sessionId)
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

  // Pass prompt via stdin (positional `-` is the documented way). Large
  // prompts — system prompt + memory preamble + history — can blow past
  // Linux's ARG_MAX when shoved into argv, causing the spawn to hang
  // silently. stdin has no such cap.
  args.push('-')
  return { args, prompt: params.prompt }
}

// Codex's --json emits NDJSON events. The shapes we care about (confirmed
// against the running CLI):
//   {"type":"thread.started","thread_id":"<id>"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"type":"agent_message","text":"<reply>"}}
//   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,
//       "output_tokens":N,"reasoning_output_tokens":N}}
// Older/newer Codex versions may rename things; fallbacks are tried after the
// primary shape so the parser degrades to "best effort" rather than null.
type CodexEvent = {
  type?: string
  thread_id?: string
  // Older fallbacks
  session_id?: string
  conversation_id?: string
  response_id?: string
  item?: {
    type?: string
    text?: string
    message?: string
  }
  msg?: { type?: string; message?: string; content?: unknown }
  message?: unknown
  text?: unknown
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cached_input_tokens?: number
    reasoning_output_tokens?: number
  }
  [key: string]: unknown
}

function extractReply(ev: CodexEvent): string | null {
  // Primary shape: item.completed with item.type === 'agent_message'
  if (
    ev.type === 'item.completed' &&
    ev.item &&
    ev.item.type === 'agent_message' &&
    typeof ev.item.text === 'string'
  ) {
    return ev.item.text
  }
  // Older shape: msg.type === 'agent_message' with msg.message
  if (
    ev.msg &&
    ev.msg.type === 'agent_message' &&
    typeof ev.msg.message === 'string'
  ) {
    return ev.msg.message
  }
  // Last-ditch top-level fields
  if (typeof ev.message === 'string') return ev.message
  if (typeof ev.text === 'string') return ev.text
  return null
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

  // Latest agent message wins (handles multi-turn output).
  let reply: string | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const r = extractReply(events[i]!)
    if (r !== null) {
      reply = r
      break
    }
  }
  if (reply === null) return null

  // Session id — `thread_id` on thread.started in current Codex; older
  // builds used session_id / conversation_id / response_id.
  let sessionId: string | undefined
  for (const ev of events) {
    const id = ev.thread_id ?? ev.session_id ?? ev.conversation_id ?? ev.response_id
    if (typeof id === 'string' && id) {
      sessionId = id
      break
    }
  }

  // Usage — turn.completed carries final totals; fall back to any event
  // with a usage object if the type marker is missing.
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
  const { args, prompt } = buildExecArgs({
    mode: params.mode,
    addDirs: params.addDirs,
    sessionId: params.sessionId,
    includeSystemPrompt: params.includeSystemPrompt,
    prompt: params.input,
  })

  logger.info(
    {
      caller: params.caller,
      resume: !!params.sessionId,
      argv: args,
      promptChars: prompt.length,
    },
    'spawning codex exec',
  )

  const { stdout, stderr, durationMs } = await runClaude({
    args,
    input: prompt,
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
