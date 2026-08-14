#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const MAXIMUM_TOKEN_BYTES = 65_536
const MAXIMUM_RESPONSE_BYTES = 128 * 1_024
const allowedOptions = new Set([
  '--endpoint',
  '--client-id',
  '--token-endpoint',
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

function printableToken(value, maximum = MAXIMUM_TOKEN_BYTES) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[\x21-\x7e]+$/.test(value)
  )
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

async function syncDirectory(path) {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function loadRefreshToken(path) {
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
    if (!printableToken(value)) throw new Error('Amigospace credential file is invalid')
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

async function replaceRefreshToken(path, value) {
  if (!printableToken(value)) throw new Error('Amigospace returned an invalid refresh credential')
  const directoryPath = dirname(path)
  await requireSecureDirectory(directoryPath)
  const temporaryPath = join(
    directoryPath,
    `.${basename(path)}.${randomUUID()}.tmp`,
  )
  let temporary
  try {
    temporary = await open(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    )
    await temporary.writeFile(`${value}\n`, 'utf8')
    await temporary.sync()
    await temporary.close()
    temporary = undefined
    await rename(temporaryPath, path)
    await syncDirectory(directoryPath)
  } finally {
    await temporary?.close()
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isFileSystemError(error, 'EPERM')
  }
}

async function removeAbandonedLock(path, timeoutMs) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > 1_024) return false
    requirePrivateOwnership(stat)
    const lock = JSON.parse(await file.readFile('utf8'))
    const old = Date.now() - stat.mtimeMs > timeoutMs * 2
    if (processIsAlive(lock.pid) && !old) return false

    const current = await lstat(path)
    if (current.dev !== stat.dev || current.ino !== stat.ino) return false
    await rm(path)
    return true
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return true
    return false
  } finally {
    await file?.close()
  }
}

async function acquireRefreshLock(credentialFile, timeoutMs) {
  const path = `${credentialFile}.lock`
  const deadline = Date.now() + timeoutMs
  await requireSecureDirectory(dirname(credentialFile))
  while (Date.now() < deadline) {
    let file
    try {
      file = await open(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      )
      await file.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
      await file.sync()
      await file.close()
      return async () => {
        await rm(path, { force: true })
      }
    } catch (error) {
      await file?.close().catch(() => undefined)
      if (!isFileSystemError(error, 'EEXIST')) throw error
      if (await removeAbandonedLock(path, timeoutMs)) continue
      await wait(100)
    }
  }
  throw new Error('Amigospace credential refresh is busy; retry the request')
}

async function readBoundedJson(response) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAXIMUM_RESPONSE_BYTES) {
    throw new Error('Amigospace identity service returned an invalid response')
  }
  if (!response.body) throw new Error('Amigospace identity service returned an invalid response')

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Amigospace identity service returned an invalid response')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8'))
  } catch {
    throw new Error('Amigospace identity service returned an invalid response')
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch {
    throw new Error('Amigospace identity service is unavailable')
  } finally {
    clearTimeout(timer)
  }
}

const endpoint = secureEndpoint(requiredOption('--endpoint'), 'Amigospace MCP endpoint')
const tokenEndpoint = secureEndpoint(requiredOption('--token-endpoint'), 'Amigospace token endpoint')
const clientId = requiredOption('--client-id')
if (!printableToken(clientId, 255)) throw new Error('Amigospace OIDC client ID is invalid')

const credentialFile = requiredOption('--credential-file')
if (!isAbsolute(credentialFile)) throw new Error('Amigospace credential path must be absolute')

const timeoutMs = Number.parseInt(options.get('--timeout-ms') ?? '5000', 10)
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
  throw new Error('--timeout-ms must be an integer between 1000 and 30000')
}

let cachedAccessToken

async function refreshAccessToken() {
  const release = await acquireRefreshLock(credentialFile, timeoutMs)
  try {
    const refreshToken = await loadRefreshToken(credentialFile)
    const response = await fetchWithTimeout(
      tokenEndpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        redirect: 'error',
      },
      timeoutMs,
    )
    const token = await readBoundedJson(response)
    if (!response.ok) {
      if (token?.error === 'invalid_grant') {
        throw new Error('Amigospace login expired. Run: heyamigo amigospace connect')
      }
      throw new Error('Amigospace rejected the stored credential')
    }
    if (
      !printableToken(token?.access_token, 32_768) ||
      !Number.isInteger(token?.expires_in) ||
      token.expires_in < 1 ||
      token.expires_in > 86_400 ||
      typeof token?.token_type !== 'string' ||
      token.token_type.toLowerCase() !== 'bearer' ||
      (token.refresh_token !== undefined && !printableToken(token.refresh_token))
    ) {
      throw new Error('Amigospace identity service returned an invalid response')
    }
    if (token.refresh_token && token.refresh_token !== refreshToken) {
      await replaceRefreshToken(credentialFile, token.refresh_token)
    }
    cachedAccessToken = {
      value: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1_000,
    }
    return cachedAccessToken.value
  } finally {
    await release()
  }
}

async function accessToken() {
  if (cachedAccessToken && cachedAccessToken.expiresAt - Date.now() > 30_000) {
    return cachedAccessToken.value
  }
  return refreshAccessToken()
}

async function authenticatedFetch(input, init = {}) {
  const send = async (token) => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    return fetch(input, { ...init, headers, redirect: 'error' })
  }

  const current = await accessToken()
  let response = await send(current)
  if (response.status !== 401) return response

  await response.body?.cancel().catch(() => undefined)
  if (cachedAccessToken?.value === current) cachedAccessToken = undefined
  response = await send(await accessToken())
  return response
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

server.setRequestHandler(ListToolsRequestSchema, async (request) =>
  upstream.listTools(request.params, { timeout: timeoutMs }),
)

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  upstream.callTool(request.params, undefined, { timeout: timeoutMs }),
)

const stdio = new StdioServerTransport()
await server.connect(stdio)

async function close() {
  await Promise.allSettled([server.close(), upstream.close()])
}

process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
