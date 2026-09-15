#!/usr/bin/env node

import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const MCP_TOKEN_PATTERN = /^amg_pat_[A-Za-z0-9_-]{43}$/
const MAXIMUM_TOKEN_BYTES = 128
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MEDIA_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.heic', 'image/heic'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.zip', 'application/zip'],
])
const allowedOptions = new Set([
  '--endpoint',
  '--credential-file',
  '--timeout-ms',
])

function parseOptions(argv) {
  const parsed = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!allowedOptions.has(name) || value === undefined || parsed.has(name)) {
      throw new Error('Invalid Amigospace connector options')
    }
    parsed.set(name, value)
  }
  return parsed
}

const options = parseOptions(process.argv.slice(2))

function requiredOption(name) {
  const value = options.get(name)
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function secureEndpoint(raw, label) {
  const url = new URL(raw)
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new Error(`${label} must use HTTPS unless it is loopback and cannot contain credentials`)
  }
  return url
}

function isFileSystemError(error, code) {
  return error instanceof Error && 'code' in error && error.code === code
}

function requirePrivateOwnership(stat) {
  const currentUserId = process.getuid?.()
  if ((stat.mode & 0o077) !== 0 || (currentUserId !== undefined && stat.uid !== currentUserId)) {
    throw new Error('Amigospace credential storage is not private to this user')
  }
}

async function requireSecureDirectory(path) {
  let directory
  try {
    directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    const stat = await directory.stat()
    if (!stat.isDirectory()) throw new Error('Amigospace credential directory is invalid')
    requirePrivateOwnership(stat)
  } finally {
    await directory?.close()
  }
}

async function loadMcpToken(path) {
  await requireSecureDirectory(dirname(path))
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > MAXIMUM_TOKEN_BYTES + 2) {
      throw new Error('Amigospace credential file is invalid')
    }
    requirePrivateOwnership(stat)
    const raw = await file.readFile('utf8')
    const value = raw.endsWith('\r\n')
      ? raw.slice(0, -2)
      : raw.endsWith('\n')
        ? raw.slice(0, -1)
        : raw
    if (!MCP_TOKEN_PATTERN.test(value)) {
      throw new Error('Amigospace token is invalid. Run: heyamigo amigospace connect')
    }
    return value
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) {
      throw new Error('Amigospace is not connected. Run: heyamigo amigospace connect')
    }
    throw error
  } finally {
    await file?.close()
  }
}

const endpoint = secureEndpoint(requiredOption('--endpoint'), 'Amigospace MCP endpoint')
const credentialFile = requiredOption('--credential-file')
if (!isAbsolute(credentialFile)) throw new Error('Amigospace credential path must be absolute')

const timeoutMs = Number.parseInt(options.get('--timeout-ms') ?? '5000', 10)
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
  throw new Error('--timeout-ms must be an integer between 1000 and 30000')
}

const token = await loadMcpToken(credentialFile)
const authenticatedFetch = (input, init = {}) => {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  return fetch(input, { ...init, headers, redirect: 'error' })
}

const uploadFileTool = {
  name: 'upload_file',
  title: 'Upload a local file',
  description:
    'Upload the actual bytes of a user-approved local file to private Amigospace storage and create its file node. Use the exact absolute path from the current user message; never save the path as text.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'projectId', 'parentId'],
    properties: {
      path: {
        type: 'string',
        minLength: 1,
        maxLength: 4096,
        description: 'Exact absolute local path shown in the current user message.',
      },
      projectId: { type: 'string', format: 'uuid' },
      parentId: { type: 'string', format: 'uuid' },
      title: { type: 'string', minLength: 1, maxLength: 500 },
      captionMarkdown: { type: 'string', maxLength: 100000 },
      mediaType: {
        type: 'string',
        minLength: 3,
        maxLength: 255,
        pattern: '^[^\\s/]+/[^\\s/]+$',
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}

function toolInput(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('UPLOAD_FILE_INPUT_INVALID')
  }
  const input = value
  if (
    typeof input.path !== 'string' ||
    input.path.length < 1 ||
    input.path.length > 4096 ||
    !isAbsolute(input.path) ||
    typeof input.projectId !== 'string' ||
    !UUID_PATTERN.test(input.projectId) ||
    typeof input.parentId !== 'string' ||
    !UUID_PATTERN.test(input.parentId) ||
    (input.title !== undefined &&
      (typeof input.title !== 'string' || input.title.trim().length < 1 || input.title.length > 500)) ||
    (input.captionMarkdown !== undefined &&
      (typeof input.captionMarkdown !== 'string' || input.captionMarkdown.length > 100000)) ||
    (input.mediaType !== undefined &&
      (typeof input.mediaType !== 'string' ||
        input.mediaType.length > 255 ||
        !/^[^\s/]+\/[^\s/]+$/.test(input.mediaType)))
  ) {
    throw new Error('UPLOAD_FILE_INPUT_INVALID')
  }
  return input
}

function uploadFailure(code) {
  const error = new Error(code)
  error.code = code
  return error
}

async function responseErrorCode(response) {
  try {
    const payload = await response.json()
    if (
      typeof payload === 'object' &&
      payload !== null &&
      typeof payload.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,127}$/.test(payload.code)
    ) {
      return payload.code
    }
  } catch {
    // Proxies can return non-JSON failures; keep one bounded public code.
  }
  return `UPLOAD_HTTP_${response.status}`
}

