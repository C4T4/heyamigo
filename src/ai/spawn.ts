import { spawn, type ChildProcess } from 'child_process'
import { logger } from '../logger.js'
import { logPrompt, type PromptLogEntry } from '../promptlog.js'

export class ClaudeTimeoutError extends Error {
  constructor(
    public readonly caller: PromptLogEntry['caller'],
    public readonly durationMs: number,
    public readonly timeoutMs: number,
  ) {
    super(
      `${caller} timed out after ${Math.round(
        durationMs / 1000,
      )}s (cap ${Math.round(timeoutMs / 1000)}s)`,
    )
    this.name = 'ClaudeTimeoutError'
  }
}

export class ClaudeSpawnError extends Error {
  constructor(
    public readonly caller: PromptLogEntry['caller'],
    message: string,
  ) {
    super(message)
    this.name = 'ClaudeSpawnError'
  }
}

export type RunClaudeOpts = {
  args: string[]
  input: string
  timeoutMs: number
  caller: PromptLogEntry['caller']
  cwd?: string
}

export type RunClaudeResult = {
  stdout: string
  stderr: string
  durationMs: number
}

// One NDJSON event from Claude CLI's stream-json output.
export type StreamJsonEvent = {
  type?: string
  subtype?: string
  [key: string]: unknown
}

export type ParsedStreamJson = {
  result: string
  sessionId: string | null
  usage?: {
    input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    output_tokens?: number
  }
  isError: boolean
  subtype?: string
  numTurns?: number
  eventTypes: string[]
  events: StreamJsonEvent[]
}

// Parse Claude CLI's --output-format stream-json output. Each line is a JSON
// event; the final event with type === 'result' carries the completion
// summary (same shape as the old single-json output format). Returns null if
// no result event is found — caller should treat that as an error.
export function parseStreamJson(stdout: string): ParsedStreamJson | null {
  const events: StreamJsonEvent[] = []
  const eventTypes: string[] = []
  const lines = stdout.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as StreamJsonEvent
      events.push(parsed)
      if (typeof parsed.type === 'string') eventTypes.push(parsed.type)
    } catch {
      // Ignore malformed lines — Claude CLI occasionally emits preamble or
      // debug lines that aren't JSON; the structured events we need are
      // always well-formed.
    }
  }

  // Find the final result event. Walk from end to handle any stray events
  // after 'result' (shouldn't happen but be defensive).
  let resultEvent: StreamJsonEvent | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'result') {
      resultEvent = events[i]!
      break
    }
  }
  if (!resultEvent) return null

  return {
    result: typeof resultEvent.result === 'string' ? resultEvent.result : '',
    sessionId:
      typeof resultEvent.session_id === 'string'
        ? resultEvent.session_id
        : null,
    usage:
      resultEvent.usage && typeof resultEvent.usage === 'object'
        ? (resultEvent.usage as ParsedStreamJson['usage'])
        : undefined,
    isError: !!resultEvent.is_error,
    subtype:
      typeof resultEvent.subtype === 'string'
        ? resultEvent.subtype
        : undefined,
    numTurns:
      typeof resultEvent.num_turns === 'number'
        ? resultEvent.num_turns
        : undefined,
    eventTypes,
    events,
  }
}

// Kill the process group of a detached child. Playwright MCP and any Chromium
// children sit under the claude subprocess; without process-group kill they
// linger after we SIGTERM the parent and accumulate on the host.
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    // Negative PID = target the whole process group (see kill(2)).
    process.kill(-child.pid, signal)
  } catch (err) {
    // Fallback: signal just the parent. Better than nothing.
    try {
      child.kill(signal)
    } catch {
      logger.warn({ err, pid: child.pid }, 'failed to kill claude subprocess')
    }
  }
}

// Run a `claude -p ...` subprocess with a hard timeout, full-tree kill on
// expiry, and uniform promptlog handling. All claude spawns in the codebase
// should go through this.
export async function runClaude(
  opts: RunClaudeOpts,
): Promise<RunClaudeResult> {
  const { args, input, timeoutMs, caller } = opts
  const startedAt = Date.now()

  return new Promise<RunClaudeResult>((resolvePromise, rejectPromise) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd ?? process.cwd(),
      // detached:true puts the child in its own process group, so killGroup
      // can SIGTERM the whole tree (Playwright MCP, Chromium, etc.) at once.
      detached: true,
      // ANTHROPIC_LOG=debug surfaces the SDK's HTTP layer to stderr:
      // request URLs, status codes, retries, rate-limit notices. We
      // capture stderr and put a truncated copy into the promptlog so
      // we can diagnose API hangs/rate-limits post-mortem instead of
      // staring at "Claude subprocess is idle, why?".
      env: {
        ...process.env,
        ANTHROPIC_LOG: process.env.ANTHROPIC_LOG ?? 'debug',
      },
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const logFail = (error: string) =>
      void logPrompt({
        ts: Math.floor(startedAt / 1000),
        caller,
        args,
        input,
        error,
        durationMs: Date.now() - startedAt,
      })

    const timer = setTimeout(() => {
      timedOut = true
      logger.warn(
        { caller, pid: child.pid, timeoutMs },
        'claude subprocess timed out, killing process group',
      )
      killGroup(child, 'SIGTERM')
      // Grace window, then SIGKILL if still alive.
      setTimeout(() => {
        if (!settled) killGroup(child, 'SIGKILL')
      }, 2000).unref()
    }, timeoutMs)
    timer.unref()

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      logFail(`spawn failed: ${err.message}`)
      rejectPromise(
        new ClaudeSpawnError(caller, `claude spawn failed: ${err.message}`),
      )
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const durationMs = Date.now() - startedAt

      if (timedOut) {
        logFail(
          `timeout after ${durationMs}ms (cap ${timeoutMs}ms); signal=${signal}`,
        )
        return rejectPromise(
          new ClaudeTimeoutError(caller, durationMs, timeoutMs),
        )
      }

      if (code !== 0) {
        logFail(`exit ${code}: ${stderr.slice(0, 500)}`)
        return rejectPromise(
          new ClaudeSpawnError(
            caller,
            `claude exited with code ${code}: ${stderr.slice(0, 500)}`,
          ),
        )
      }

      resolvePromise({ stdout, stderr, durationMs })
    })

    child.stdin.write(input)
    child.stdin.end()
  })
}

// Per-lane defaults. Individual callers can override, but these are the
// shipped caps. Browser-heavy work lives in the async lane.
export const TIMEOUT_MS = {
  main: 5 * 60 * 1000,
  async: 15 * 60 * 1000,
  background: 3 * 60 * 1000,
} as const
