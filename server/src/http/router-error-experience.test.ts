import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { ModelCapabilityMismatchError } from '../modules/model/model-governance-service.ts'
import { ExecutionCapabilityUnavailableError } from '../modules/runtime/execution-capabilities.ts'
import { authorizationDenied } from '../domain/authorization-errors.ts'
import { accessDenied, dependencyTimeout, invalidRequest, notFound, stateConflict, dependencyUnavailable } from '../domain/request-errors.ts'
import { assertApiRouteAccess, classifyHttpError, readJsonBody } from './router.ts'

test('model capability errors retain stable codes and explain the administrator action', () => {
  for (const error of [new ModelCapabilityMismatchError(['structured-output']), new ExecutionCapabilityUnavailableError('model')]) {
    const result = classifyHttpError(error, '/api/workbench/runs')
    assert.equal(result.status, error.status)
    assert.equal(result.error.code, error.code)
    assert.match(result.error.message, /模型能力|所需能力/)
    assert.match(result.error.suggestion, /不能直接重试或忽略/)
  }
})

test('timeout errors identify the affected run and give an operational next step', () => {
  const timeouts = [
    dependencyTimeout('Runtime timeout after 30 seconds'),
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    Object.assign(new Error('connect failed'), { code: 'ETIMEDOUT' }),
    new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }),
  ]
  for (const error of timeouts) {
    const result = classifyHttpError(error, '/api/workbench/runs/run-001/retry')
    assert.equal(result.status, 504, String(error))
    assert.equal(result.error.code, 'dependency_timeout')
    assert.equal(result.error.object, '运行 run-001')
    assert.equal(result.error.message, '运行 run-001处理超时')
    assert.match(result.error.suggestion, /重试|运行时|连接器/)
    assert.match(result.error.traceId, /^trace-http-/)
  }
})

test('status never comes from message wording: an untyped error is always a 500', () => {
  for (const message of ['Runtime timeout after 30 seconds', '运行超时必须在 30～600 秒之间', '工作空间不存在或不可访问', '当前状态不能取消', '文件大小超过 20 MB 限制', 'Runtime 当前离线']) {
    const result = classifyHttpError(new Error(message), '/api/workbench/runs/run-001')
    assert.equal(result.status, 500, message)
    assert.equal(result.error.code, 'operation_failed')
    assert.equal(result.error.message, '运行 run-001操作未完成', 'internal wording is not echoed')
  }
})

test('each request error category keeps its status, code, message and next step', () => {
  const cases = [
    [invalidRequest('文件大小超过 20 MB 限制'), 422, 'invalid_request', /调整输入内容或文件/],
    [accessDenied('管理对话不存在或不可访问'), 403, 'permission_denied', /成员关系|授权/],
    [authorizationDenied('当前账号无权访问该资源'), 403, 'authorization_denied', /配置角色与数据范围/],
    [notFound('Agent 不存在'), 404, 'resource_not_found', /列表/],
    [stateConflict('当前状态不能取消'), 409, 'state_conflict', /刷新对象状态/],
    [dependencyUnavailable('Runtime 当前离线'), 503, 'dependency_unavailable', /运行时或连接器/],
  ] as const
  for (const [error, status, code, suggestion] of cases) {
    const result = classifyHttpError(error, '/api/workbench/agents/agent-1')
    assert.equal(result.status, status)
    assert.equal(result.error.code, code)
    assert.equal(result.error.message, error.message)
    assert.match(result.error.suggestion, suggestion)
  }
})

test('permission and validation failures preserve safe causes and actionable guidance', () => {
  const forbidden = classifyHttpError(
    accessDenied('工作空间不存在或不可访问：ws-private'),
    '/api/workbench/workspaces/ws-private',
  )
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.error.code, 'permission_denied')
  assert.equal(forbidden.error.object, '工作空间 ws-private')
  assert.match(forbidden.error.suggestion, /成员关系|授权/)

  const invalid = classifyHttpError(
    invalidRequest('文件大小超过 20 MB 限制'),
    '/api/workbench/files/file-large',
  )
  assert.equal(invalid.status, 422)
  assert.equal(invalid.error.code, 'invalid_request')
  assert.equal(invalid.error.object, '文件 file-large')
  assert.match(invalid.error.suggestion, /调整/)
})

