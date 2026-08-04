import WebSocket from 'ws'

export type BrowserCdpIdentity = {
  browser: string
  protocolVersion: string
  userAgent: string
  webSocketDebuggerUrl: string
}

export class BrowserCdpUnavailableError extends Error {
  constructor(
    public readonly cdpUrl: string,
    message: string,
  ) {
    super(`Shared browser CDP unavailable at ${cdpUrl}: ${message}`)
    this.name = 'BrowserCdpUnavailableError'
  }
}

function versionUrl(cdpUrl: string): URL {
  const url = new URL(cdpUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserCdpUnavailableError(
      cdpUrl,
      `expected an http(s) URL, got ${url.protocol}`,
    )
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/json/version`
  url.search = ''
  url.hash = ''
  return url
}

function asIdentity(cdpUrl: string, value: unknown): BrowserCdpIdentity {
  if (!value || typeof value !== 'object') {
    throw new BrowserCdpUnavailableError(cdpUrl, '/json/version returned invalid JSON')
  }
  const row = value as Record<string, unknown>
  const browser = row.Browser
  const protocolVersion = row['Protocol-Version']
  const userAgent = row['User-Agent']
  const webSocketDebuggerUrl = row.webSocketDebuggerUrl
  if (
    typeof browser !== 'string' ||
    typeof protocolVersion !== 'string' ||
    typeof userAgent !== 'string' ||
    typeof webSocketDebuggerUrl !== 'string'
  ) {
    throw new BrowserCdpUnavailableError(
      cdpUrl,
      '/json/version is missing Browser, Protocol-Version, User-Agent, or webSocketDebuggerUrl',
    )
  }
  const wsUrl = new URL(webSocketDebuggerUrl)
  if (wsUrl.protocol !== 'ws:' && wsUrl.protocol !== 'wss:') {
    throw new BrowserCdpUnavailableError(
      cdpUrl,
      `invalid webSocketDebuggerUrl protocol ${wsUrl.protocol}`,
    )
  }
  return { browser, protocolVersion, userAgent, webSocketDebuggerUrl }
}

function probeBrowserSocket(
  cdpUrl: string,
  webSocketDebuggerUrl: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const socket = new WebSocket(webSocketDebuggerUrl, { handshakeTimeout: timeoutMs })
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      try { socket.close() } catch {}
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => {
      finish(new BrowserCdpUnavailableError(cdpUrl, `CDP handshake timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()

    socket.once('error', (err) => {
      finish(new BrowserCdpUnavailableError(cdpUrl, `WebSocket attach failed: ${err.message}`))
    })
    socket.once('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }))
    })
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as {
          id?: number
          result?: unknown
          error?: { message?: string }
        }
        if (message.id !== 1) return
        if (message.error) {
          finish(
            new BrowserCdpUnavailableError(
              cdpUrl,
              `Browser.getVersion failed: ${message.error.message ?? 'unknown CDP error'}`,
            ),
          )
          return
        }
        if (!message.result) {
          finish(new BrowserCdpUnavailableError(cdpUrl, 'Browser.getVersion returned no result'))
          return
        }
        finish()
      } catch (err) {
        finish(
          new BrowserCdpUnavailableError(
            cdpUrl,
            `invalid CDP response: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      }
    })
  })
}

function attachUrl(cdpUrl: string, advertisedUrl: string): string {
  const endpoint = new URL(cdpUrl)
  const socket = new URL(advertisedUrl)
  // Chrome sometimes advertises `localhost` while the configured endpoint is
  // `127.0.0.1` (or vice versa). Keep Chrome's browser target path but force
  // the actual network destination to the configured endpoint.
  socket.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  socket.hostname = endpoint.hostname
  socket.port = endpoint.port
  return socket.toString()
}

// This is intentionally stronger than a TCP or /json/version check: it opens
// Chrome's browser-level WebSocket and executes a real CDP command. Browser
// workers call it before claiming work, so a broken endpoint cannot consume an
// expensive provider run or be mistaken for a website/login failure.
export async function assertBrowserCdpReady(
  cdpUrl: string,
  timeoutMs: number,
): Promise<BrowserCdpIdentity> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref()
  let response: Response
  try {
    response = await fetch(versionUrl(cdpUrl), {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'application/json' },
    })
  } catch (err) {
    const reason = (err as Error).name === 'AbortError'
      ? `health check timed out after ${timeoutMs}ms`
      : err instanceof Error ? err.message : String(err)
    throw new BrowserCdpUnavailableError(cdpUrl, reason)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    throw new BrowserCdpUnavailableError(
      cdpUrl,
      `/json/version returned HTTP ${response.status}`,
    )
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (err) {
    throw new BrowserCdpUnavailableError(
      cdpUrl,
      `could not parse /json/version: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const identity = asIdentity(cdpUrl, payload)
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt))
  await probeBrowserSocket(
    cdpUrl,
    attachUrl(cdpUrl, identity.webSocketDebuggerUrl),
    remainingMs,
  )
  return identity
}
