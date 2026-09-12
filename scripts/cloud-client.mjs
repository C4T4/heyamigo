// Authenticated outbound transport for the portable Client. No model or outbound-channel loop.
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { checkState } from './portable-client.mjs'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const connectionName = 'cloud-connection.json'

export function validateCloudUrl(raw, env = {}) {
  const url = new URL(raw)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  const dockerLocal =
    env.AMIGO_ALLOW_LOCAL_DOCKER_CLOUD === '1' && url.hostname === 'host.docker.internal'
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || dockerLocal))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Use an HTTPS Cloud origin, or an explicit local development endpoint.')
  return url.origin
}

function validateConnection(value, state, env) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'agentId,cloudUrl,expiresAt,protocolVersion,token,workspaceId' ||
    value.protocolVersion !== 1 ||
    value.workspaceId !== state.identity.workspaceId ||
    value.agentId !== state.identity.agentId ||
    typeof value.token !== 'string' ||
    !/^amigo_client_[A-Za-z0-9_-]{43}$/.test(value.token) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    throw new Error(
      'The connection file must belong to this company and Amigo and use protocol version 1.',
    )
  return { ...value, cloudUrl: validateCloudUrl(value.cloudUrl, env) }
}

async function privateJson(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 8192)
    throw new Error('Connection files must be owner-only regular files smaller than 8 KB.')
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The connection file is not valid JSON.')
    throw error
  }
}

export async function configureCloud(env, source) {
  const state = await checkState(env)
  const value = validateConnection(await privateJson(resolve(source)), state, env)
  const file = join(state.root, connectionName)
  try {
    const old = await privateJson(file)
    if (old.token === value.token && old.cloudUrl === value.cloudUrl) return
    throw new Error(
      'A Cloud connection is already configured. Revoke it in Cloud and remove its local connection file before replacing it.',
    )
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  // Exclusive creation prevents two setup processes silently replacing credentials.
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

export async function loadCloudConnection(env) {
  const state = await checkState(env)
  return validateConnection(await privateJson(join(state.root, connectionName)), state, env)
}

class CloudError extends Error {
  constructor(status) {
    super(`Cloud connection request failed (${status}).`)
    this.status = status
  }
}

export async function requestCloud(connection, route, body, signal, http = fetch) {
  const response = await http(new URL(`/client/v1/${route}`, connection.cloudUrl), {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${connection.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new CloudError(response.status)
  }
  const reader = response.body.getReader()
  let bytes = 0,
    chunks = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > 32768) throw new Error('Cloud returned an oversized response.')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function runtimeCheck(env, signal) {
  await checkState(env)
  let browser = 'disabled'
  if (env.AMIGO_BROWSER_ENABLED === '1') {
    browser = 'unavailable'
    const until = Date.now() + 5000
    do {
      try {
        const response = await fetch('http://127.0.0.1:9222/json/version', {
          redirect: 'error',
          signal: AbortSignal.any([AbortSignal.timeout(800), signal]),
        })
        if (response.ok) {
          const value = await response.json()
          const endpoint = new URL(value.webSocketDebuggerUrl)
          if (
            endpoint.protocol === 'ws:' &&
            endpoint.hostname === '127.0.0.1' &&
            endpoint.port === '9222'
          ) {
            browser = 'ready'
            break
          }
        }
      } catch {
        if (signal.aborted) throw signal.reason
      }
      await delay(150, undefined, { signal })
    } while (Date.now() < until)
  }
  return {
    state: 'valid',
    mode: 'cloud',
    browser,
    whatsapp: 'not_connected',
    telegram: 'not_connected',
    externalActions: 0,
  }
}

export async function runCloudClient(
  env,
  { signal, log = (value) => console.log(JSON.stringify(value)), http = fetch } = {},
) {
  const connection = await loadCloudConnection(env)
  const instanceId = randomUUID()
  const stop = signal ?? new AbortController().signal
  const request = (route, body, activeSignal = stop) =>
    requestCloud(connection, route, body, activeSignal, http)
  let session,
    pending,
    failures = 0
  try {
    while (!stop.aborted) {
      try {
        if (!session) {
          const hello = await request('connect', {
            protocolVersion: 1,
            instanceId,
            clientVersion: 'portable-1',
          })
          if (
            hello.protocolVersion !== 1 ||
            hello.workspaceId !== connection.workspaceId ||
            hello.agentId !== connection.agentId ||
            !Number.isInteger(hello.generation) ||
            hello.generation < 1
          )
            throw new Error('Cloud returned an unexpected Amigo identity or protocol.')
          session = { instanceId, generation: hello.generation }
          log({ status: 'connected', workspaceId: hello.workspaceId, agentId: hello.agentId })
        }
        // Retain a result in memory until Cloud acknowledges it. After a process crash,
        // the server can safely retry this read-only check with a new task lease.
        if (pending) {
          try {
            await request('results', { ...session, ...pending })
            log({ status: 'check_completed', taskId: pending.taskId })
            pending = undefined
          } catch (error) {
            if (error.status === 409) {
              pending = undefined
              log({ status: 'check_cancelled' })
            } else throw error
          }
        }
        const response = await request('poll', session)
        if (typeof response.paused !== 'boolean' || !Object.hasOwn(response, 'task'))
          throw new Error('Invalid Cloud poll response.')
        if (response.task) {
          const task = response.task
          if (
            response.paused ||
            task.kind !== 'runtime_check' ||
            !uuid.test(task.id) ||
            !uuid.test(task.leaseId)
          )
            throw new Error('Cloud requested an unsupported or invalid task.')
          pending = {
            taskId: task.id,
            leaseId: task.leaseId,
            result: await runtimeCheck(env, stop),
          }
          continue
        }
        failures = 0
        await delay(10000, undefined, { signal: stop })
      } catch (error) {
        if (stop.aborted) break
        if (
          error instanceof CloudError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429
        )
          throw error
        if (
          !(error instanceof CloudError) &&
          !(error instanceof TypeError) &&
          error.name !== 'TimeoutError'
        )
          throw error
        // No work is executed while disconnected. Reclaiming the same instance after
        // a server outage produces a new generation when its old lease expired.
        session = undefined
        pending = undefined
        failures++
        log({ status: 'reconnecting' })
        await delay(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)), undefined, {
          signal: stop,
        }).catch((error) => {
          if (!stop.aborted) throw error
        })
      }
    }
  } finally {
    if (session) await request('disconnect', session, AbortSignal.timeout(2000)).catch(() => {})
    log({ status: 'disconnected' })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077)
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  runCloudClient(process.env, { signal: controller.signal }).catch((error) => {
    console.error(
      error instanceof CloudError
        ? error.message
        : 'Cloud Client stopped because its connection or runtime could not be validated.',
    )
    process.exitCode = 1
  })
}