function blobReceipt(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.mediaType !== 'string' ||
    !/^[^\s/]+\/[^\s/]+$/.test(value.mediaType) ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    typeof value.originalName !== 'string' ||
    value.originalName.length < 1
  ) {
    throw uploadFailure('UPLOAD_RESPONSE_INVALID')
  }
  return value
}

function multipartBody(file, prefix, suffix) {
  return (async function* () {
    yield prefix
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      yield chunk
    }
    yield suffix
  })()
}

async function uploadLocalFile(rawInput) {
  const input = toolInput(rawInput)
  let file
  try {
    file = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw uploadFailure('UPLOAD_FILE_INVALID')
    }

    const originalName = basename(input.path)
    if (originalName.length < 1 || originalName.length > 1024) {
      throw uploadFailure('UPLOAD_FILE_NAME_INVALID')
    }
    const mediaType = input.mediaType ?? MEDIA_TYPES.get(extname(originalName).toLowerCase()) ?? 'application/octet-stream'
    const safeName = originalName.replace(/[\r\n"]/g, '_')
    const boundary = `amigospace-${randomUUID()}`
    const prefix = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
        `Content-Type: ${mediaType}\r\n\r\n`,
      'utf8',
    )
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    const contentLength = prefix.byteLength + stat.size + suffix.byteLength
    if (!Number.isSafeInteger(contentLength)) throw uploadFailure('UPLOAD_FILE_TOO_LARGE')

    const requestedBlobId = randomUUID()
    const response = await authenticatedFetch(new URL('/v1/blobs', endpoint), {
      method: 'POST',
      headers: {
        'content-length': String(contentLength),
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'idempotency-key': `connector-upload:${requestedBlobId}`,
        'x-amigospace-blob-id': requestedBlobId,
        'x-amigospace-event-id': randomUUID(),
      },
      body: multipartBody(file, prefix, suffix),
      duplex: 'half',
    })
    if (!response.ok) throw uploadFailure(await responseErrorCode(response))
    const registered = blobReceipt(await response.json())

    const nodeId = randomUUID()
    const saved = await upstream.callTool(
      {
        name: 'save',
        arguments: {
          mode: 'create',
          input: {
            nodeId,
            versionId: randomUUID(),
            eventId: randomUUID(),
            projectId: input.projectId,
            parentId: input.parentId,
            title: input.title?.trim() ?? originalName,
            content: {
              kind: 'file',
              blob: {
                id: registered.id,
                sha256: registered.sha256,
                mediaType: registered.mediaType,
                sizeBytes: registered.sizeBytes,
                originalName: registered.originalName,
              },
              ...(input.captionMarkdown === undefined
                ? {}
                : { captionMarkdown: input.captionMarkdown }),
            },
            idempotencyKey: `connector-save:${nodeId}`,
          },
        },
      },
      undefined,
      { timeout: timeoutMs },
    )

    if (saved.isError === true) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: 'UPLOAD_NODE_SAVE_FAILED: The file bytes were stored, but its workspace node was not created.',
        }],
        structuredContent: {
          blobId: registered.id,
          originalName: registered.originalName,
          sizeBytes: registered.sizeBytes,
        },
      }
    }

    return {
      content: [{
        type: 'text',
        text: `Uploaded ${registered.originalName} (${registered.sizeBytes} bytes) and saved file node ${nodeId}.`,
      }],
      structuredContent: {
        nodeId,
        blobId: registered.id,
        originalName: registered.originalName,
        mediaType: registered.mediaType,
        sizeBytes: registered.sizeBytes,
      },
    }
  } finally {
    await file?.close()
  }
}

const upstream = new Client(
  { name: 'heyamigo-amigospace-connector', version: '1.0.0' },
  { capabilities: {} },
)
const upstreamTransport = new StreamableHTTPClientTransport(endpoint, {
  fetch: authenticatedFetch,
})
await upstream.connect(upstreamTransport, { timeout: timeoutMs })

const server = new Server(
  { name: 'amigospace', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Private cloud knowledge workspace. Retrieve progressively and never request a workspace or user identifier.',
  },
)

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const listed = await upstream.listTools(request.params, { timeout: timeoutMs })
  if (listed.tools.some(({ name }) => name === uploadFileTool.name)) {
    throw new Error('Amigospace upstream tool collides with local upload_file')
  }
  return { ...listed, tools: [...listed.tools, uploadFileTool] }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== uploadFileTool.name) {
    return upstream.callTool(request.params, undefined, { timeout: timeoutMs })
  }
  try {
    return await uploadLocalFile(request.params.arguments)
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)
      ? error.message
      : 'UPLOAD_FILE_FAILED'
    return {
      isError: true,
      content: [{ type: 'text', text: `${code}: The local file was not uploaded.` }],
      structuredContent: { code },
    }
  }
})

const stdio = new StdioServerTransport()
await server.connect(stdio)

async function close() {
  await Promise.allSettled([server.close(), upstream.close()])
}

process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
