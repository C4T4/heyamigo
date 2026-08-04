#!/usr/bin/env node

import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { chromium, type Browser } from 'playwright-core'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskScopedBrowserContext, renderTabCandidates } from './scoped-context.js'
import { BrowserTabLeaseStore } from './tab-leases.js'

const VERSION = '1.0.0'
const HEARTBEAT_INTERVAL_MS = 30_000
// This upstream tool receives a real Playwright Page object and can call
// page.context().pages(), bypassing the filtered BrowserContext proxy. Keep
// the structured Playwright tools, but fail closed on the RCE-equivalent
// escape hatch.
const BLOCKED_UPSTREAM_TOOLS = new Set([
  'browser_run_code_unsafe',
  // The task process owns the MCP lifecycle. Closing the upstream backend
  // early strands the outer proxy; browser_tabs close is the scoped tab API.
  'browser_close',
  // A headed persistent context has one real VNC window. Resizing it from one
  // task is a browser-wide side effect that can disrupt every other worker.
  'browser_resize',
])

type TaskMcpArgs = {
  cdpEndpoint: string
  taskId: string
  databasePath: string
}

const candidateTool: Tool = {
  name: 'browser_tab_candidates',
  title: 'List claimable Chrome tabs',
  description:
    'List stable IDs, titles, URLs, and ownership status for existing tabs in the canonical VNC Chrome. Use only when the task explicitly requires an already-open user tab. Page content remains inaccessible until claimed.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
}

const claimTool: Tool = {
  name: 'browser_tab_claim',
  title: 'Claim an existing Chrome tab',
  description:
    'Claim one available existing Chrome tab by its stable tabId. The claimed tab is added to this task’s private browser_tabs list and remains inaccessible to other browser workers until the task ends.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Stable tab ID returned by browser_tab_candidates',
      },
    },
    required: ['tabId'],
    additionalProperties: false,
  },
}

function parseArgs(argv: string[]): TaskMcpArgs {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key?.startsWith('--')) continue
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}`)
    }
    values.set(key, value)
    i++
  }

  const cdpEndpoint = values.get('--cdp-endpoint')
  const taskId = values.get('--task-id')
  const databasePath = values.get('--db-path')
  if (!cdpEndpoint || !taskId || !databasePath) {
    throw new Error(
      'Usage: task-mcp --cdp-endpoint <url> --task-id <id> --db-path <path>',
    )
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(taskId)) {
    throw new Error(`Invalid browser task ID: ${taskId}`)
  }

  const endpoint = new URL(cdpEndpoint)
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error(`Refusing non-local browser CDP endpoint: ${cdpEndpoint}`)
  }
  return { cdpEndpoint, taskId, databasePath }
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    isError,
  }
}

async function connectCanonicalContext(cdpEndpoint: string): Promise<{
  browser: Browser
  context: ReturnType<Browser['contexts']>[number]
}> {
  const browser = await chromium.connectOverCDP(cdpEndpoint)
  const contexts = browser.contexts()
  if (contexts.length !== 1 || !contexts[0]) {
    throw new Error(
      `Expected exactly one canonical Chrome context at ${cdpEndpoint}; found ${contexts.length}.`,
    )
  }
  return { browser, context: contexts[0] }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const leases = BrowserTabLeaseStore.open(args.databasePath)
  const { context } = await connectCanonicalContext(args.cdpEndpoint)
  const scoped = new TaskScopedBrowserContext(context, leases, args.taskId)
  await scoped.initialize()

  // Reuse the upstream structured Playwright MCP tools. Its BrowserContext is
  // replaced with our task-filtered proxy; the one raw-Page escape hatch is
  // removed from the outer tool list below.
  const innerServer = await createConnection(
    {
      browser: { browserName: 'chromium' },
      imageResponses: 'allow',
      // Upstream snapshots and screenshots are task artifacts. Keep them out
      // of the service checkout so browser work never dirties the worktree.
      outputDir: join(tmpdir(), 'heyamigo-playwright-mcp', args.taskId),
      outputMaxSize: 100 * 1024 * 1024,
      snapshot: { mode: 'full' },
    },
    async () => scoped.asBrowserContext(),
  )
  const innerClient = new Client(
    { name: 'heyamigo-tab-broker', version: VERSION },
    { capabilities: {} },
  )
  const [innerServerTransport, innerClientTransport] = InMemoryTransport.createLinkedPair()
  await innerServer.connect(innerServerTransport)
  await innerClient.connect(innerClientTransport)

  const outerServer = new Server(
    { name: 'heyamigo-task-browser', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'All Playwright tabs are code-enforced leases owned by this browser task. Use browser_tab_candidates and browser_tab_claim only when the task explicitly needs an existing user tab.',
    },
  )

  outerServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const upstream = await innerClient.listTools(request.params)
    return {
      ...upstream,
      tools: [
        candidateTool,
        claimTool,
        ...upstream.tools.filter((tool) => !BLOCKED_UPSTREAM_TOOLS.has(tool.name)),
      ],
    }
  })

  outerServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    scoped.heartbeat()
    const { name, arguments: toolArgs } = request.params

    if (name === candidateTool.name) {
      return textResult(renderTabCandidates(await scoped.listCandidates()))
    }
    if (name === claimTool.name) {
      const tabId = typeof toolArgs?.tabId === 'string' ? toolArgs.tabId : ''
      if (!tabId) return textResult('browser_tab_claim requires tabId.', true)
      const result = await scoped.claimExisting(tabId)
      if (!result.ok) return textResult(result.reason, true)
      const tabs = await innerClient.callTool({
        name: 'browser_tabs',
        arguments: { action: 'list' },
      })
      const tabList = Array.isArray(tabs.content)
        ? tabs.content
            .filter((item): item is { type: 'text'; text: string } =>
              typeof item === 'object' && item !== null &&
              'type' in item && item.type === 'text' &&
              'text' in item && typeof item.text === 'string',
            )
            .map((item) => item.text)
            .join('\n')
        : ''
      return textResult(
        `Claimed ${result.candidate.tabId}: ${result.candidate.title || '(untitled)'} — ${result.candidate.url}` +
          (tabList ? `\n\n${tabList}` : ''),
      )
    }
    if (BLOCKED_UPSTREAM_TOOLS.has(name)) {
      return textResult(`${name} is disabled because it can escape task-scoped tab ownership.`, true)
    }
    return innerClient.callTool({ name, arguments: toolArgs })
  })

  const heartbeat = setInterval(() => scoped.heartbeat(), HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()
  const stdio = new StdioServerTransport()
  await outerServer.connect(stdio)

  let stop!: () => void
  const stopped = new Promise<void>((resolve) => { stop = resolve })
  process.stdin.once('end', stop)
  process.stdin.once('close', stop)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  await stopped

  clearInterval(heartbeat)
  await scoped.dispose()
  leases.close()
  await innerClient.close().catch(() => undefined)
  await innerServer.close().catch(() => undefined)
  await outerServer.close().catch(() => undefined)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  // stdout is reserved for the MCP protocol.
  console.error(`[heyamigo browser MCP] ${message}`)
  process.exitCode = 1
})
