import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error The standalone runtime is also shipped directly as a JavaScript CLI.
import { filterOpenedSources, normalizedUrl } from '../scripts/opportunity-runtime.mjs'

test('opportunities require at least one actually opened public HTTPS source', () => {
  const opened = new Set(['https://example.com/request'])
  const results = filterOpenedSources(
    [
      {
        name: 'Observed',
        sources: [
          { url: 'https://example.com/request#details', title: 'Request' },
          { url: 'https://invented.example/', title: 'Invented' },
        ],
      },
      {
        name: 'Unverified',
        sources: [{ url: 'https://invented.example/', title: 'Invented' }],
      },
    ],
    opened,
  )
  assert.equal(results.length, 1)
  assert.equal(results[0].name, 'Observed')
  assert.equal(results[0].sources.length, 1)
})

test('source links cannot contain credentials or use executable and insecure protocols', () => {
  assert.equal(normalizedUrl('javascript:alert(1)'), null)
  assert.equal(normalizedUrl('http://example.com/'), null)
  assert.equal(normalizedUrl('https://secret@example.com/'), null)
  assert.equal(
    normalizedUrl('https://example.com/request#details'),
    'https://example.com/request',
  )
})

test('malformed and missing sources never become successful opportunity records', () => {
  assert.deepEqual(filterOpenedSources(null, new Set()), [])
  assert.deepEqual(
    filterOpenedSources([null, {}, { sources: 'not an array' }], new Set()),
    [],
  )
})
