export type GeminiMcpServer = {
  command: string
  args: string[]
  trust: true
}

export function buildGeminiSystemSettings(params: {
  coreTools?: string[]
  playwright?: GeminiMcpServer
}): Record<string, unknown> {
  return {
    ...(params.coreTools !== undefined
      ? { tools: { core: params.coreTools } }
      : {}),
    ...(params.playwright
      ? { mcpServers: { playwright: params.playwright } }
      : {}),
  }
}
