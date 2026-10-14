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
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['browse', 'upload_file', 'download_file'])

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

test('install_skill writes a verified skill version into the pack and refuses tampered or local ones', async () => {
  const { createHash } = await import('node:crypto')
  const { mkdir } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'heyamigo-skill-vault-'))
  const credentialFile = join(root, 'mcp-token')
  const packFile = join(root, 'config', 'pack.json')
  const skillsDir = join(root, 'config', 'skills')
  const token = `amg_pat_${'B'.repeat(43)}`
  await writeFile(credentialFile, `${token}\n`, { mode: 0o600 })
  await mkdir(join(root, 'config'), { recursive: true })
  await writeFile(packFile, `${JSON.stringify({
    version: 1,
    skills: [{ id: 'local-skill', file: './config/skills/local-skill.md', mode: 'demand', source: 'https://github.com/someone/repo', description: 'Hand written' }],
    mcps: ['example'],
    note: 'unknown keys survive',
  }, null, 2)}\n`)

  const nodeId = '00000000-0000-4000-8000-000000000010'
  const collectionId = '00000000-0000-4000-8000-000000000020'
  const versionOne = '00000000-0000-4000-8000-000000000101'
  const versionTwo = '00000000-0000-4000-8000-000000000102'
  const bodies: Record<string, string> = {
    [versionOne]: '# Be brief\n\nOne line, then stop.',
    [versionTwo]: '# Be brief\n\nOne line, then stop. Numbers go in a table.',
  }
  const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
  const scenario = { skillId: 'be-brief', corruptCurrentDigest: false, emptyCurrentBody: false }

  const httpServer = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(405).end()
      return
    }
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown
    const mcp = new Server({ name: 'amigospace-test', version: '1.0.0' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'browse', description: 'Browse', inputSchema: { type: 'object', additionalProperties: false } }],
    }))
    mcp.setRequestHandler(CallToolRequestSchema, async (call) => {
      const args = (call.params.arguments ?? {}) as Record<string, unknown>
      const answer = (structured: Record<string, unknown>) => ({
        content: [{ type: 'text', text: `${call.params.name}\n${JSON.stringify(structured)}` }],
        structuredContent: structured,
      })
      if (call.params.name === 'structure') {
        assert.deepEqual(args, { operation: 'resolve', nodeId })
        return answer({
          operation: 'resolve',
          collection: { id: collectionId, semanticRole: 'skill', name: 'Skills' },
          record: { nodeId, collectionId, revision: 3 },
        })
      }
      if (call.params.name === 'query') {
        assert.equal(args.collectionId, collectionId)
        assert.equal(args.recordNodeId, nodeId)
        const known = (value: string) => ({ state: 'known', value, authority: 'user', sourceNodeId: null, confidence: null, observedAt: null, validUntil: null, userConfirmed: true })
        return answer({
          records: [{ nodeId, collectionId, title: 'Be brief', revision: 3, values: { skill_id: known(scenario.skillId), mode: known('always'), summary: known('Keeps replies short') } }],
        })
      }
      if (call.params.name === 'open' && args.detail === 'versions') {
        return answer({
          node: { id: nodeId, revision: 2 },
          version: { id: versionTwo, revision: 2 },
          versions: [
            { id: versionTwo, revision: 2, isCurrent: true, contentSha256: scenario.corruptCurrentDigest ? 'f'.repeat(64) : digest(bodies[versionTwo]!) },
            { id: versionOne, revision: 1, isCurrent: false, contentSha256: digest(bodies[versionOne]!) },
          ],
        })
      }
      if (call.params.name === 'open' && args.detail === 'full') {
        const versionId = typeof args.versionId === 'string' ? args.versionId : versionTwo
        const bodyMarkdown = scenario.emptyCurrentBody && versionId === versionTwo ? '' : bodies[versionId]
        return answer({
          node: { id: nodeId, revision: 2 },
          version: { id: versionId, revision: versionId === versionTwo ? 2 : 1 },
          detail: 'full',
          content: { kind: 'page', bodyMarkdown },
        })
      }
      throw new Error(`unexpected upstream call ${call.params.name}`)
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await mcp.connect(transport)
    await transport.handleRequest(request, response, body)
    response.once('close', () => { void Promise.allSettled([transport.close(), mcp.close()]) })
  })
  await new Promise<void>((resolvePromise) => httpServer.listen(0, '127.0.0.1', resolvePromise))
  const address = httpServer.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`

  const connectorTransport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve('scripts/amigospace-mcp.mjs'),
      '--endpoint', `${origin}/mcp`,
      '--credential-file', credentialFile,
      '--timeout-ms', '5000',
      '--pack-file', packFile,
      '--skills-dir', skillsDir,
      '--pack-root', root,
    ],
    stderr: 'pipe',
  })
  const client = new Client({ name: 'heyamigo-connector-test', version: '1.0.0' }, { capabilities: {} })
  const install = (args: Record<string, unknown>) =>
    client.callTool({ name: 'install_skill', arguments: args }, undefined, { timeout: 5_000 })
  const readPack = async () => JSON.parse(await readFile(packFile, 'utf8')) as { skills: Record<string, unknown>[]; mcps: string[]; note?: string }

  try {
    await client.connect(connectorTransport, { timeout: 5_000 })
    const listed = await client.listTools(undefined, { timeout: 5_000 })
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['browse', 'upload_file', 'download_file', 'install_skill'])

    const current = await install({ nodeId })
    assert.equal(current.isError, undefined, JSON.stringify(current.content))
    assert.deepEqual(current.structuredContent, {
      skillId: 'be-brief',
      path: join(skillsDir, 'be-brief.md'),
      file: './config/skills/be-brief.md',
      nodeId,
      versionId: versionTwo,
      revision: 2,
      mode: 'always',
      sha256: digest(bodies[versionTwo]!),
      packEntry: 'created',
    })
    assert.equal(await readFile(join(skillsDir, 'be-brief.md'), 'utf8'), bodies[versionTwo])
    let pack = await readPack()
    assert.equal(pack.note, 'unknown keys survive')
    assert.deepEqual(pack.mcps, ['example'])
    assert.deepEqual(pack.skills[1], {
      id: 'be-brief',
      file: './config/skills/be-brief.md',
      mode: 'always',
      source: `${origin}/items/${nodeId}?version=${versionTwo}`,
      description: 'Keeps replies short',
    })

    const older = await install({ nodeId, versionId: versionOne })
    assert.equal(older.isError, undefined, JSON.stringify(older.content))
    assert.equal((older.structuredContent as Record<string, unknown>).packEntry, 'updated')
    assert.equal(await readFile(join(skillsDir, 'be-brief.md'), 'utf8'), bodies[versionOne])
    pack = await readPack()
    assert.equal(pack.skills.length, 2)
    assert.equal(pack.skills[1]!.source, `${origin}/items/${nodeId}?version=${versionOne}`)

    scenario.corruptCurrentDigest = true
    const tampered = await install({ nodeId })
    assert.equal(tampered.isError, true)
    assert.deepEqual(tampered.structuredContent, { code: 'SKILL_INTEGRITY_FAILED' })
    assert.equal(await readFile(join(skillsDir, 'be-brief.md'), 'utf8'), bodies[versionOne])
    scenario.corruptCurrentDigest = false

    scenario.emptyCurrentBody = true
    const empty = await install({ nodeId })
    assert.equal(empty.isError, true)
    assert.deepEqual(empty.structuredContent, { code: 'SKILL_BODY_EMPTY' })
    assert.equal(await readFile(join(skillsDir, 'be-brief.md'), 'utf8'), bodies[versionOne])
    scenario.emptyCurrentBody = false

    scenario.skillId = 'local-skill'
    const local = await install({ nodeId })
    assert.equal(local.isError, true)
    assert.deepEqual(local.structuredContent, { code: 'SKILL_LOCALLY_OWNED' })
    pack = await readPack()
    assert.equal(pack.skills[0]!.source, 'https://github.com/someone/repo')
    await assert.rejects(readFile(join(skillsDir, 'local-skill.md')))
  } finally {
    await client.close()
    await new Promise<void>((resolvePromise, rejectPromise) =>
      httpServer.close((error) => (error ? rejectPromise(error) : resolvePromise())),
    )
    await rm(root, { recursive: true, force: true })
  }
})
