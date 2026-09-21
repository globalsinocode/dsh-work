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
        id: 'run-reconnect', tenantId: 'tenant-dsh-work', taskId: 'task-reconnect', sessionId: 'session-reconnect',
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
      return { id: 'run-personal', tenantId: 'tenant-dsh-work', taskId: 'task-personal', sessionId: 'session-personal',
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
      return { sessions: [{ sessionId: 's-1', activityAt }] }
    },
    async listRecentlyArchivedSessionIds() {
      return { ids: [], truncated: false }
    },
    async listArchivedSessionIdsAmong() {
      return []
    },
    async listArchivedSessionIds() {
      return { ids: [], truncated: false }
    },
  }

  await streamWorkspaceSessionEvents(response, 'ws-team', conversations, 1, 60_000)

  // 首轮建立基线后仅发 resync 控制握手（四审），无任何内容事件。
  assert.equal(response.body, 'event: session.resync\ndata: {"reason":"baseline"}\n\n')
})

test('workspace session stream emits session.updated on activity and session.archived on removal', async () => {
  const response = new MemorySseResponse()
  const at1 = new Date('2026-09-12T08:00:00Z')
  const at2 = new Date('2026-09-12T08:01:00Z')
  let polls = 0
  const conversations = {
    async listWorkspaceSessionActivity() {
      polls += 1
      if (polls === 1) return { sessions: [{ sessionId: 's-1', activityAt: at1 }] }
      if (polls === 2) return { sessions: [{ sessionId: 's-1', activityAt: at2 }, { sessionId: 's-2', activityAt: at1 }] }
      if (polls === 3) return { sessions: [{ sessionId: 's-1', activityAt: at2 }] }
      response.emit('close')
      return { sessions: [{ sessionId: 's-1', activityAt: at2 }] }
    },
    async listRecentlyArchivedSessionIds() {
      return { ids: [], truncated: false }
    },
    async listArchivedSessionIdsAmong(_workspaceId: string, ids: string[]) {
      // s-2 在第 3 轮起归档（曾活跃 → 消失 → 直接复核命中）。
      return polls >= 3 ? ids.filter(id => id === 's-2') : []
    },
    async listArchivedSessionIds() {
      return { ids: polls >= 3 ? ['s-2'] : [], truncated: false }
    },
  }

  await streamWorkspaceSessionEvents(response, 'ws-team', conversations, 1, 60_000)

  assert.match(response.body, /event: session\.updated\ndata: \{"session_id":"s-1","activity_at":"2026-09-12T08:01:00\.000Z"\}/)
  assert.match(response.body, /event: session\.updated\ndata: \{"session_id":"s-2"/)
  assert.match(response.body, /event: session\.archived\ndata: \{"session_id":"s-2"\}/)
})

test('workspace session stream still reports archive after the session left the active window', async () => {
  // 评审中4：会话先被挤出活跃窗口（第 2 轮消失但未归档，不得误报），
  // 之后才归档（第 3 轮进入归档增量集，必须补发 session.archived）。
  const response = new MemorySseResponse()
  const at1 = new Date('2026-09-12T08:00:00Z')
  let polls = 0
  const conversations = {
    async listWorkspaceSessionActivity() {
      polls += 1
      if (polls === 1) return { sessions: [{ sessionId: 's-old', activityAt: at1 }] }
      if (polls === 4) response.emit('close')
      return { sessions: [] }
    },
    async listRecentlyArchivedSessionIds() {
      return { ids: [], truncated: false }
    },
    async listArchivedSessionIdsAmong(_workspaceId: string, ids: string[]) {
      return polls >= 3 ? ids.filter(id => id === 's-old') : []
    },
    async listArchivedSessionIds() {
      return { ids: polls >= 3 ? ['s-old'] : [], truncated: false }
    },
  }

  await streamWorkspaceSessionEvents(response, 'ws-team', conversations, 1, 60_000)

  assert.match(response.body, /event: session\.archived\ndata: \{"session_id":"s-old"\}/)
})

test('workspace session stream backfills pre-connect archives only when client since watermark is given', async () => {
  // 二审残留：会话在「客户端首拉列表」与「SSE 建连」之间归档——它不在活跃
  // 集、也不在 archived_since(流起点) 集合，不带水位线时客户端永远不知道。
  const at1 = new Date('2026-09-12T08:00:00Z')

  // 无水位线：归档增量从流起点起算，建流前已归档的 s-gone 不补推（基线静默）。
  {
    const response = new MemorySseResponse()
    let polls = 0
    const conversations = {
      async listWorkspaceSessionActivity() {
        if (++polls === 3) response.emit('close')
        return { sessions: [{ sessionId: 's-live', activityAt: at1 }] }
      },
      async listRecentlyArchivedSessionIds(_workspaceId: string, since: Date) {
        // 桩按调用方 since 过滤：s-gone 归档于流起点之前，只有更早的 since 才命中。
        return { ids: since.getTime() < at1.getTime() ? ['s-gone'] : [], truncated: false }
      },
      async listArchivedSessionIdsAmong() {
        return []
      },
      async listArchivedSessionIds() {
        return { ids: [], truncated: false }
      },
    }
    await streamWorkspaceSessionEvents(response, 'ws-team', conversations, 1, 60_000)
    assert.doesNotMatch(response.body, /session\.archived/)
  }

  // 有水位线：客户端声明状态止于 T0，s-gone 在 (T0, 建连) 间归档→基线轮补推。
  {
    const response = new MemorySseResponse()
    let polls = 0
    const conversations = {
      async listWorkspaceSessionActivity() {
        if (++polls === 3) response.emit('close')
        return { sessions: [{ sessionId: 's-live', activityAt: at1 }] }
      },
      async listRecentlyArchivedSessionIds(_workspaceId: string, since: Date) {
        return { ids: since.getTime() < at1.getTime() ? ['s-gone'] : [], truncated: false }
      },
      async listArchivedSessionIdsAmong() {
        return []
      },
      async listArchivedSessionIds() {
        return { ids: [], truncated: false }
      },
    }
    const clientSince = new Date('2026-09-12T07:59:00Z')
    await streamWorkspaceSessionEvents(response, 'ws-team', conversations, 1, 60_000, undefined, clientSince)
    assert.match(response.body, /event: session\.archived\ndata: \{"session_id":"s-gone"\}/)
  }
})

test('workspace session stream reports archive committed with a stale transaction timestamp', async () => {
  // M-R4 残余一：归档事务在流建立前开始、之后提交——last_active_at=now()
  // 记的是事务开始时刻，早于任何水位线，时间过滤永远查不到。曾活跃集合
  // 的直接状态复核不看时间戳，必须命中。
  const response = new MemorySseResponse()
  const at1 = new Date('2026-09-12T08:00:00Z')
  let polls = 0
  const conversations = {
    async listWorkspaceSessionActivity() {
      polls += 1
      if (polls === 1) return { sessions: [{ sessionId: 's-tx', activityAt: at1 }], revision: 7 }
      if (polls === 4) response.emit('close')
      // 第 2 轮起 s-tx 离开活跃集（已归档）。
      return { sessions: [], revision: 7 }
    },
    async listRecentlyArchivedSessionIds() {
      // 时间戳陈旧：任何 since 都查不到（复现事务时间洞）。
      return { ids: [], truncated: false }
    },
    async listArchivedSessionIdsAmong(_workspaceId: string, ids: string[]) {
      return polls >= 2 ? ids.filter(id => id === 's-tx') : []
    },
    async listArchivedSessionIds() {
      return { ids: [], truncated: false }
    },
  }

  await streamWorkspaceSessionEvents(response, 'ws-team', conversations, 1, 60_000)
  assert.match(response.body, /event: session\.archived\ndata: \{"session_id":"s-tx"\}/)
})

test('workspace session stream sweeps archives of never-seen sessions on revision change', async () => {
  // M-R4 残余二+边角：会话从未进入活跃窗口、归档时间戳又早于客户端水位线
  // （归档事务挂锁等待期间记录的陈旧时间）。修订号变化触发无时间过滤的
  // 有界回扫补推。
  const response = new MemorySseResponse()
  const at1 = new Date('2026-09-12T08:00:00Z')
  let polls = 0
  const conversations = {
    async listWorkspaceSessionActivity() {
      polls += 1
      if (polls === 4) response.emit('close')
      // 第 3 轮起修订号 +1（归档事务已提交）。
      return { sessions: [{ sessionId: 's-live', activityAt: at1 }], revision: polls >= 3 ? 8 : 7 }
    },
    async listRecentlyArchivedSessionIds() {
      return { ids: [], truncated: false }
    },
    async listArchivedSessionIdsAmong() {
      return []
    },
    async listArchivedSessionIds() {
      return { ids: polls >= 3 ? ['s-unseen'] : [], truncated: false }
    },
  }

  const clientSince = new Date('2026-09-12T08:01:00Z')
  await streamWorkspaceSessionEvents(response, 'ws-team', conversations, 1, 60_000, undefined, clientSince)
  assert.match(response.body, /event: session\.archived\ndata: \{"session_id":"s-unseen"\}/)
})

test('workspace session stream emits session.resync when archive sweep is truncated', async () => {
  // 四审残余：归档查询超限截断后，逐 id 事件不再构成完整性依据——必须
  // 显式发 resync 让客户端整体重取，不能只靠碰巧送达的部分 id 事件。
  const response = new MemorySseResponse()
  const at1 = new Date('2026-09-12T08:00:00Z')
  let polls = 0
  const conversations = {
    async listWorkspaceSessionActivity() {
      polls += 1
      if (polls === 3) response.emit('close')
      return { sessions: [{ sessionId: 's-live', activityAt: at1 }], revision: polls >= 2 ? 9 : 8 }
    },
    async listRecentlyArchivedSessionIds() {
      // 超过上限：返回已知 id 的同时标记 truncated。
      return polls >= 2
        ? { ids: ['s-archived-known'], truncated: true }
        : { ids: [], truncated: false }
    },
    async listArchivedSessionIdsAmong() {
      return []
    },
    async listArchivedSessionIds() {
      return { ids: [], truncated: false }
    },
  }

  const clientSince = new Date('2026-09-12T07:59:00Z')
  await streamWorkspaceSessionEvents(response, 'ws-team', conversations, 1, 60_000, undefined, clientSince)

  assert.match(response.body, /event: session\.archived\ndata: \{"session_id":"s-archived-known"\}/)
  assert.match(response.body, /event: session\.resync\ndata: \{"reason":"truncated"\}/)
  // 五审：同一恢复状态（同修订号、持续截断）只通知一次——第 3 轮截断仍
  // 成立也不重复发，否则客户端恢复请求会被反复作废永远无法完成。
  const resyncCount = (response.body.match(/event: session\.resync/g) ?? []).length
  assert.equal(resyncCount, 2, '基线握手 + 一次截断通知，不得每轮重复 resync')
})

test('workspace session stream stops before delivering after read access is revoked', { timeout: 2000 }, async () => {
  const response = new MemorySseResponse()
  const at1 = new Date('2026-09-12T08:00:00Z')
  const at2 = new Date('2026-09-12T08:01:00Z')
  let polls = 0
  const conversations = {
    async listWorkspaceSessionActivity() {
      polls += 1
      return { sessions: [{ sessionId: 's-1', activityAt: polls >= 2 ? at2 : at1 }] }
    },
    async listRecentlyArchivedSessionIds() {
      return { ids: [], truncated: false }
    },
    async listArchivedSessionIdsAmong() {
      return []
    },
    async listArchivedSessionIds() {
      return { ids: [], truncated: false }
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

  // 读轨从第一轮起即失权：包括无内容的基线握手在内一条事件都不写。
  assert.equal(response.body, '')
  assert.equal(response.ended, true)
})
