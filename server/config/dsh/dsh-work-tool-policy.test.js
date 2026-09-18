import { createPlatformToolBridge } from '../../src/modules/runtime/platform-tool-bridge.ts'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, test } from 'node:test'

import { apply } from './dsh-work-tool-policy.js'

const originalEnvironment = {
  currentAuthorization: process.env.DSH_REQUIRE_CURRENT_AUTHORIZATION,
  allowedTools: process.env.DSH_ALLOWED_TOOLS_JSON,
  workspaceRoot: process.env.DSH_WORKSPACE_ROOT,
  approvalMode: process.env.DSH_TOOL_APPROVAL_MODE,
  approvalLog: process.env.DSH_TOOL_APPROVAL_LOG,
  maximumCalls: process.env.DSH_MAX_TOOL_CALLS,
  platformSocket: process.env.DSH_PLATFORM_TOOL_SOCKET,
  toolCatalogPath: process.env.DSH_TOOL_CATALOG_PATH,
}

afterEach(() => {
  restoreEnvironment('DSH_REQUIRE_CURRENT_AUTHORIZATION', originalEnvironment.currentAuthorization)
  restoreEnvironment('DSH_ALLOWED_TOOLS_JSON', originalEnvironment.allowedTools)
  restoreEnvironment('DSH_WORKSPACE_ROOT', originalEnvironment.workspaceRoot)
  restoreEnvironment('DSH_TOOL_APPROVAL_MODE', originalEnvironment.approvalMode)
  restoreEnvironment('DSH_TOOL_APPROVAL_LOG', originalEnvironment.approvalLog)
  restoreEnvironment('DSH_MAX_TOOL_CALLS', originalEnvironment.maximumCalls)
  restoreEnvironment('DSH_PLATFORM_TOOL_SOCKET', originalEnvironment.platformSocket)
  restoreEnvironment('DSH_TOOL_CATALOG_PATH', originalEnvironment.toolCatalogPath)
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

test('DSH tool policy confines write and edit to supported files in the Run output directory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-work-output-policy-'))
  await mkdir(join(workspace, 'output'))
  await mkdir(join(workspace, 'input'))
  process.env.DSH_ALLOWED_TOOLS_JSON = '["write","edit"]'
  process.env.DSH_WORKSPACE_ROOT = workspace
  process.env.DSH_TOOL_APPROVAL_MODE = 'never'
  const { guard } = capturePolicy()

  assert.equal(guard({ name: 'write', arguments: { file_path: 'output/report.md', content: '# 报告' } }), undefined)
  assert.equal(guard({ name: 'write', arguments: { file_path: 'output/data.csv', content: 'id,value' } }), undefined)
  assert.match(guard({ name: 'write', arguments: { file_path: 'input/source.txt', content: 'changed' } }), /只允许.*output/)
  assert.match(guard({ name: 'write', arguments: { file_path: 'report.md', content: '# 报告' } }), /只允许.*output/)
  assert.match(guard({ name: 'write', arguments: { file_path: 'output/report.html', content: '<h1>报告</h1>' } }), /仅支持/)
  assert.equal(guard({ name: 'edit', arguments: { file_path: 'output/report.md', old_string: '旧', new_string: '新' } }), undefined)
  assert.match(guard({ name: 'edit', arguments: { file_path: 'input/source.txt', old_string: '旧', new_string: '新' } }), /只允许.*output/)
  assert.match(guard({ name: 'edit', arguments: { file_path: 'output/report.html', old_string: '旧', new_string: '新' } }), /仅支持/)
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

test('DSH registers only the fixed governed platform tool contracts when an Attempt bridge exists', () => {
  process.env.DSH_PLATFORM_TOOL_SOCKET = '/tmp/attempt-only.sock'
  const { registered } = capturePolicy()
  assert.deepEqual(registered.map(tool => tool.name), ['prepare_skill_installation', 'inspect_admin_state', 'propose_admin_task', 'prepare_admin_action', 'activate_skill', 'python_execute'])
  assert.match(registered.find(tool => tool.name === 'inspect_admin_state').parameters.properties.query.description, /literal object name or ID/)
  assert.deepEqual(registered.find(tool => tool.name === 'propose_admin_task').parameters.required, ['kind', 'summary', 'impact'])
  assert.deepEqual(registered.find(tool => tool.name === 'prepare_admin_action').parameters.properties.actionType.enum, ['agent-update-draft', 'agent-set-status', 'runtime-update-configuration'])
  assert.deepEqual(registered.find(tool => tool.name === 'activate_skill').parameters.required, ['name'])
  assert.equal(registered.find(tool => tool.name === 'python_execute').parameters.additionalProperties, false)
})

test('DSH publishes the tools loaded by the active Profile for platform discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-work-tool-catalog-'))
  const path = join(root, 'runtime-tools.json')
  process.env.DSH_TOOL_CATALOG_PATH = path
  const schemas = [
    { name: 'read', description: 'Read a file.', parameters: { type: 'object' } },
    { name: 'todo_write', description: 'Update todos.', parameters: { type: 'object' } },
  ]
  capturePolicy(schemas)

  const catalog = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(catalog.formatVersion, 1)
  assert.deepEqual(catalog.tools, schemas)
})

function capturePolicy(schemas = []) {
  let guard
  let preExecute
  const registered = []
  apply({
    on: (event, candidate) => {
      if (event === 'tools/pre-execute') preExecute = candidate
      return () => undefined
    },
    tools: {
      register: definition => { registered.push(definition) },
      guard: candidate => {
        guard = candidate
        return () => undefined
      },
      schemas: () => schemas,
    },
  })
  assert.ok(guard)
  assert.ok(preExecute)
  return { guard, preExecute, registered }
}

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}


test('current authorization is checked on every built-in tool call and does not consume the tool budget', async () => {
  let revoked = false, checks = 0
  const bridge = await createPlatformToolBridge({}, 0, async () => { checks++; if (revoked) throw new Error('revoked') })
  try {
    process.env.DSH_PLATFORM_TOOL_SOCKET = bridge.socket
    process.env.DSH_REQUIRE_CURRENT_AUTHORIZATION = 'true'
    process.env.DSH_ALLOWED_TOOLS_JSON = '["todo_write"]'
    process.env.DSH_TOOL_APPROVAL_MODE = 'never'
    const { preExecute } = capturePolicy()
    assert.equal((await preExecute({ name: 'todo_write', arguments: {} }, async () => ({ kind: 'allow' }))).kind, 'allow')
    assert.equal(checks, 2)
    revoked = true
    let downstream = false
    assert.equal((await preExecute({ name: 'todo_write', arguments: {} }, async () => { downstream = true; return { kind: 'allow' } })).kind, 'deny')
    assert.equal(downstream, false)
  } finally { await bridge.close() }
})
