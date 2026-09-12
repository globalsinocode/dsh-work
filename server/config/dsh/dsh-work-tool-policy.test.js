import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, test } from 'node:test'

import { apply } from './dsh-work-tool-policy.js'

const originalEnvironment = {
  allowedTools: process.env.DSH_ALLOWED_TOOLS_JSON,
  workspaceRoot: process.env.DSH_WORKSPACE_ROOT,
  approvalMode: process.env.DSH_TOOL_APPROVAL_MODE,
  approvalLog: process.env.DSH_TOOL_APPROVAL_LOG,
  maximumCalls: process.env.DSH_MAX_TOOL_CALLS,
}

afterEach(() => {
  restoreEnvironment('DSH_ALLOWED_TOOLS_JSON', originalEnvironment.allowedTools)
  restoreEnvironment('DSH_WORKSPACE_ROOT', originalEnvironment.workspaceRoot)
  restoreEnvironment('DSH_TOOL_APPROVAL_MODE', originalEnvironment.approvalMode)
  restoreEnvironment('DSH_TOOL_APPROVAL_LOG', originalEnvironment.approvalLog)
  restoreEnvironment('DSH_MAX_TOOL_CALLS', originalEnvironment.maximumCalls)
})

test('DSH tool policy confines read and search paths to the immutable Run workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-work-tool-policy-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await mkdir(workspace)
  await mkdir(outside)
  await writeFile(join(workspace, 'inside.txt'), 'inside')
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(outside, join(workspace, 'outside-link'))

  process.env.DSH_ALLOWED_TOOLS_JSON = '["read","glob"]'
  process.env.DSH_WORKSPACE_ROOT = workspace
  process.env.DSH_TOOL_APPROVAL_MODE = 'never'
  const { guard } = capturePolicy()

  assert.equal(guard({ name: 'read', arguments: { file_path: 'inside.txt' } }), undefined)
  assert.equal(guard({ name: 'glob', arguments: { pattern: '**/*.txt' } }), undefined)
  assert.match(guard({ name: 'read', arguments: { file_path: join(outside, 'secret.txt') } }), /工作区之外/)
  assert.match(guard({ name: 'glob', arguments: { pattern: '*', path: '..' } }), /工作区之外/)
  assert.match(guard({ name: 'read', arguments: { file_path: 'outside-link/secret.txt' } }), /符号链接/)
  assert.match(guard({ name: 'write', arguments: {} }), /未授权工具/)
})

test('DSH tool policy fails closed when allow-list input is malformed', () => {
  process.env.DSH_ALLOWED_TOOLS_JSON = '{not-json}'
  const { guard } = capturePolicy()

  assert.match(guard({ name: 'read', arguments: { file_path: 'inside.txt' } }), /未授权工具/)
})

test('DSH tool policy asks before every governed tool call unless approval is disabled', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-work-tool-approval-'))
  await writeFile(join(workspace, 'inside.txt'), 'inside')
  process.env.DSH_ALLOWED_TOOLS_JSON = '["read"]'
  process.env.DSH_WORKSPACE_ROOT = workspace
  process.env.DSH_TOOL_APPROVAL_LOG = join(workspace, 'approval-requests.jsonl')

  for (const approvalMode of ['always', 'risk_based']) {
    process.env.DSH_TOOL_APPROVAL_MODE = approvalMode
    const { preExecute } = capturePolicy()
    assert.deepEqual(
      await preExecute(
        { callId: `call-${approvalMode}`, name: 'read', arguments: { file_path: 'inside.txt' } },
        async () => ({ kind: 'allow' }),
      ),
      { kind: 'ask', reason: approvalMode === 'always'
        ? 'dsh-work 要求每次确认工具：read'
        : 'dsh-work 要求确认敏感工具：read' },
    )
  }

  process.env.DSH_TOOL_APPROVAL_MODE = 'never'
  const { preExecute } = capturePolicy()
  assert.deepEqual(
    await preExecute(
      { callId: 'call-never', name: 'read', arguments: { file_path: 'inside.txt' } },
      async () => ({ kind: 'allow' }),
    ),
    { kind: 'allow' },
  )

  const approvalRequests = (await readFile(process.env.DSH_TOOL_APPROVAL_LOG, 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(approvalRequests, [
    { call_id: 'call-always', tool_name: 'read' },
    { call_id: 'call-risk_based', tool_name: 'read' },
  ])

  delete process.env.DSH_TOOL_APPROVAL_LOG
  process.env.DSH_TOOL_APPROVAL_MODE = 'always'
  const unavailableLogPolicy = capturePolicy()
  assert.deepEqual(
    await unavailableLogPolicy.preExecute(
      { callId: 'call-untracked', name: 'read', arguments: { file_path: 'inside.txt' } },
      async () => ({ kind: 'allow' }),
    ),
    { kind: 'deny', reason: 'dsh-work 无法记录工具审批关联，已拒绝执行' },
  )
})

test('DSH tool policy enforces the immutable Attempt tool-call budget', async () => {
  process.env.DSH_ALLOWED_TOOLS_JSON = '["read"]'
  process.env.DSH_WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'dsh-tool-budget-'))
  process.env.DSH_TOOL_APPROVAL_MODE = 'never'
  process.env.DSH_MAX_TOOL_CALLS = '1'
  const { preExecute } = capturePolicy()
  const execution = { name: 'read', arguments: { file_path: 'value.txt' } }
  const next = async () => ({ kind: 'allow' })
  assert.equal((await preExecute(execution, next)).kind, 'allow')
  assert.equal((await preExecute(execution, next)).kind, 'deny')
  process.env.DSH_MAX_TOOL_CALLS = 'invalid'
  assert.equal((await capturePolicy().preExecute(execution, next)).kind, 'deny')
})

function capturePolicy() {
  let guard
  let preExecute
  apply({
    on: (event, candidate) => {
      assert.equal(event, 'tools/pre-execute')
      preExecute = candidate
      return () => undefined
    },
    tools: {
      guard: candidate => {
        guard = candidate
        return () => undefined
      },
    },
  })
  assert.ok(guard)
  assert.ok(preExecute)
  return { guard, preExecute }
}

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
