import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AmigospaceConnector,
  permitsAmigospace,
  withAmigospaceRoutingContext,
} from '../src/amigospace/connector.js'

const configuration = {
  enabled: true,
  endpoint: 'https://space.heyamigo.org/mcp',
  clientId: 'amigospace-device',
  tokenEndpoint:
    'https://identity.heyamigo.org/realms/amigospace/protocol/openid-connect/token',
  credentialFile: './storage/auth/amigospace/refresh-token',
  requestTimeoutMs: 4_000,
}

test('Amigospace is exposed only to an explicitly capable role', () => {
  assert.equal(permitsAmigospace(undefined), false)
  assert.equal(permitsAmigospace([]), false)
  assert.equal(permitsAmigospace(['Read']), false)
  assert.equal(permitsAmigospace(['mcp__amigospace__search']), true)
  assert.equal(permitsAmigospace(['mcp__amigospace__*']), true)
  assert.equal(permitsAmigospace('all'), true)
})

test('bundled connector uses the current Node runtime and cloud proxy', () => {
  const connector = new AmigospaceConnector(
    configuration,
    '/opt/heyamigo/scripts/amigospace-mcp.mjs',
  )

  assert.deepEqual(connector.commandFor('all'), {
    command: process.execPath,
    args: [
      '/opt/heyamigo/scripts/amigospace-mcp.mjs',
      '--endpoint',
      configuration.endpoint,
      '--client-id',
      configuration.clientId,
      '--token-endpoint',
      configuration.tokenEndpoint,
      '--credential-file',
      `${process.cwd()}/storage/auth/amigospace/refresh-token`,
      '--timeout-ms',
      '4000',
    ],
  })
  assert.equal(connector.commandFor([]), null)
})

test('disabled connector never reaches a provider', () => {
  const connector = new AmigospaceConnector(
    { ...configuration, enabled: false },
    '/opt/heyamigo/scripts/amigospace-mcp.mjs',
  )

  assert.equal(connector.commandFor('all'), null)
})

test('active connector adds a per-turn routing contract', () => {
  const input = 'Save this note for the website project.'
  const routed = withAmigospaceRoutingContext(input, true)

  assert.match(routed, /Amigospace MCP is connected/)
  assert.match(routed, /use the Amigospace tools directly in this turn/)
  assert.match(routed, /Never claim an Amigospace action succeeded/)
  assert.ok(routed.endsWith(input))
})

test('inactive connector leaves the user input untouched', () => {
  const input = 'Save this note locally.'
  assert.equal(withAmigospaceRoutingContext(input, false), input)
})
