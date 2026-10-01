import assert from 'node:assert/strict'
import { test } from 'node:test'
import { enforceReplyShape } from '../src/gateway/reply-shape.js'

test('drops a glued status sentence before the answer', () => {
  const raw =
    'The skill is in this prompt. I\'ll check whether that line is sent before the answer.**It is loaded.** Nothing enforces it.'
  assert.equal(
    enforceReplyShape(raw),
    '**It is loaded.** Nothing enforces it.',
  )
})

test('drops a leading I will sentence and keeps the answer', () => {
  assert.equal(
    enforceReplyShape("I'll check the registry. Main publishes. It does not bump."),
    'Main publishes. It does not bump.',
  )
})

test('leaves an answer that starts with the fact', () => {
  assert.equal(
    enforceReplyShape('**Main publishes.** It does not bump.'),
    '**Main publishes.** It does not bump.',
  )
})

test('drops a trailing let-me-know sentence', () => {
  assert.equal(
    enforceReplyShape('Main publishes. Let me know if you need anything else.'),
    'Main publishes.',
  )
})

test('keeps a reply that is only the announcement', () => {
  assert.equal(enforceReplyShape("I'll check."), "I'll check.")
})
