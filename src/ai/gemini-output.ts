import type { AskUsage, RunTaskResult } from './provider.js'

type GeminiModelStats = {
  tokens?: {
    input?: number
    prompt?: number
    candidates?: number
    cached?: number
  }
}

type GeminiStats = {
  models?: Record<string, GeminiModelStats>
}

type GeminiJsonOutput = {
  response?: unknown
  session_id?: unknown
  stats?: GeminiStats
  error?: { type?: unknown; message?: unknown; code?: unknown }
}

type GeminiStreamEvent = {
  type?: unknown
  role?: unknown
  content?: unknown
  delta?: unknown
  session_id?: unknown
  status?: unknown
  stats?: {
    input_tokens?: number
    output_tokens?: number
    cached?: number
  }
  error?: { type?: unknown; message?: unknown; code?: unknown }
}

function usageFromStats(stats?: GeminiStats): AskUsage {
  let inputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  for (const model of Object.values(stats?.models ?? {})) {
    const tokens = model.tokens
    // Gemini exposes prompt = uncached input + cached input. Use the split
    // fields so heyamigo's context accounting does not count cache twice.
    inputTokens += tokens?.input ?? Math.max(
      0,
      (tokens?.prompt ?? 0) - (tokens?.cached ?? 0),
    )
    cacheReadTokens += tokens?.cached ?? 0
    outputTokens += tokens?.candidates ?? 0
  }
  return {
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    outputTokens,
    numTurns: 0,
  }
}

function errorMessage(error: GeminiJsonOutput['error']): string {
  if (!error) return 'unknown error'
  const type = typeof error.type === 'string' ? error.type : 'GeminiError'
  const message = typeof error.message === 'string' ? error.message : 'unknown error'
  const code = typeof error.code === 'string' || typeof error.code === 'number'
    ? ` (${error.code})`
    : ''
  return `${type}${code}: ${message}`
}

function parseJsonObject(stdout: string): GeminiJsonOutput | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as GeminiJsonOutput
  } catch {
    const first = trimmed.indexOf('{')
    const last = trimmed.lastIndexOf('}')
    if (first < 0 || last <= first) return null
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as GeminiJsonOutput
    } catch {
      return null
    }
  }
}

function parseStreamJson(stdout: string): RunTaskResult | null {
  let sessionId: string | undefined
  let reply = ''
  let usage: AskUsage | undefined
  let completed = false
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: GeminiStreamEvent
    try {
      event = JSON.parse(trimmed) as GeminiStreamEvent
    } catch {
      continue
    }
    if (event.type === 'init' && typeof event.session_id === 'string') {
      sessionId = event.session_id
    } else if (
      event.type === 'message' &&
      event.role === 'assistant' &&
      typeof event.content === 'string'
    ) {
      reply = event.delta === true ? reply + event.content : event.content
    } else if (event.type === 'result') {
      if (event.status === 'error') {
        throw new Error(`gemini returned error: ${errorMessage(event.error)}`)
      }
      completed = true
      usage = {
        inputTokens: Math.max(
          0,
          (event.stats?.input_tokens ?? 0) - (event.stats?.cached ?? 0),
        ),
        cacheReadTokens: event.stats?.cached ?? 0,
        cacheCreationTokens: 0,
        outputTokens: event.stats?.output_tokens ?? 0,
        numTurns: 0,
      }
    }
  }
  if (!completed) return null
  return { reply: reply.trim(), sessionId, usage }
}

export function parseGeminiOutput(stdout: string): RunTaskResult | null {
  const raw = parseJsonObject(stdout)
  if (!raw) return parseStreamJson(stdout)
  if (raw.error) {
    throw new Error(`gemini returned error: ${errorMessage(raw.error)}`)
  }
  if (typeof raw.response !== 'string') return null
  return {
    reply: raw.response.trim(),
    sessionId: typeof raw.session_id === 'string' ? raw.session_id : undefined,
    usage: usageFromStats(raw.stats),
  }
}
