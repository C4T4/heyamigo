import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error The standalone runtime is also shipped directly as a JavaScript CLI.
import {
  filterOpenedSources,
  normalizedUrl,
  verifiedLearning,
  boundedAssignedSkills,
} from '../scripts/opportunity-runtime.mjs'
import { randomUUID } from 'node:crypto'

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

test('a learned procedure needs a successful observed result and cannot claim an unsupported task', () => {
  const procedure = {
    taskType: 'opportunity_research',
    name: 'Research current requests',
    description: 'Find a published request relevant to the company mission.',
    instructions:
      'Read the assigned project. Search for a current request. Open the primary evidence and verify its fit before saving an opportunity.',
  }
  const opportunities = [{ sources: [{ url: 'https://example.com/request#details' }] }]
  assert.equal(verifiedLearning(procedure, [], new Set()), undefined)
  assert.equal(verifiedLearning(procedure, opportunities, new Set()), undefined)
  assert.equal(
    verifiedLearning(
      { ...procedure, taskType: 'create_google_account' },
      opportunities,
      new Set(['https://example.com/request']),
    ),
    undefined,
  )
  assert.equal(
    verifiedLearning(
      { ...procedure, claimedSuccess: true },
      opportunities,
      new Set(['https://example.com/request']),
    ),
    undefined,
  )
  assert.equal(
    verifiedLearning(
      { ...procedure, instructions: 'Bearer ' + 'a'.repeat(40) },
      opportunities,
      new Set(['https://example.com/request']),
    ),
    undefined,
  )
  assert.deepEqual(
    verifiedLearning(procedure, opportunities, new Set(['https://example.com/request'])),
    {
      verifier: 'heyamigo-opened-sources-v1',
      openedUrls: ['https://example.com/request'],
      procedure,
    },
  )
})

test('assigned skills keep an explicit bounded version and cannot inject extra runtime configuration', () => {
  const skill = {
    skillId: randomUUID(),
    revision: 1,
    name: 'Research',
    description: 'A reusable method',
    instructions: 'Use only the authorized research tools.',
    contentHash: 'a'.repeat(64),
    tools: ['shell'],
  }
  assert.deepEqual(Object.keys(boundedAssignedSkills([skill])[0]).sort(), [
    'contentHash',
    'description',
    'instructions',
    'name',
    'revision',
    'skillId',
  ])
  assert.throws(() => boundedAssignedSkills(Array(9).fill(skill)), /limit/)
  assert.throws(
    () => boundedAssignedSkills([{ ...skill, skillId: '../other-company' }]),
    /Invalid/,
  )
  assert.throws(
    () =>
      boundedAssignedSkills(Array(3).fill({ ...skill, instructions: 'a'.repeat(10000) })),
    /limit/,
  )
})
