import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import type { StoredRunEvent } from '../modules/run/run-types.ts'
import { streamRunEvents } from './workbench/conversation-routes.ts'

test('SSE reconnect forwards Last-Event-ID and emits only later persisted events', async () => {
  const response = new MemorySseResponse()
  const calls: Array<string | undefined> = []
  const resumedEvent: StoredRunEvent = {
    id: 'event-after-reconnect',
    tenantId: 'tenant-dsh-work',
    runId: 'run-reconnect',
    attemptId: 'attempt-reconnect',
    sequence: 2,
    eventType: 'run.failed',
    displayMessage: '服务重启后执行已终止',
    safeMetadata: { error_code: 'SERVICE_RESTARTED' },
    traceId: 'trace-reconnect',
    occurredAt: '2026-08-30T00:00:00.000Z',
  }
  let delivered = false
  const runs = {
    async readEventsAfterEvent(_tenantId: string, _runId: string, cursor?: string) {
      calls.push(cursor)
      if (!delivered) {
        delivered = true
        return [resumedEvent]
      }
      return []
    },
    async getRun() {
      return {
        id: 'run-reconnect', tenantId: 'tenant-dsh-work', sessionId: 'session-reconnect',
        requestedBy: 'U00001', idempotencyKey: 'idempotency-reconnect', status: 'failed' as const,
        currentAttemptId: 'attempt-reconnect', createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:01.000Z',
      }
    },
  }

  await streamRunEvents(response, 'event-before-disconnect', 'run-reconnect', runs, 1, 60_000)

  assert.equal(calls[0], 'event-before-disconnect')
  assert.match(response.body, /id: event-after-reconnect/)
  assert.match(response.body, /SERVICE_RESTARTED/)
  assert.doesNotMatch(response.body, /id: event-before-disconnect/)
  assert.equal(response.ended, true)
})

class MemorySseResponse extends EventEmitter {
  body = ''
  ended = false

  writeHead() { return this }
  flushHeaders() { return undefined }
  write(chunk: string) {
    this.body += chunk
    return true
  }
  end() {
    this.ended = true
    return this
  }
}

test('personal SSE stops before delivering the next batch after current access is revoked', { timeout: 2000 }, async () => {
  const response = new MemorySseResponse()
  let batches = 0, checks = 0
  const runs = {
    async readEventsAfterEvent() {
      batches++
      return [{ id: `event-${batches}`, tenantId: 'tenant-dsh-work', runId: 'run-personal',
        attemptId: 'attempt-personal', sequence: batches, eventType: 'assistant.delta' as const,
        displayMessage: `batch-${batches}`, safeMetadata: {}, traceId: 'trace-personal', occurredAt: new Date().toISOString() }]
    },
    async getRun() {
      return { id: 'run-personal', tenantId: 'tenant-dsh-work', sessionId: 'session-personal',
        requestedBy: 'U00001', idempotencyKey: 'id-personal', status: 'running' as const,
        currentAttemptId: 'attempt-personal', createdAt: '', updatedAt: '' }
    },
  }
  await streamRunEvents(response, undefined, 'run-personal', runs, 1, 60_000, undefined, async () => ++checks === 1)
  assert.match(response.body, /batch-1/)
  assert.doesNotMatch(response.body, /batch-2/)
  assert.equal(response.ended, true)
})
