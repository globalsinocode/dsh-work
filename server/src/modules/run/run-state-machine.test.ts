import assert from 'node:assert/strict'
import test from 'node:test'

import { assertAttemptTransition, assertRunTransition, isAttemptTerminalState, isRunTerminalState } from './run-state-machine.ts'

test('run state machine accepts the happy path and cancellation path', () => {
  assert.doesNotThrow(() => assertRunTransition('queued', 'running'))
  assert.doesNotThrow(() => assertRunTransition('running', 'succeeded'))
  assert.doesNotThrow(() => assertRunTransition('running', 'cancel_requested'))
  assert.doesNotThrow(() => assertRunTransition('running', 'waiting'))
  assert.doesNotThrow(() => assertRunTransition('waiting', 'queued'))
  assert.doesNotThrow(() => assertRunTransition('cancel_requested', 'cancelled'))
})

test('terminal run states cannot move backwards', () => {
  for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
    assert.equal(isRunTerminalState(state), true)
    assert.throws(() => assertRunTransition(state, 'running'), /非法 Run 状态转换/)
  }
})

test('waiting is terminal for an Attempt but resumable for its Run', () => {
  assert.equal(isRunTerminalState('waiting'), false)
  assert.equal(isAttemptTerminalState('waiting'), true)
  assert.doesNotThrow(() => assertRunTransition('waiting', 'queued'))
  assert.throws(() => assertAttemptTransition('waiting', 'running'), /非法 Attempt 状态转换/)
})
