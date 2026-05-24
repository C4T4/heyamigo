import { config } from '../config.js'
import { claudeProvider } from './claude.js'
import { codexProvider } from './codex.js'
import type { AiProvider, ProviderName } from './provider.js'

const REGISTRY: Record<ProviderName, AiProvider> = {
  claude: claudeProvider,
  codex: codexProvider,
}

// Resolve the active provider. Defaults to claude if no override is set in
// config; pass an explicit name to force one (useful for per-role routing
// once access.json learns about it).
export function getProvider(name?: ProviderName): AiProvider {
  const resolved = name ?? config.ai.provider
  return REGISTRY[resolved]
}

export function reloadAllSystemPrompts(): void {
  for (const p of Object.values(REGISTRY)) p.reloadSystemPrompt()
}
