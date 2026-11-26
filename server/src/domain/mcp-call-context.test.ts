import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mcpCallContextHeaders, mcpCallVisibility } from './mcp-call-context.ts'

test('visibility follows who actually sees the result', () => {
  // 个人空间：员工本人的对话与定时任务。
  assert.equal(mcpCallVisibility({ workspaceType: 'personal' }), 'personal')
  assert.equal(mcpCallVisibility({ purpose: 'automation', workspaceType: 'personal' }), 'personal')
  // 项目空间：讨论与任务对话、结果归属空间为项目空间的定时任务、Task 执行接口。
  assert.equal(mcpCallVisibility({ workspaceType: 'team' }), 'shared')
  assert.equal(mcpCallVisibility({ purpose: 'automation', workspaceType: 'team' }), 'shared')
  // 主动任务只给接收人，放在项目空间也是 personal。
  assert.equal(mcpCallVisibility({ purpose: 'agent-routine', workspaceType: 'team' }), 'personal')
  // 发布验证与管理端运行不发送。
  assert.equal(mcpCallVisibility({ purpose: 'agent-release-trial', workspaceType: 'personal' }), null)
  assert.equal(mcpCallVisibility({ purpose: 'admin-assistant', workspaceType: null }), null)
  assert.equal(mcpCallVisibility({ workspaceType: null }), null)
})

test('personal headers carry the employee identity; shared headers never do', () => {
  const base = { runId: 'run-1', attemptId: 'attempt-1', agentId: 'agent-ar' }
  assert.deepEqual(mcpCallContextHeaders({
    ...base, visibility: 'personal', viewer: { userId: 'U001', loginAccount: '+8613800138000', dingtalkUserId: 'ding-001' },
  }), {
    'X-DSH-Work-Visibility': 'personal',
    'X-DSH-Work-Run-Id': 'run-1',
    'X-DSH-Work-Attempt-Id': 'attempt-1',
    'X-DSH-Work-Agent-Id': 'agent-ar',
    'X-DSH-Work-Viewer-User-Id': 'U001',
    'X-DSH-Work-Viewer-Mobile': '13800138000',
    'X-DSH-Work-Viewer-Dingtalk-Userid': 'ding-001',
  })
  assert.deepEqual(mcpCallContextHeaders({
    ...base, visibility: 'personal', viewer: { userId: 'U002', loginAccount: 'Lin.Lan@Example.com', dingtalkUserId: null },
  }), {
    'X-DSH-Work-Visibility': 'personal',
    'X-DSH-Work-Run-Id': 'run-1',
    'X-DSH-Work-Attempt-Id': 'attempt-1',
    'X-DSH-Work-Agent-Id': 'agent-ar',
    'X-DSH-Work-Viewer-User-Id': 'U002',
    'X-DSH-Work-Viewer-Email': 'lin.lan@example.com',
  })
  const shared = mcpCallContextHeaders({ ...base, visibility: 'shared', viewer: { userId: 'U001', loginAccount: '13800138000' } })
  assert.equal(shared['X-DSH-Work-Visibility'], 'shared')
  assert.equal(Object.keys(shared).some(name => name.startsWith('X-DSH-Work-Viewer-')), false)
})

test('identifiers that cannot travel as ASCII headers are dropped, never the whole context', () => {
  const headers = mcpCallContextHeaders({
    runId: 'run-1', attemptId: 'attempt-1', agentId: null, visibility: 'personal',
    viewer: { userId: 'U003', loginAccount: '林岚@例子.中国', dingtalkUserId: 'ding 003' },
  })
  assert.deepEqual(headers, {
    'X-DSH-Work-Visibility': 'personal',
    'X-DSH-Work-Run-Id': 'run-1',
    'X-DSH-Work-Attempt-Id': 'attempt-1',
    'X-DSH-Work-Viewer-User-Id': 'U003',
  })
  // 旧账号名既不是手机号也不是邮箱（与登录同一判定）：只发平台用户 ID。
  for (const legacy of ['linlan', 'zhang@corp', 'a@b@example.com']) {
    const headers = mcpCallContextHeaders({ runId: 'r', attemptId: 'a', visibility: 'personal', viewer: { userId: 'U004', loginAccount: legacy } })
    assert.equal(headers['X-DSH-Work-Viewer-Email'], undefined, legacy)
    assert.equal(headers['X-DSH-Work-Viewer-Mobile'], undefined, legacy)
  }
})
