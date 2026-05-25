// Provider abstraction for the user-facing chat ask path. Lets the worker
// route conversation turns to Claude, Codex, Grok, or any future CLI
// without knowing the wire details.
//
// Scope: covers the interactive worker call and general provider-backed agent
// tasks (memory digests, async/background work, browser tasks). A few legacy
// utilities may still call a specific CLI directly, but runtime work should
// flow through this interface.

export type AskParams = {
  input: string
  // Provider-native session id from a prior turn, if resuming. Each provider
  // owns the format; the caller treats it as opaque.
  sessionId?: string
  // Tool gating. 'all' means no restriction. The list is in Claude's tool
  // namespace (e.g. 'Read,Edit,Bash'); providers that lack per-tool gating
  // (Codex) translate this into their coarser equivalent (sandbox mode).
  allowedTools?: string[] | 'all'
}

export type AskUsage = {
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
  numTurns: number
}

export type AskResult = {
  reply: string
  sessionId: string
  usage: AskUsage
}

export type ProviderName = 'claude' | 'codex' | 'grok'

// Sandbox/permission tier. Providers map this onto their native permission
// vocabulary.
export type TaskMode = 'read-only' | 'auto' | 'full'

// Timeout bucket — providers pick the actual milliseconds from spawn.ts's
// TIMEOUT_MS map.
export type TaskLane = 'main' | 'async' | 'background'

// Caller label written into the promptlog. Kept loose so the existing log
// shape (PromptLogEntry['caller']) stays the source of truth.
export type TaskCaller = string

export type RunTaskParams = {
  input: string
  caller: TaskCaller
  mode: TaskMode
  lane: TaskLane
  // Additional directories the agent can read/write. Providers that expose
  // explicit extra roots map this to their native flag.
  addDirs?: string[]
  // Resume an existing session (browser worker uses this to keep one
  // long-lived agent). Opaque provider-native id.
  sessionId?: string
  // Inject the personality + memory-instructions text. Off by default —
  // headless background jobs (digest, observer, nudger, compressed) carry
  // all framing inside their prompt and don't need it. The async/browser
  // workers turn this on so their replies sound like the main chat.
  includeSystemPrompt?: boolean
  // Per-tool allowlist. Providers translate this where their CLI has a matching
  // permission surface. Pass undefined or 'all' for no restriction.
  allowedTools?: string[] | 'all'
}

export type RunTaskResult = {
  reply: string
  // Returned only when the provider produced a session id (e.g. a fresh
  // session was created or an existing one rotated). One-shot calls that
  // don't track session leave this undefined.
  sessionId?: string
  usage?: AskUsage
}

// How the provider's CLI reports usage counts in its result payload.
//   'per-turn'   — counts represent this one API call (Claude CLI).
//   'cumulative' — counts represent the entire resume thread to date
//                  (Codex CLI).
// Worker uses this to compute per-turn deltas for display so the
// context % stays correct after many turns.
export type UsageReportingMode = 'per-turn' | 'cumulative'

export interface AiProvider {
  readonly name: ProviderName
  readonly usageReportingMode: UsageReportingMode
  readonly contextWindow: number
  // Conversational chat turn — opinionated defaults (always system prompt,
  // memory + media dirs auto-included, session id tracked).
  ask(params: AskParams): Promise<AskResult>
  // General-purpose agentic run — caller specifies mode, lane, dirs,
  // whether to inject the system prompt, etc. Background memory pipelines
  // and the async task lanes go through here.
  runTask(params: RunTaskParams): Promise<RunTaskResult>
  // Drop any cached system-prompt state so the next ask()/runTask() with
  // includeSystemPrompt re-reads from disk. Wired to the /reload command.
  reloadSystemPrompt(): void
}
