import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  mcpTokenConfigured,
  storeMcpToken,
} from '../src/amigospace/credentials.js'
import {
  authorizeAmigospaceDevice,
  type DeviceAuthorizationPrompt,
} from '../src/amigospace/device-auth.js'

test('device authorization returns one short-lived setup credential', async () => {
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'heyamigo-device-'))
  const credentialFile = join(credentialDirectory, 'mcp-token')
  let origin = ''
  let prompt: DeviceAuthorizationPrompt | undefined
  let tokenRequests = 0

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))

    if (request.method === 'POST' && request.url === '/device') {
      assert.equal(form.get('client_id'), 'amigospace-device')
      assert.equal(form.get('scope'), 'openid')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          device_code: 'private-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: `${origin}/verify`,
          verification_uri_complete: `${origin}/verify?user_code=ABCD-EFGH`,
          expires_in: 300,
          interval: 1,
        }),
      )
      return
    }

    if (request.method === 'POST' && request.url === '/token') {
      tokenRequests += 1
      assert.equal(form.get('client_id'), 'amigospace-device')
      assert.equal(form.get('device_code'), 'private-device-code')
      assert.equal(
        form.get('grant_type'),
        'urn:ietf:params:oauth:grant-type:device_code',
      )
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          access_token: 'short-lived-access-token',
          expires_in: 300,
          token_type: 'Bearer',
        }),
      )
      return
    }

    response.writeHead(404).end()
  })

  await new Promise<void>((resolvePromise) =>
    server.listen(0, '127.0.0.1', resolvePromise),
  )
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`

  try {
    assert.equal(await mcpTokenConfigured(credentialFile), false)
    const accessToken = await authorizeAmigospaceDevice({
      clientId: 'amigospace-device',
      deviceAuthorizationEndpoint: `${origin}/device`,
      tokenEndpoint: `${origin}/token`,
      scope: 'openid',
      requestTimeoutMs: 5_000,
      wait: async () => undefined,
      present: (value) => {
        prompt = value
      },
    })

    assert.equal(prompt?.userCode, 'ABCD-EFGH')
    assert.equal(prompt?.verificationUriComplete, `${origin}/verify?user_code=ABCD-EFGH`)
    assert.equal(tokenRequests, 1)
    assert.equal(accessToken, 'short-lived-access-token')
    await storeMcpToken(credentialFile, `amg_pat_${'A'.repeat(43)}`)
    assert.equal(await mcpTokenConfigured(credentialFile), true)
    assert.equal(
      await readFile(credentialFile, 'utf8'),
      `amg_pat_${'A'.repeat(43)}\n`,
    )
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) =>
      server.close((error) =>
        error ? rejectPromise(error) : resolvePromise(),
      ),
    )
    await rm(credentialDirectory, { recursive: true, force: true })
  }
})
