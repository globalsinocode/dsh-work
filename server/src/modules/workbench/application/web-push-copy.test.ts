import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCollabUnreadPayload,
  buildRunFinishedPayload,
  collabUnreadRecipientIds,
  runFinishedRecipientIds,
} from './web-push-copy.ts'

test('collabUnread agent direct message uses title and preview', () => {
  const payload = buildCollabUnreadPayload({
    eventId: 'evt-1',
    targetType: 'agent',
    targetId: 'ag_1',
    sessionId: 'sess_1',
    title: '小周',
    previewText: '请帮忙看一下合同',
    senderName: '林夏',
    role: 'user',
  })
  assert.equal(payload.type, 'collab_unread')
  assert.equal(payload.title, '小周')
  assert.equal(payload.body, '请帮忙看一下合同')
  assert.equal(payload.tag, 'collab:agent:ag_1')
  assert.equal(payload.url, '/chat/sess_1')
  assert.equal(payload.sessionId, 'sess_1')
  assert.equal(payload.targetType, 'agent')
  assert.equal(payload.targetId, 'ag_1')
})

test('collabUnread agent empty preview falls back', () => {
  const payload = buildCollabUnreadPayload({
    eventId: 'evt-2',
    targetType: 'agent',
    targetId: 'ag_1',
    sessionId: 'sess_1',
    title: '小周',
    previewText: '   ',
    senderName: '林夏',
    role: 'user',
  })
  assert.equal(payload.body, '发来一条新消息')
})

test('collabUnread group formats sender and preview', () => {
  const payload = buildCollabUnreadPayload({
    eventId: 'evt-3',
    targetType: 'group',
    targetId: 'ws_1',
    workspaceId: 'ws_1',
    sessionId: 'sess_9',
    title: '华东项目组',
    previewText: '合同第三节已改完',
    senderName: '林夏',
    role: 'user',
  })
  assert.equal(payload.title, '华东项目组')
  assert.equal(payload.body, '林夏：合同第三节已改完')
  assert.equal(payload.tag, 'collab:group:ws_1')
  assert.equal(payload.url, '/workspaces/ws_1?session=sess_9')
})

test('collabUnread group assistant uses agent name as sender', () => {
  const payload = buildCollabUnreadPayload({
    eventId: 'evt-4',
    targetType: 'group',
    targetId: 'ws_1',
    workspaceId: 'ws_1',
    sessionId: 'sess_9',
    title: '华东项目组',
    previewText: '已更新第三节',
    senderName: '林夏',
    agentName: '法务助手',
    role: 'assistant',
  })
  assert.equal(payload.body, '法务助手：已更新第三节')
})

test('body truncates at 120 characters with ellipsis', () => {
  const long = 'a'.repeat(121)
  const payload = buildCollabUnreadPayload({
    eventId: 'evt-5',
    targetType: 'agent',
    targetId: 'ag_1',
    sessionId: 'sess_1',
    title: '小周',
    previewText: long,
    senderName: '林夏',
    role: 'user',
  })
  assert.equal(payload.body.length, 121)
  assert.ok(payload.body.endsWith('…'))
  assert.ok(!payload.body.includes('\n'))
})

test('body keeps markdown characters as plain text', () => {
  const payload = buildCollabUnreadPayload({
    eventId: 'evt-6',
    targetType: 'agent',
    targetId: 'ag_1',
    sessionId: 'sess_1',
    title: '小周',
    previewText: '*重点* #标题',
    senderName: '林夏',
    role: 'user',
  })
  assert.equal(payload.body, '*重点* #标题')
})

test('runFinished succeeded with and without session title', () => {
  const withTitle = buildRunFinishedPayload({
    eventId: 'evt-r1',
    runId: 'run_1',
    runStatus: 'succeeded',
    sessionId: 'sess_1',
    sessionTitle: '季度复盘',
    targetType: 'agent',
    targetId: 'ag_1',
  })
  assert.equal(withTitle.title, '任务已完成')
  assert.equal(withTitle.body, '季度复盘')
  assert.equal(withTitle.tag, 'run:run_1')
  assert.equal(withTitle.runId, 'run_1')
  assert.equal(withTitle.runStatus, 'succeeded')

  const withoutTitle = buildRunFinishedPayload({
    eventId: 'evt-r2',
    runId: 'run_1',
    runStatus: 'succeeded',
    sessionId: 'sess_1',
    sessionTitle: '',
    targetType: 'agent',
    targetId: 'ag_1',
  })
  assert.equal(withoutTitle.body, '可以回到对话查看结果')
})

test('runFinished failed and awaiting_approval copy', () => {
  const failed = buildRunFinishedPayload({
    eventId: 'evt-r3',
    runId: 'run_1',
    runStatus: 'failed',
    sessionId: 'sess_1',
    targetType: 'group',
    targetId: 'ws_1',
    workspaceId: 'ws_1',
  })
  assert.equal(failed.title, '任务未完成')
  assert.equal(failed.body, '可以回到对话查看原因')
  assert.equal(failed.url, '/workspaces/ws_1?session=sess_1')

  const waiting = buildRunFinishedPayload({
    eventId: 'evt-r4',
    runId: 'run_1',
    runStatus: 'awaiting_approval',
    sessionId: 'sess_1',
    targetType: 'agent',
    targetId: 'ag_1',
  })
  assert.equal(waiting.title, '有待确认的操作')
  assert.equal(waiting.body, '打开对话后可以允许或拒绝')
})

test('collabUnreadRecipientIds excludes actor and respects mute', () => {
  assert.deepEqual(
    collabUnreadRecipientIds({
      role: 'user',
      authorUserId: 'u1',
      requestedBy: null,
      participantUserIds: ['u1', 'u2', 'u3'],
      muted: false,
    }),
    ['u2', 'u3'],
  )
  assert.deepEqual(
    collabUnreadRecipientIds({
      role: 'assistant',
      authorUserId: null,
      requestedBy: 'u1',
      participantUserIds: ['u1', 'u2'],
      muted: false,
    }),
    ['u2'],
  )
  assert.deepEqual(
    collabUnreadRecipientIds({
      role: 'user',
      authorUserId: 'u1',
      requestedBy: null,
      participantUserIds: ['u1'],
      muted: false,
    }),
    [],
  )
  assert.deepEqual(
    collabUnreadRecipientIds({
      role: 'user',
      authorUserId: 'u1',
      requestedBy: null,
      participantUserIds: ['u1', 'u2'],
      muted: true,
    }),
    [],
  )
})

test('runFinishedRecipientIds only requester unless cancelled', () => {
  assert.deepEqual(runFinishedRecipientIds({ requestedBy: 'u9', runStatus: 'succeeded' }), ['u9'])
  assert.deepEqual(runFinishedRecipientIds({ requestedBy: 'u9', runStatus: 'failed' }), ['u9'])
  assert.deepEqual(runFinishedRecipientIds({ requestedBy: 'u9', runStatus: 'awaiting_approval' }), ['u9'])
  assert.deepEqual(runFinishedRecipientIds({ requestedBy: 'u9', runStatus: 'cancelled' }), [])
})
