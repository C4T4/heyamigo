import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'path'
import {
  buildGrokIsolatedConfigToml,
  grokBrowserIsolationArgs,
  grokBrowserIsolationEnv,
  grokBrowserPermissionMode,
  tomlStdioServer,
  tomlString,
} from '../src/ai/grok-settings.js'

test('TOML strings JSON-escape quotes and spaces', () => {
  assert.equal(tomlString('node'), '"node"')
  assert.equal(tomlString('say "hi"'), '"say \\"hi\\""')
})

test('stdio MCP blocks pin command, args, and enabled', () => {
  assert.equal(
    tomlStdioServer('playwright', {
      command: '/usr/bin/node',
      args: ['dist/browser/task-mcp.js', '--cdp-endpoint', 'http://127.0.0.1:9222'],
    }),
    [
      '[mcp_servers.playwright]',
      'command = "/usr/bin/node"',
      'args = ["dist/browser/task-mcp.js", "--cdp-endpoint", "http://127.0.0.1:9222"]',
      'enabled = true',
      '',
    ].join('\n'),
  )
})

test('isolated Grok config exposes only the given MCP servers', () => {
  const playwright = {
    command: '/usr/bin/node',
    args: ['dist/browser/task-mcp.js', '--task-id', 'task-1'],
  }
  const toml = buildGrokIsolatedConfigToml({ playwright })
  assert.match(toml, /\[compat\.claude\]\nmcps = false/)
  assert.match(toml, /\[compat\.cursor\]\nmcps = false/)
  assert.match(toml, /\[plugins\]\npaths = \[\]/)
  assert.match(toml, /\[mcp_servers\.playwright\]/)
  assert.equal(toml.includes('[mcp_servers.amigospace]'), false)
})

test('Amigospace can sit beside the task-scoped browser MCP', () => {
  const server = {
    command: '/usr/bin/node',
    args: ['scripts/amigospace-mcp.mjs'],
  }
  const toml = buildGrokIsolatedConfigToml({
    playwright: server,
    amigospace: server,
  })
  assert.match(toml, /\[mcp_servers\.playwright\]/)
  assert.match(toml, /\[mcp_servers\.amigospace\]/)
})

test('browser isolation args pin cwd, leader socket, and web/subagents off', () => {
  const home = '/tmp/heyamigo-grok-browser-xyz'
  assert.deepEqual(grokBrowserIsolationArgs(home), [
    '--cwd',
    home,
    '--leader-socket',
    join(home, 'leader.sock'),
    '--no-subagents',
    '--disable-web-search',
  ])
})

test('browser jobs bypass Grok MCP permission prompts', () => {
  assert.equal(grokBrowserPermissionMode(), 'bypassPermissions')
})

test('browser isolation env relocates GROK_HOME and disables compat MCP scans', () => {
  const home = '/tmp/heyamigo-grok-browser-xyz'
  assert.deepEqual(grokBrowserIsolationEnv(home), {
    GROK_HOME: home,
    GROK_CLAUDE_MCPS_ENABLED: '0',
    GROK_CURSOR_MCPS_ENABLED: '0',
    GROK_FOLDER_TRUST: '0',
  })
})
