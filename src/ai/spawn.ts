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
  durationMs: number
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

      resolvePromise({ stdout, durationMs })
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
