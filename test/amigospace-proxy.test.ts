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

function upstreamServer(
  onToolCall: (input: { readonly name: string; readonly arguments?: Record<string, unknown> }) => void,
): Server {
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
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    onToolCall(request.params)
    return {
      content: [
        {
          type: 'text',
          text: `forwarded:${request.params.name}`,
        },
      ],
      ...(request.params.name === 'save'
        ? { structuredContent: { mode: 'create', result: { nodeId: request.params.arguments?.input && typeof request.params.arguments.input === 'object' ? (request.params.arguments.input as Record<string, unknown>).nodeId : null } } }
        : {}),
    }
  })
  return server
}

test('stdio connector forwards MCP calls with one durable token', async () => {
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'heyamigo-amigospace-'))
  const credentialFile = join(credentialDirectory, 'mcp-token')
  const uploadPath = join(credentialDirectory, 'architecture.png')
  const token = `amg_pat_${'A'.repeat(43)}`
  await writeFile(credentialFile, `${token}\n`, { mode: 0o600 })
  await writeFile(uploadPath, 'real-image-bytes', { mode: 0o600 })
  let authenticatedMcpRequests = 0
  let authenticatedUploadRequests = 0
  let saveArguments: Record<string, unknown> | undefined

  const httpServer = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/v1/blobs') {
      assert.equal(request.headers.authorization, `Bearer ${token}`)
      assert.match(request.headers['content-type'] ?? '', /^multipart\/form-data; boundary=/)
      assert.match(request.headers['x-amigospace-blob-id'] ?? '', /^[0-9a-f-]{36}$/)
      assert.match(request.headers['x-amigospace-event-id'] ?? '', /^[0-9a-f-]{36}$/)
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString('utf8')
      assert.match(body, /filename="architecture\.png"/)
      assert.match(body, /Content-Type: image\/png/)
      assert.match(body, /real-image-bytes/)
      authenticatedUploadRequests += 1
      response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: request.headers['x-amigospace-blob-id'],
        eventId: request.headers['x-amigospace-event-id'],
        eventSequence: 1,
        sha256: 'a'.repeat(64),
        originalName: 'architecture.png',
        mediaType: 'image/png',
        sizeBytes: 16,
        deduplicated: false,
        registeredAt: '2026-08-16T00:00:00.000Z',
        replayed: false,
      }))
      return
    }

    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(405).end()
      return
    }
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    authenticatedMcpRequests += 1

    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown
    const mcp = upstreamServer((input) => {
      if (input.name === 'save') saveArguments = input.arguments
    })
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
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['browse', 'upload_file'])

    const result = await client.callTool(
      { name: 'browse', arguments: {} },
      undefined,
      { timeout: 5_000 },
    )
    assert.deepEqual(result.content, [
      { type: 'text', text: 'forwarded:browse' },
    ])

    const uploaded = await client.callTool(
      {
        name: 'upload_file',
        arguments: {
          path: uploadPath,
          projectId: '00000000-0000-4000-8000-000000000001',
          parentId: '00000000-0000-4000-8000-000000000002',
          captionMarkdown: 'System diagram',
        },
      },
      undefined,
      { timeout: 5_000 },
    )
    assert.equal(uploaded.isError, undefined)
    assert.match(uploaded.content[0]?.type === 'text' ? uploaded.content[0].text : '', /Uploaded architecture\.png/)
    assert.equal(authenticatedUploadRequests, 1)
    assert.equal(saveArguments?.mode, 'create')
    const saveInput = saveArguments?.input as Record<string, unknown>
    assert.equal(saveInput.projectId, '00000000-0000-4000-8000-000000000001')
    assert.equal(saveInput.parentId, '00000000-0000-4000-8000-000000000002')
    assert.equal(saveInput.title, 'architecture.png')
    assert.deepEqual(saveInput.content, {
      kind: 'file',
      blob: {
        id: (uploaded.structuredContent as Record<string, unknown>).blobId,
        sha256: 'a'.repeat(64),
        mediaType: 'image/png',
        sizeBytes: 16,
        originalName: 'architecture.png',
      },
      captionMarkdown: 'System diagram',
    })
    assert.ok(authenticatedMcpRequests >= 2)
    assert.equal(await readFile(credentialFile, 'utf8'), `${token}\n`)
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
