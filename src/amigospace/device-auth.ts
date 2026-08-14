export interface DeviceAuthorizationPrompt {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAt: string
}

export interface DeviceAuthorizationOptions {
  clientId: string
  deviceAuthorizationEndpoint: string
  tokenEndpoint: string
  scope: string
  requestTimeoutMs: number
  saveRefreshToken(refreshToken: string): Promise<void>
  present(prompt: DeviceAuthorizationPrompt): Promise<void> | void
  signal?: AbortSignal
  fetch?: typeof fetch
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

type JsonObject = Record<string, unknown>

export class DeviceAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeviceAuthorizationError'
  }
}

function secureEndpoint(value: string, label: string): URL {
  const endpoint = new URL(value)
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
    endpoint.hostname,
  )
  if (endpoint.username || endpoint.password) {
    throw new Error(`${label} cannot contain credentials`)
  }
  if (
    endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' && loopback)
  ) {
    throw new Error(`${label} must use HTTPS unless it is loopback`)
  }
  endpoint.hash = ''
  return endpoint
}

function printable(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[\x21-\x7e]+$/.test(value)
  )
}

async function requestWithTimeout(
  request: typeof fetch,
  endpoint: URL,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, timeoutMs)
  try {
    return await request(endpoint, { ...init, signal: controller.signal })
  } catch {
    if (signal?.aborted) {
      throw new DeviceAuthorizationError('Amigospace connection cancelled')
    }
    throw new DeviceAuthorizationError('Amigospace identity service is unavailable')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

async function readJson(response: Response): Promise<JsonObject> {
  const maximumBytes = 128 * 1_024
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new DeviceAuthorizationError('Amigospace returned an invalid response')
  }
  if (response.body === null) {
    throw new DeviceAuthorizationError('Amigospace returned an invalid response')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new DeviceAuthorizationError(
          'Amigospace returned an invalid response',
        )
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString('utf8')
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('not an object')
    }
    return value as JsonObject
  } catch {
    throw new DeviceAuthorizationError('Amigospace returned an invalid response')
  }
}

async function defaultWait(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new DeviceAuthorizationError('Amigospace connection cancelled')
  }
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      cleanup()
      resolve()
    }
    const aborted = () => {
      cleanup()
      reject(new DeviceAuthorizationError('Amigospace connection cancelled'))
    }
    const timer = setTimeout(done, milliseconds)
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
    }
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted()
  })
}

export async function authorizeAmigospaceDevice(
  options: DeviceAuthorizationOptions,
): Promise<void> {
  if (!printable(options.clientId, 255)) {
    throw new Error('Amigospace OIDC client ID is invalid')
  }
  if (
    !Number.isInteger(options.requestTimeoutMs) ||
    options.requestTimeoutMs < 1_000 ||
    options.requestTimeoutMs > 30_000
  ) {
    throw new Error('Amigospace request timeout is invalid')
  }

  const request = options.fetch ?? fetch
  const wait = options.wait ?? defaultWait
  const deviceEndpoint = secureEndpoint(
    options.deviceAuthorizationEndpoint,
    'Amigospace device authorization endpoint',
  )
  const tokenEndpoint = secureEndpoint(
    options.tokenEndpoint,
    'Amigospace token endpoint',
  )

  const authorizationResponse = await requestWithTimeout(
    request,
    deviceEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: options.clientId,
        scope: options.scope,
      }),
      redirect: 'error',
    },
    options.requestTimeoutMs,
    options.signal,
  )
  const authorization = await readJson(authorizationResponse)
  if (!authorizationResponse.ok) {
    throw new DeviceAuthorizationError(
      'Amigospace rejected the device authorization request',
    )
  }
  if (
    !printable(authorization.device_code, 65_536) ||
    typeof authorization.user_code !== 'string' ||
    authorization.user_code.length < 1 ||
    authorization.user_code.length > 255 ||
    typeof authorization.verification_uri !== 'string' ||
    typeof authorization.expires_in !== 'number' ||
    !Number.isInteger(authorization.expires_in) ||
    authorization.expires_in < 1 ||
    authorization.expires_in > 86_400
  ) {
    throw new DeviceAuthorizationError('Amigospace returned an invalid response')
  }

  const verificationUri = secureEndpoint(
    authorization.verification_uri,
    'Amigospace verification URL',
  ).toString()
  const verificationUriComplete =
    typeof authorization.verification_uri_complete === 'string'
      ? secureEndpoint(
          authorization.verification_uri_complete,
          'Amigospace verification URL',
        ).toString()
      : undefined
  const expiresAtMs = Date.now() + authorization.expires_in * 1_000
  await options.present({
    userCode: authorization.user_code,
    verificationUri,
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    expiresAt: new Date(expiresAtMs).toISOString(),
  })

  let intervalMs =
    typeof authorization.interval === 'number' &&
    Number.isInteger(authorization.interval) &&
    authorization.interval >= 1 &&
    authorization.interval <= 60
      ? authorization.interval * 1_000
      : 5_000

  while (Date.now() < expiresAtMs) {
    await wait(Math.min(intervalMs, expiresAtMs - Date.now()), options.signal)
    if (Date.now() >= expiresAtMs) break

    const tokenResponse = await requestWithTimeout(
      request,
      tokenEndpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: options.clientId,
          device_code: authorization.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        redirect: 'error',
      },
      options.requestTimeoutMs,
      options.signal,
    )
    const token = await readJson(tokenResponse)

    if (tokenResponse.ok) {
      if (
        !printable(token.access_token, 32_768) ||
        !printable(token.refresh_token, 65_536) ||
        typeof token.expires_in !== 'number' ||
        !Number.isInteger(token.expires_in) ||
        token.expires_in < 1 ||
        token.expires_in > 86_400 ||
        typeof token.token_type !== 'string' ||
        token.token_type.toLowerCase() !== 'bearer'
      ) {
        throw new DeviceAuthorizationError(
          'Amigospace returned an invalid token response',
        )
      }
      await options.saveRefreshToken(token.refresh_token)
      return
    }

    switch (token.error) {
      case 'authorization_pending':
        break
      case 'slow_down':
        intervalMs += 5_000
        break
      case 'access_denied':
        throw new DeviceAuthorizationError('Amigospace connection was denied')
      case 'expired_token':
        throw new DeviceAuthorizationError('Amigospace connection code expired')
      default:
        if (
          tokenResponse.status === 408 ||
          tokenResponse.status === 425 ||
          tokenResponse.status === 429 ||
          tokenResponse.status >= 500
        ) {
          intervalMs += 5_000
          break
        }
        throw new DeviceAuthorizationError(
          'Amigospace rejected the device authorization request',
        )
    }
  }

  throw new DeviceAuthorizationError('Amigospace connection code expired')
}
