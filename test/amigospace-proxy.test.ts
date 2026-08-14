import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

function upstreamServer(): Server {
  const server = new Server(
    { name: 'amigospace-test', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'browse',
        description: 'Browse the personal workspace',
        inputSchema: { type: 'object', additionalProperties: false },
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      {
        type: 'text',
        text: `forwarded:${request.params.name}`,
      },
    ],
  }))
  return server
}

test('stdio connector refreshes OIDC and forwards authenticated cloud MCP calls', async () => {
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'heyamigo-amigospace-'))
  const credentialFile = join(credentialDirectory, 'refresh-token')
  await writeFile(credentialFile, 'refresh-original\n', { mode: 0o600 })
  let tokenRequests = 0
  let authenticatedMcpRequests = 0

  const httpServer = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/token') {
      tokenRequests += 1
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      assert.equal(form.get('client_id'), 'amigospace-device')
      assert.equal(form.get('grant_type'), 'refresh_token')
      assert.equal(form.get('refresh_token'), 'refresh-original')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          access_token: 'access-test',
          expires_in: 300,
          refresh_token: 'refresh-rotated',
          token_type: 'Bearer',
        }),
      )
      return
    }

    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(405).end()
      return
    }
    assert.equal(request.headers.authorization, 'Bearer access-test')
    authenticatedMcpRequests += 1

    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown
    const mcp = upstreamServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    await mcp.connect(transport)
    await transport.handleRequest(request, response, body)
    response.once('close', () => {
      void Promise.allSettled([transport.close(), mcp.close()])
    })
  })

  await new Promise<void>((resolvePromise) =>
    httpServer.listen(0, '127.0.0.1', resolvePromise),
  )
  const address = httpServer.address()
  assert.ok(address && typeof address !== 'string')

  const connectorTransport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve('scripts/amigospace-mcp.mjs'),
      '--endpoint',
      `http://127.0.0.1:${address.port}/mcp`,
      '--client-id',
      'amigospace-device',
      '--token-endpoint',
      `http://127.0.0.1:${address.port}/token`,
      '--credential-file',
      credentialFile,
      '--timeout-ms',
      '5000',
    ],
    stderr: 'pipe',
  })
  const client = new Client(
    { name: 'heyamigo-connector-test', version: '1.0.0' },
    { capabilities: {} },
  )

  try {
    await client.connect(connectorTransport, { timeout: 5_000 })
    const listed = await client.listTools(undefined, { timeout: 5_000 })
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['browse'])

    const result = await client.callTool(
      { name: 'browse', arguments: {} },
      undefined,
      { timeout: 5_000 },
    )
    assert.deepEqual(result.content, [
      { type: 'text', text: 'forwarded:browse' },
    ])
    assert.equal(tokenRequests, 1)
    assert.ok(authenticatedMcpRequests >= 2)
    assert.equal(await readFile(credentialFile, 'utf8'), 'refresh-rotated\n')
  } finally {
    await client.close()
    await new Promise<void>((resolvePromise, rejectPromise) =>
      httpServer.close((error) =>
        error ? rejectPromise(error) : resolvePromise(),
      ),
    )
    await rm(credentialDirectory, { recursive: true, force: true })
  }
})
