import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { config } from '../config.js'
import {
  credentialPath,
  mcpTokenConfigured,
  storeMcpToken,
} from './credentials.js'
import { authorizeAmigospaceDevice } from './device-auth.js'

const DEVICE_CLIENT_ID = 'amigospace-device'
const DEVICE_AUTHORIZATION_ENDPOINT =
  'https://identity.heyamigo.org/realms/amigospace/protocol/openid-connect/auth/device'
const DEVICE_TOKEN_ENDPOINT =
  'https://identity.heyamigo.org/realms/amigospace/protocol/openid-connect/token'
const MCP_TOKEN_PATTERN = /^amg_pat_[A-Za-z0-9_-]{43}$/
const MAXIMUM_RESPONSE_BYTES = 128 * 1_024

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAXIMUM_RESPONSE_BYTES) {
    throw new Error('Amigospace returned an invalid connector response')
  }
  if (response.body === null) {
    throw new Error('Amigospace returned an invalid connector response')
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Amigospace returned an invalid connector response')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  try {
    const value = JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8'),
    ) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('not an object')
    }
    return value as Record<string, unknown>
  } catch {
    throw new Error('Amigospace returned an invalid connector response')
  }
}

async function createDurableMcpToken(
  accessToken: string,
  signal: AbortSignal,
): Promise<string> {
  const endpoint = new URL('/v1/mcp-tokens', config.amigospace.endpoint)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, config.amigospace.requestTimeoutMs)
  try {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ label: 'HeyAmigo' }),
        redirect: 'error',
        signal: controller.signal,
      })
    } catch {
      if (signal.aborted) throw new Error('Amigospace connection cancelled')
      throw new Error('Amigospace is unavailable while creating the connector token')
    }
    const payload = await readJsonObject(response)
    if (!response.ok || typeof payload.token !== 'string' || !MCP_TOKEN_PATTERN.test(payload.token)) {
      throw new Error('Amigospace could not create a durable connector token')
    }
    return payload.token
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}

async function enableConnector(): Promise<void> {
  const path = resolve('config/config.json')
  const document = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >
  const existing =
    typeof document.amigospace === 'object' &&
    document.amigospace !== null &&
    !Array.isArray(document.amigospace)
      ? (document.amigospace as Record<string, unknown>)
      : {}
  document.amigospace = { ...existing, enabled: true }

  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporary, path)
}

export async function connectAmigospace(): Promise<void> {
  const path = credentialPath(config.amigospace.credentialFile)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  try {
    console.log('Connecting HeyAmigo to cloud Amigospace…')
    const accessToken = await authorizeAmigospaceDevice({
      clientId: DEVICE_CLIENT_ID,
      deviceAuthorizationEndpoint: DEVICE_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: DEVICE_TOKEN_ENDPOINT,
      scope: 'openid',
      requestTimeoutMs: config.amigospace.requestTimeoutMs,
      signal: controller.signal,
      present: (prompt) => {
        console.log('\nOpen this URL in a browser:')
        console.log(`  ${prompt.verificationUriComplete ?? prompt.verificationUri}`)
        console.log(`\nConfirm code: ${prompt.userCode}`)
        console.log(`Waiting for approval (expires ${prompt.expiresAt})…\n`)
      },
    })
    await storeMcpToken(
      path,
      await createDurableMcpToken(accessToken, controller.signal),
    )
    await enableConnector()
    console.log('Connected. Cloud Amigospace tools are enabled for permitted roles.')
  } finally {
    process.removeListener('SIGINT', cancel)
  }
}

export async function amigospaceStatus(): Promise<void> {
  const connected = await mcpTokenConfigured(
    credentialPath(config.amigospace.credentialFile),
  )
  console.log(`Connector: ${config.amigospace.enabled ? 'enabled' : 'disabled'}`)
  console.log(`Account:   ${connected ? 'connected' : 'not connected'}`)
  console.log(`Endpoint:  ${config.amigospace.endpoint}`)
}
