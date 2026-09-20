import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { ModelCapabilityMismatchError } from '../modules/model/model-governance-service.ts'
import { ExecutionCapabilityUnavailableError } from '../modules/runtime/execution-capabilities.ts'
import { assertApiRouteAccess, classifyHttpError } from './router.ts'

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
  const result = classifyHttpError(new Error('Runtime timeout after 30 seconds'), '/api/workbench/runs/run-001/retry')

  assert.equal(result.status, 504)
  assert.equal(result.error.code, 'dependency_timeout')
  assert.equal(result.error.object, '运行 run-001')
  assert.match(result.error.message, /超时/)
  assert.match(result.error.suggestion, /重试|运行时|连接器/)
  assert.match(result.error.traceId, /^trace-http-/)
})

test('permission and validation failures preserve safe causes and actionable guidance', () => {
  const forbidden = classifyHttpError(
    new Error('工作空间不存在或不可访问：ws-private'),
    '/api/workbench/workspaces/ws-private',
  )
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.error.code, 'permission_denied')
  assert.equal(forbidden.error.object, '工作空间 ws-private')
  assert.match(forbidden.error.suggestion, /成员关系|授权/)

  const invalid = classifyHttpError(
    new Error('文件大小超过 20 MB 限制'),
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
