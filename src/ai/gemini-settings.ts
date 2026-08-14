export type GeminiMcpServer = {
  command: string
  args: string[]
  trust: true
}

export function geminiIsolationArgs(allowedMcpServers: string[] = []): string[] {
  return [
    '--extensions',
    'none',
    ...allowedMcpServers.flatMap((name) => [
      '--allowed-mcp-server-names',
      name,
    ]),
  ]
}

export function buildGeminiSystemSettings(params: {
  coreTools?: string[]
  mcpServers?: Record<string, GeminiMcpServer>
}): Record<string, unknown> {
  const hasMcpServers =
    params.mcpServers !== undefined &&
    Object.keys(params.mcpServers).length > 0
  return {
    ...(params.coreTools !== undefined
      ? { tools: { core: params.coreTools } }
      : {}),
    ...(hasMcpServers
      ? { mcpServers: params.mcpServers }
      : { admin: { mcp: { enabled: false } } }),
  }
}
