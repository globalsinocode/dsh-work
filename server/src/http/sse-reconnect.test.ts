import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { authorizationDenied } from '../modules/authorization/authorization-errors.ts'
import type { StoredRunEvent } from '../modules/run/run-types.ts'
import { streamRunEvents, streamWorkspaceSessionEvents } from './workbench/conversation-routes.ts'

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

// ---------------------------------------------------------------------------
// TW-10 空间会话活动流（streamWorkspaceSessionEvents）
// ---------------------------------------------------------------------------

test('workspace session stream stays silent while activity markers are unchanged', async () => {
  const response = new MemorySseResponse()
  const activityAt = new Date('2026-09-12T08:00:00Z')
  let polls = 0
  const conversations = {
    async listWorkspaceSessionActivity() {
      if (++polls === 3) response.emit('close')
      return [{ sessionId: 's-1', activityAt }]
    },
  }

  await streamWorkspaceSessionEvents(response, 'ws-team', conversations, 1, 60_000)

  // 首轮只建立基线、后续无变化：一条事件都不该写。
  assert.equal(response.body, '')
})

test('workspace session stream emits session.updated on activity and session.archived on removal', async () => {
  const response = new MemorySseResponse()
  const at1 = new Date('2026-09-12T08:00:00Z')
  const at2 = new Date('2026-09-12T08:01:00Z')
  let polls = 0
  const conversations = {
    async listWorkspaceSessionActivity() {
      polls += 1
      if (polls === 1) return [{ sessionId: 's-1', activityAt: at1 }]
      if (polls === 2) return [{ sessionId: 's-1', activityAt: at2 }, { sessionId: 's-2', activityAt: at1 }]
      if (polls === 3) return [{ sessionId: 's-1', activityAt: at2 }]
      response.emit('close')
      return [{ sessionId: 's-1', activityAt: at2 }]
    },
  }

  await streamWorkspaceSessionEvents(response, 'ws-team', conversations, 1, 60_000)

  assert.match(response.body, /event: session\.updated\ndata: \{"session_id":"s-1","activity_at":"2026-09-12T08:01:00\.000Z"\}/)
  assert.match(response.body, /event: session\.updated\ndata: \{"session_id":"s-2"/)
  assert.match(response.body, /event: session\.archived\ndata: \{"session_id":"s-2"\}/)
})

test('workspace session stream stops before delivering after read access is revoked', { timeout: 2000 }, async () => {
  const response = new MemorySseResponse()
  const at1 = new Date('2026-09-12T08:00:00Z')
  const at2 = new Date('2026-09-12T08:01:00Z')
  let polls = 0
  const conversations = {
    async listWorkspaceSessionActivity() {
      polls += 1
      return [{ sessionId: 's-1', activityAt: polls >= 2 ? at2 : at1 }]
    },
  }
  const teamAccess = {
    workspaceId: 'ws-team',
    userId: 'u-revoked',
    authorization: {
      async readableWorkspaceTypeOf() { return 'team' as const },
      async authorizeTeamReadAccess() { throw authorizationDenied('已被移出空间') },
    },
  }

  await streamWorkspaceSessionEvents(response, 'ws-team', conversations, 1, 60_000, teamAccess)

  // 第二轮检测到变化但读轨已失权：断流，变化批次不得写出。
  assert.equal(response.body, '')
  assert.equal(response.ended, true)
})