test('unknown failures do not expose internal exception details', () => {
  const result = classifyHttpError(
    new Error('password=secret internal stack /Users/example/private.ts:42'),
    '/api/workbench/artifacts/artifact-001/download',
  )

  assert.equal(result.status, 500)
  assert.equal(result.error.code, 'operation_failed')
  assert.equal(result.error.object, '成果 artifact-001')
  assert.doesNotMatch(result.error.message, /password|private\.ts/)
  assert.match(result.error.suggestion, new RegExp(result.error.traceId))
})

test('malformed JSON is a validation error rather than an internal server failure', () => {
  const result = classifyHttpError(new SyntaxError('Unexpected end of JSON input'), '/api/admin/v1/agents')
  assert.equal(result.status, 422)
  assert.equal(result.error.code, 'invalid_request')
  assert.equal(result.error.object, 'Agent')
  assert.match(result.error.message, /有效 JSON/)
})

test('admin writers cannot escalate privileges through identity administration routes', () => {
  const identity: RequestIdentity = {
    audience: 'admin',
    applicationId: 'dsh-work',
    sessionHash: 'session-hash',
    userId: 'user-writer',
    subject: 'subject-writer',
    profile: {
      id: 'user-writer', name: '管理写用户', title: '', department: '', avatarText: '管',
      role: 'employee', dataScopes: [],
    },
    roleIds: ['role-admin-writer'],
    permissions: ['admin:read', 'admin:write'],
    dataScopes: [],
    authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  }

  assert.doesNotThrow(() => assertApiRouteAccess(identity, '/api/admin/v1/identity/users', 'GET'))
  assert.throws(
    () => assertApiRouteAccess(identity, '/api/admin/v1/identity/users/user-1/roles', 'POST'),
    /只有平台管理员/,
  )
  assert.doesNotThrow(() => assertApiRouteAccess(identity, '/api/admin/v1/agents', 'POST'))
})

test('JSON bodies keep UTF-8 text split across chunks and the limit counts bytes', async () => {
  const full = Buffer.from(JSON.stringify({ text: '生产计划' }))
  const cut = full.indexOf(Buffer.from('产')) + 1
  const split = (async function* () { yield full.subarray(0, cut); yield full.subarray(cut) })()
  assert.deepEqual(await readJsonBody(split as unknown as Parameters<typeof readJsonBody>[0]), { text: '生产计划' })
  // 400k three-byte characters stay under 1M UTF-16 units but exceed 1 MB of bytes.
  const oversized = (async function* () { yield Buffer.from(JSON.stringify({ text: '中'.repeat(400_000) })) })()
  await assert.rejects(readJsonBody(oversized as unknown as Parameters<typeof readJsonBody>[0]), /1 MB/)
})

test('authorization revocation codes stay in the closed client-facing set', async () => {
  const { authorizationDenied, publicAuthorizationResponseCode, isAuthorizationChangeResponseCode } = await import('../domain/authorization-errors.ts')
  for (const code of ['authorization_denied', 'permission_revoked', 'role_disabled', 'data_scope_revoked'] as const) {
    const result = classifyHttpError(authorizationDenied('授权已变化', { status: 403, code }), '/api/workbench/workspaces/ws-1')
    assert.equal(result.status, 403)
    assert.equal(result.error.code, code)
    assert.ok(isAuthorizationChangeResponseCode(result.error.code))
    assert.equal(publicAuthorizationResponseCode('permission_denied'), 'authorization_denied')
    assert.doesNotMatch(result.error.message, /U000|role-platform-admin/)
    assert.doesNotMatch(result.error.suggestion ?? '', /U000|SELECT/)
  }
})

test('an authorization denial may keep a non-403 answer for the editing request and still revoke runs', async () => {
  const { authorizationDenied, isAuthorizationDenial } = await import('../domain/authorization-errors.ts')
  const invalid = authorizationDenied('Agent 必须显式授权所选 Skill 依赖的工具：read', { status: 422, code: 'invalid_request', suggestion: '按提示调整输入内容或文件后重新提交。' })
  const missing = authorizationDenied('Skill 不存在、未发布或已停用：skill-x', { status: 404, code: 'resource_not_found' })
  assert.equal(isAuthorizationDenial(invalid), true)
  assert.equal(isAuthorizationDenial(missing), true)
  assert.equal(classifyHttpError(invalid, '/api/admin/v1/agents').status, 422)
  assert.equal(classifyHttpError(missing, '/api/admin/v1/agents').status, 404)
  assert.equal(classifyHttpError(authorizationDenied('当前用户角色为只读'), '/api/admin/v1/agents').status, 403)
})
