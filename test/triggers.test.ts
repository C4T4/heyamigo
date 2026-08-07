import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isBareAliasInvocation } from '../src/gateway/trigger-alias.js'

const aliases = ['claude', 'amigo']

test('recognizes name-only trigger pings', () => {
  assert.equal(isBareAliasInvocation('claude', aliases), true)
  assert.equal(isBareAliasInvocation('  Claude?!  ', aliases), true)
  assert.equal(isBareAliasInvocation('@claude', aliases), true)
})

test('does not swallow real requests containing an alias', () => {
  assert.equal(isBareAliasInvocation('claude mf', aliases), false)
  assert.equal(isBareAliasInvocation('claude draft a message', aliases), false)
  assert.equal(isBareAliasInvocation('hey claude', aliases), false)
})
