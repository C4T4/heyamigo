import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseGeminiOutput,
  requireGeminiTextReply,
} from '../src/ai/gemini-output.js'

test('parses Gemini JSON sessions and aggregates per-model usage', () => {
  const result = parseGeminiOutput(JSON.stringify({
    session_id: 'gemini-session-1',
    response: 'Done.',
    stats: {
      models: {
        primary: {
          tokens: { input: 80, prompt: 100, cached: 20, candidates: 12 },
        },
        fallback: {
          tokens: { prompt: 50, cached: 10, candidates: 8 },
        },
      },
    },
  }))

  assert.deepEqual(result, {
    reply: 'Done.',
    sessionId: 'gemini-session-1',
    usage: {
      inputTokens: 120,
      cacheReadTokens: 30,
      cacheCreationTokens: 0,
      outputTokens: 20,
      numTurns: 0,
    },
  })
})

test('throws a structured Gemini JSON error', () => {
  assert.throws(
    () => parseGeminiOutput(JSON.stringify({
      session_id: 'gemini-session-2',
      error: {
        type: 'ProjectIdRequiredError',
        message: 'Set GOOGLE_CLOUD_PROJECT.',
        code: 1,
      },
    })),
    /ProjectIdRequiredError \(1\): Set GOOGLE_CLOUD_PROJECT\./,
  )
})

test('parses Gemini stream-json as a defensive fallback', () => {
  const result = parseGeminiOutput([
    JSON.stringify({ type: 'init', session_id: 'stream-session' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'Hel', delta: true }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'lo', delta: true }),
    JSON.stringify({
      type: 'result',
      status: 'success',
      stats: { input_tokens: 100, cached: 25, output_tokens: 4 },
    }),
  ].join('\n'))

  assert.deepEqual(result, {
    reply: 'Hello',
    sessionId: 'stream-session',
    usage: {
      inputTokens: 75,
      cacheReadTokens: 25,
      cacheCreationTokens: 0,
      outputTokens: 4,
      numTurns: 0,
    },
  })
})

test('returns null for non-JSON output', () => {
  assert.equal(parseGeminiOutput('plain text'), null)
})

test('accepts a successful tool-only response with no text', () => {
  assert.deepEqual(parseGeminiOutput(JSON.stringify({
    session_id: 'tool-only-session',
    response: '',
    stats: { models: {} },
  })), {
    reply: '',
    sessionId: 'tool-only-session',
    usage: {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      numTurns: 0,
    },
  })
})

test('rejects an empty Gemini result when a chat reply is required', () => {
  const result = parseGeminiOutput(JSON.stringify({
    session_id: 'thought-only-session',
    response: '',
    stats: {
      models: {
        primary: { tokens: { candidates: 8_220 } },
      },
    },
  }))

  assert.ok(result)
  assert.throws(
    () => requireGeminiTextReply(result),
    /gemini returned empty response text/,
  )
})
