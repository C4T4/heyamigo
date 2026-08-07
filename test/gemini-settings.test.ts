import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildGeminiSystemSettings,
  geminiIsolationArgs,
} from '../src/ai/gemini-settings.js'

test('restricted Gemini tasks limit core tools', () => {
  assert.deepEqual(buildGeminiSystemSettings({
    coreTools: ['read_file'],
  }), {
    tools: { core: ['read_file'] },
    admin: { mcp: { enabled: false } },
  })
})

test('browser Gemini tasks expose only Playwright and no core tools', () => {
  const playwright = {
    command: '/usr/bin/node',
    args: ['dist/browser/task-mcp.js', '--task-id', 'task-1'],
    trust: true as const,
  }
  const settings = buildGeminiSystemSettings({
    coreTools: [],
    playwright,
  })

  assert.deepEqual(settings.mcpServers, { playwright })
  assert.deepEqual((settings.tools as Record<string, unknown>).core, [])
  assert.equal('admin' in settings, false)
})

test('normal restricted tasks never emit an empty MCP allowlist', () => {
  assert.deepEqual(geminiIsolationArgs(), ['--extensions', 'none'])
  assert.deepEqual(geminiIsolationArgs('playwright'), [
    '--extensions',
    'none',
    '--allowed-mcp-server-names',
    'playwright',
  ])
})
