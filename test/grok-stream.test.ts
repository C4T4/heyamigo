import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assembleGrokStreamReply } from '../src/ai/grok-stream.js'

test('keeps only the text after the last tool call', () => {
  const stdout = [
    '{"type":"text","data":"I\'ll run that command now."}',
    '{"type":"tool_call","toolName":"run_terminal_command"}',
    '{"type":"tool_call_update","status":"completed"}',
    '{"type":"text","data":"AFTER"}',
    '{"type":"end","sessionId":"abc","stopReason":"end_turn"}',
  ].join('\n')
  assert.equal(assembleGrokStreamReply(stdout), 'AFTER')
})

test('keeps the earlier text when nothing follows the tool', () => {
  const stdout = [
    '{"type":"text","data":"The answer is 4."}',
    '{"type":"tool_call","toolName":"run_terminal_command"}',
    '{"type":"end"}',
  ].join('\n')
  assert.equal(assembleGrokStreamReply(stdout), 'The answer is 4.')
})

test('joins text chunks when there is no tool call', () => {
  const stdout = [
    '{"type":"text","data":"PO"}',
    '{"type":"text","data":"NG"}',
    '{"type":"end"}',
  ].join('\n')
  assert.equal(assembleGrokStreamReply(stdout), 'PONG')
})
