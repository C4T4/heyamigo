import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isStaleSessionError } from '../src/ai/session-errors.js'

test('recognizes invalid Gemini session identifiers', () => {
  assert.equal(isStaleSessionError(
    new Error('Error resuming session: Invalid session identifier "abc".'),
  ), true)
})

test('recognizes resumed sessions that exceed the model context limit', () => {
  assert.equal(isStaleSessionError(
    new Error('The input token count exceeds the maximum number of tokens.'),
  ), true)
})

test('recognizes Gemini thought-only responses as stale sessions', () => {
  assert.equal(isStaleSessionError(
    new Error('gemini returned empty response text'),
  ), true)
})

test('does not discard sessions for unrelated provider failures', () => {
  assert.equal(isStaleSessionError(
    new Error('Authentication failed'),
  ), false)
})
