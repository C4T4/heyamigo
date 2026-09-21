import { join } from 'path'

export type GrokMcpServer = {
  command: string
  args: string[]
}

export function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function tomlStdioServer(name: string, spec: GrokMcpServer): string {
  return [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(', ')}]`,
    'enabled = true',
    '',
  ].join('\n')
}

// User-level Grok config for one browser job. Compat MCP sources stay off so
// Claude/Cursor playwright entries cannot replace the task-scoped server.
export function buildGrokIsolatedConfigToml(
  mcpServers: Record<string, GrokMcpServer>,
): string {
  const blocks = [
    '[compat.claude]',
    'mcps = false',
    '',
    '[compat.cursor]',
    'mcps = false',
    '',
    '[plugins]',
    'paths = []',
    '',
  ]
  for (const [name, spec] of Object.entries(mcpServers)) {
    blocks.push(tomlStdioServer(name, spec))
  }
  return blocks.join('\n')
}

export function grokBrowserIsolationArgs(home: string): string[] {
  return [
    '--cwd',
    home,
    '--leader-socket',
    join(home, 'leader.sock'),
    '--no-subagents',
    '--disable-web-search',
  ]
}

// Codex used --yolo. Grok --always-approve still prompts for MCP use_tool
// under acceptEdits and cancels the first call immediately (chat and browser).
export function grokBrowserPermissionMode(): 'bypassPermissions' {
  return 'bypassPermissions'
}

export function grokBrowserIsolationEnv(home: string): NodeJS.ProcessEnv {
  return {
    GROK_HOME: home,
    GROK_CLAUDE_MCPS_ENABLED: '0',
    GROK_CURSOR_MCPS_ENABLED: '0',
    // Isolated cwd has no project MCP files; disabling the trust gate avoids
    // a headless hang on an untrusted temp directory.
    GROK_FOLDER_TRUST: '0',
  }
}
