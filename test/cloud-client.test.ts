import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rename, rm, chmod, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openState } from '../scripts/portable-client.mjs'
import {
  configureCloud,
  loadCloudConnection,
  validateCloudUrl,
  runCloudClient,
  requestCloud,
} from '../scripts/cloud-client.mjs'

async function fixture(fn: any) {
  const directory = await mkdtemp(join(tmpdir(), 'cloud-client-test-'))
  const env = {
    AMIGO_STATE_DIR: join(directory, 'state'),
    AMIGO_WORKSPACE_ID: randomUUID(),
    AMIGO_AGENT_ID: randomUUID(),
  }
  await openState(env, true)
  const connection = {
    protocolVersion: 1,
    cloudUrl: 'http://127.0.0.1:4300',
    workspaceId: env.AMIGO_WORKSPACE_ID,
    agentId: env.AMIGO_AGENT_ID,
    token: `amigo_client_${randomBytes(32).toString('base64url')}`,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  }
  const file = join(directory, 'connection.json')
  await writeFile(file, JSON.stringify(connection), { mode: 0o600 })
  try {
    await fn({ directory, env, connection, file })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
test('a configured Cloud identity and secret remain private and survive volume relocation', async () => {
  await fixture(async ({ directory, env, connection, file }: any) => {
    await configureCloud(env, file)
    assert.deepEqual(await loadCloudConnection(env), connection)
    await configureCloud(env, file)
    const moved = join(directory, 'moved')
    await rename(env.AMIGO_STATE_DIR, moved)
    assert.deepEqual(await loadCloudConnection({ ...env, AMIGO_STATE_DIR: moved }), connection)
    await assert.rejects(
      loadCloudConnection({ ...env, AMIGO_STATE_DIR: moved, AMIGO_AGENT_ID: randomUUID() }),
      /different Amigo/,
    )
  })
})
test('connection import rejects foreign bindings, unsafe URLs, symlinks and exposed credential files', async () => {
  await fixture(async ({ directory, env, connection, file }: any) => {
    await writeFile(file, JSON.stringify({ ...connection, agentId: randomUUID() }))
    await assert.rejects(configureCloud(env, file), /belong/)
    await writeFile(file, JSON.stringify(connection))
    await chmod(file, 0o644)
    await assert.rejects(configureCloud(env, file), /owner-only/)
    await chmod(file, 0o600)
    const link = join(directory, 'link')
    await symlink(file, link)
    await assert.rejects(configureCloud(env, link), /owner-only/)
    for (const cloudUrl of [
      'http://example.com',
      'https://user:pass@example.com',
      'https://example.com/path',
      'https://example.com/?token=x',
      'file:///tmp/cloud',
    ]) {
      await writeFile(file, JSON.stringify({ ...connection, cloudUrl }))
      await assert.rejects(configureCloud(env, file), /HTTPS Cloud origin/)
    }
    assert.equal(validateCloudUrl('https://cloud.example.com'), 'https://cloud.example.com')
    assert.throws(() => validateCloudUrl('http://host.docker.internal:4300'), /HTTPS/)
    assert.equal(
      validateCloudUrl('http://host.docker.internal:4300', { AMIGO_ALLOW_LOCAL_DOCKER_CLOUD: '1' }),
      'http://host.docker.internal:4300',
    )
  })
})
test('transport executes a bounded check, acknowledges it and stops after revocation without logging secrets', async () => {
  await fixture(async ({ env, connection, file }: any) => {
    await configureCloud(env, file)
    const taskId = randomUUID(),
      leaseId = randomUUID(),
      calls: any[] = [],
      logs: any[] = []
    let polls = 0
    const http = async (url: URL, init: any) => {
      assert.equal(init.redirect, 'error')
      assert.equal(init.headers.authorization, `Bearer ${connection.token}`)
      const body = JSON.parse(init.body)
      calls.push({ path: url.pathname, body })
      if (url.pathname.endsWith('/connect'))
        return Response.json({
          protocolVersion: 1,
          workspaceId: connection.workspaceId,
          agentId: connection.agentId,
          generation: 1,
        })
      if (url.pathname.endsWith('/poll')) {
        polls++
        return polls === 1
          ? Response.json({ paused: false, task: { id: taskId, leaseId, kind: 'runtime_check' } })
          : Response.json({ error: 'revoked' }, { status: 401 })
      }
      if (url.pathname.endsWith('/results')) return Response.json({ accepted: true, reused: false })
      return Response.json({ disconnected: true })
    }
    await assert.rejects(
      runCloudClient(env, { http, log: (entry: any) => logs.push(entry) }),
      /401/,
    )
    const completed = calls.find((c) => c.path.endsWith('/results'))
    assert.equal(completed.body.taskId, taskId)
    assert.deepEqual(completed.body.result, {
      state: 'valid',
      mode: 'cloud',
      browser: 'disabled',
      whatsapp: 'not_connected',
      telegram: 'not_connected',
      externalActions: 0,
    })
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(connection.token))
    assert.equal(logs.at(-1).status, 'disconnected')
  })
})
test('a mismatched server identity and oversized responses cannot dispatch work', async () => {
  await fixture(async ({ env, connection, file }: any) => {
    await configureCloud(env, file)
    await assert.rejects(
      runCloudClient(env, {
        log: () => {},
        http: async () =>
          Response.json({
            protocolVersion: 1,
            workspaceId: randomUUID(),
            agentId: connection.agentId,
            generation: 1,
          }),
      }),
      /unexpected Amigo/,
    )
    await assert.rejects(
      requestCloud(
        connection,
        'connect',
        {},
        undefined,
        async () => new Response('x'.repeat(40000)),
      ),
      /oversized/,
    )
  })
})
