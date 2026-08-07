// Google Gemini CLI provider. Uses the installed CLI in --yolo mode with
// non-interactive JSON output and provider-native resumable sessions. Browser
// jobs add only heyamigo's task-scoped Playwright MCP.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { browserTaskMcpSpec } from '../browser/task-mcp-command.js'
import { config } from '../config.js'
import { dbPath } from '../db/index.js'
import { logger } from '../logger.js'
import { logPrompt, type PromptLogEntry } from '../promptlog.js'
import { parseGeminiOutput } from './gemini-output.js'
import { buildGeminiSystemSettings } from './gemini-settings.js'
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

function laneTimeoutMs(lane: RunTaskParams['lane']): number {
  return TIMEOUT_MS[lane]
}

const TOOL_TRANSLATIONS: Record<string, string[]> = {
  Read: ['read_file', 'list_directory', 'glob', 'search_file_content'],
  Grep: ['search_file_content'],
  Glob: ['glob'],
  Edit: ['replace'],
  Write: ['write_file'],
  Bash: ['run_shell_command'],
  WebFetch: ['web_fetch'],
  WebSearch: ['google_web_search'],
}

const READ_ONLY_CORE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'glob',
  'search_file_content',
  'web_fetch',
  'google_web_search',
])

function coreToolsFor(
  allowed: RunTaskParams['allowedTools'],
  mode: TaskMode,
): string[] | undefined {
  if ((!allowed || allowed === 'all') && mode !== 'read-only') return undefined
  if ((!allowed || allowed === 'all') && mode === 'read-only') {
    return [...READ_ONLY_CORE_TOOLS]
  }
  const translated = new Set<string>()
  for (const tool of allowed as string[]) {
    const mapped = TOOL_TRANSLATIONS[tool]
    if (mapped) mapped.forEach((name) => translated.add(name))
  }
  return [...translated].filter(
    (name) => mode !== 'read-only' || READ_ONLY_CORE_TOOLS.has(name),
  )
}

type RuntimeSettings = {
  dir: string
  path: string
  allowedMcpServer: string
}

function createRuntimeSettings(
  params: RunTaskParams,
): RuntimeSettings | null {
  const browser = !!params.browserCdpUrl
  const selectedCoreTools = browser
    ? []
    : coreToolsFor(params.allowedTools, params.mode)
  // The owner's normal unrestricted lane is deliberately just the installed
  // Gemini CLI. A temp settings file is needed only for role tool limits or
  // the task-scoped browser MCP.
  if (!browser && selectedCoreTools === undefined) return null

  const dir = mkdtempSync(join(tmpdir(), 'heyamigo-gemini-'))
  try {
    const path = join(dir, 'system-settings.json')
    let playwright: { command: string; args: string[]; trust: true } | undefined

    if (browser) {
      if (!params.browserTaskId) {
        throw new Error('browserTaskId is required for task-scoped browser MCP')
      }
      const mcp = browserTaskMcpSpec({
        cdpEndpoint: params.browserCdpUrl!,
        taskId: params.browserTaskId,
        databasePath: dbPath(),
      })
      playwright = {
        command: mcp.command,
        args: mcp.args,
        trust: true,
      }
    }

    const settings = buildGeminiSystemSettings({
      coreTools: selectedCoreTools,
      playwright,
    })
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
    return {
      dir,
      path,
      // An empty allowlist entry intentionally matches no ambient MCP name.
      allowedMcpServer: browser ? 'playwright' : '',
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

function buildArgs(params: RunTaskParams, runtime: RuntimeSettings | null): {
  args: string[]
  prompt: string
} {
  let prompt = params.input
  const args = [
    '--yolo',
    '--output-format', 'json',
  ]
  if (runtime) {
    args.push(
      '--allowed-mcp-server-names', runtime.allowedMcpServer,
      '--extensions', 'none',
    )
  }

  if (config.gemini.model) args.push('--model', config.gemini.model)
  if (params.sessionId) args.push('--resume', params.sessionId)
  else if (params.includeSystemPrompt) {
    prompt = `${systemPrompt()}\n\n---\n\n${prompt}`
  }

  const directories = [...new Set((params.addDirs ?? []).map((dir) =>
    resolve(process.cwd(), dir),
  ))]
  if (directories.length > 5) {
    throw new Error(
      `Gemini CLI supports at most 5 include directories; received ${directories.length}`,
    )
  }
  for (const dir of directories) args.push('--include-directories', dir)
  for (const extra of config.gemini.extraArgs) args.push(extra)

  // An explicit empty -p value enters non-interactive mode while the actual
  // prompt travels over stdin, avoiding argv length limits.
  args.push('--prompt', '')
  return { args, prompt }
}

async function runGeminiTask(params: RunTaskParams): Promise<RunTaskResult> {
  const runtime = createRuntimeSettings(params)
  let args: string[] = []
  let prompt = params.input
  try {
    const built = buildArgs(params, runtime)
    args = built.args
    prompt = built.prompt

    logger.info(
      {
        caller: params.caller,
        resume: !!params.sessionId,
        argv: args,
        promptChars: prompt.length,
      },
      'spawning gemini',
    )

    const { stdout, stderr, durationMs } = await runClaude({
      args,
      input: prompt,
      timeoutMs: laneTimeoutMs(params.lane),
      caller: params.caller as PromptLogEntry['caller'],
      bin: config.gemini.bin,
      env: {
        ...(runtime
          ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: runtime.path }
          : {}),
        NO_COLOR: '1',
      },
    })
    const startedAt = Date.now() - durationMs
    const parsed = parseGeminiOutput(stdout)
    if (!parsed) {
      throw new Error(
        `gemini produced no parseable result; stdout: ${stdout.slice(0, 500)}`,
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
    if (runtime) rmSync(runtime.dir, { recursive: true, force: true })
  }
}

async function askGemini(params: AskParams): Promise<AskResult> {
  const result = await runGeminiTask({
    input: params.input,
    caller: 'worker',
    mode: 'auto',
    lane: 'main',
    sessionId: params.sessionId,
    includeSystemPrompt: true,
    allowedTools: params.allowedTools,
    addDirs: [config.memory.dir, config.storage.mediaDir],
  })
  if (!result.sessionId) {
    throw new Error('gemini ask: response missing session id')
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

export const geminiProvider: AiProvider = {
  name: 'gemini',
  model: config.gemini.model ?? 'gemini-auto',
  contextWindow: config.gemini.contextWindow,
  usageReportingMode: 'per-turn',
  ask: askGemini,
  runTask: runGeminiTask,
  reloadSystemPrompt,
}
