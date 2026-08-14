import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { config } from '../config.js'
import {
  credentialPath,
  refreshTokenConfigured,
  storeRefreshToken,
} from './credentials.js'
import { authorizeAmigospaceDevice } from './device-auth.js'

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
    await authorizeAmigospaceDevice({
      clientId: config.amigospace.clientId,
      deviceAuthorizationEndpoint:
        config.amigospace.deviceAuthorizationEndpoint,
      tokenEndpoint: config.amigospace.tokenEndpoint,
      scope: config.amigospace.scope,
      requestTimeoutMs: config.amigospace.requestTimeoutMs,
      signal: controller.signal,
      saveRefreshToken: (refreshToken) =>
        storeRefreshToken(path, refreshToken),
      present: (prompt) => {
        console.log('\nOpen this URL in a browser:')
        console.log(`  ${prompt.verificationUriComplete ?? prompt.verificationUri}`)
        console.log(`\nConfirm code: ${prompt.userCode}`)
        console.log(`Waiting for approval (expires ${prompt.expiresAt})…\n`)
      },
    })
    await enableConnector()
    console.log('Connected. Cloud Amigospace tools are enabled for permitted roles.')
  } finally {
    process.removeListener('SIGINT', cancel)
  }
}

export async function amigospaceStatus(): Promise<void> {
  const connected = await refreshTokenConfigured(
    credentialPath(config.amigospace.credentialFile),
  )
  console.log(`Connector: ${config.amigospace.enabled ? 'enabled' : 'disabled'}`)
  console.log(`Account:   ${connected ? 'connected' : 'not connected'}`)
  console.log(`Endpoint:  ${config.amigospace.endpoint}`)
}
