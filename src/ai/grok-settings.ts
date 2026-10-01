import { join } from 'path'

export type GrokStdioMcpServer = {
  command: string
  args: string[]
}

export type GrokHttpMcpServer = {
  url: string
  headers?: Record<string, string>
}

export type GrokMcpServer = GrokStdioMcpServer | GrokHttpMcpServer

export function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function tomlStdioServer(name: string, spec: GrokStdioMcpServer): string {
  return [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(', ')}]`,
    'enabled = true',
    '',
  ].join('\n')
}

export function tomlHttpServer(name: string, spec: GrokHttpMcpServer): string {
  const lines = [
    `[mcp_servers.${name}]`,
    `url = ${tomlString(spec.url)}`,
    'enabled = true',
    '',
  ]
  const headers = spec.headers ?? {}
  const keys = Object.keys(headers)
  if (keys.length) {
    lines.push(`[mcp_servers.${name}.headers]`)
    for (const key of keys) {
      lines.push(`${key} = ${tomlString(String(headers[key]))}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// User-level Grok config for one browser job. Compat MCP sources stay off so
// Claude/Cursor playwright entries cannot replace the task-scoped server.
// HTTP servers from the shared registry are safe to pin in: they are not Playwright.
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
    if ('url' in spec && spec.url) {
      blocks.push(tomlHttpServer(name, spec))
    } else if ('command' in spec) {
      blocks.push(tomlStdioServer(name, spec))
    } else {
      throw new Error(`mcp server ${name} needs a url or a command`)
    }
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
