import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ExportableSessionMessage } from './postgres-conversation-repository.ts'
import { SessionExportService } from './session-export-service.ts'

async function collectContent(content: AsyncIterable<string>) {
  let text = ''
  for await (const chunk of content) text += chunk
  return text
}

test('session export includes discussions and all Runs in chronological order', async () => {
  const discussion: ExportableSessionMessage = {
    id: 'm-discussion',
    role: 'user',
    content: '先讨论一下发布范围',
    senderName: '张三',
    runId: null,
    createdAt: new Date('2026-10-21T08:00:00Z'),
  }
  const runOneMessage: ExportableSessionMessage = {
    id: 'm-run-1',
    role: 'assistant',
    content: '第一轮分析结论',
    runId: 'run-1',
    createdAt: new Date('2026-10-21T08:05:00Z'),
  }
  const runTwoMessage: ExportableSessionMessage = {
    id: 'm-run-2',
    role: 'assistant',
    content: '第二轮分析结论',
    runId: 'run-2',
    createdAt: new Date('2026-10-21T08:10:00Z'),
  }
  let call = 0
  const conversations = {
    listSessionMessagePage: async () => {
      call += 1
      if (call === 1) return { items: [discussion, runOneMessage], nextCursor: 'c2' }
      return { items: [runTwoMessage], nextCursor: null }
    },
    getTask: async () => null,
  }
  const orchestration = {
    getSessionThread: async () => ({ title: '发布讨论', sessionId: 's1' }),
  }
  const service = new SessionExportService({
    conversations: conversations as never,
    orchestration: orchestration as never,
    authorization: {} as never,
  })
  const result = await service.exportSession({ sessionId: 's1', userId: 'u1' })
  const content = await collectContent(result.content)
  assert.match(result.filename, /完整会话/)
  assert.match(content, /范围：完整会话/)
  assert.ok(content.indexOf(discussion.content) < content.indexOf(runTwoMessage.content))
})

test('run export contains only the requested Run', async () => {
  const conversations = {
    listSessionMessagePage: async () => ({
      items: [{
        id: 'm-run-1',
        role: 'assistant' as const,
        content: '本次 Run 正文',
        runId: 'r1',
        createdAt: new Date(),
      }],
      nextCursor: null,
    }),
    getTask: async () => ({
      sessionId: 's1',
      title: '库存分析',
      workspaceId: 'ws-personal',
    }),
  }
  const service = new SessionExportService({
    conversations: conversations as never,
    orchestration: { getSessionThread: async () => ({ title: '' }) } as never,
    authorization: { readableWorkspaceTypeOf: async () => 'personal' } as never,
  })
  const result = await service.exportRun({ runId: 'r1', userId: 'u1' })
  const content = await collectContent(result.content)
  assert.match(content, /范围：本次 Run/)
  assert.doesNotMatch(content, /另一个 Run/)
})
