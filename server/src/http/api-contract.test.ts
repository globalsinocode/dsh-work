import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'

import { PrototypeRepository } from '../infrastructure/prototype/prototype-repository.ts'
import { AdminQueryService } from '../modules/admin/application/admin-query-service.ts'
import { WorkbenchQueryService } from '../modules/workbench/application/workbench-query-service.ts'
import { registerAdminRoutes } from './admin/routes.ts'
import { Router } from './router.ts'
import { registerWorkbenchRoutes } from './workbench/routes.ts'
import { registerUnavailableWorkbenchCommandRoutes } from './workbench/unavailable-routes.ts'
import { prototypeApiAuthenticator } from '../modules/identity/prototype-authenticator.ts'

let server: Server
let baseUrl = ''

interface SessionEnvelope {
  data: { user: { role: string } }
  meta: { api: string; adapter: string }
}

interface ErrorEnvelope {
  error: { code: string; message: string; object: string; suggestion: string; traceId: string }
}

interface AgentEnvelope {
  data: Array<{ id: string; status?: string; systemPrompt?: string; owner?: string }>
  meta: { api: string; adapter: string }
}

interface SkillEnvelope {
  data: Array<{ id: string; status?: string; instructions?: string; toolIds?: string[]; testPrompt: string }>
  meta: { api: string; adapter: string }
}

interface WorkspaceEnvelope {
  data: Array<{ id: string; type: 'personal' | 'team'; name: string }>
}

interface OperationsSummaryEnvelope {
  data: { runs24h: number; modelTokens24h: number; attentionEvents24h: number }
  meta: { adapter: string }
}

interface SkillTestProgressEnvelope {
  data: { runId: string; skillId: string; version: string; status: string; steps: Array<{ title: string; status: string }> }
  meta: { adapter: string }
}

interface RecordListEnvelope {
  data: Array<Record<string, unknown>>
}

test('workbench OpenAPI keeps session thread and summary operations on their actual routes', async () => {
  const document = JSON.parse(await readFile(
    new URL('../../../docs/development/openapi-workbench.json', import.meta.url),
    'utf8',
  )) as { paths: Record<string, { get?: { operationId?: string } }> }

  assert.equal(document.paths['/sessions/{sessionId}']?.get?.operationId, 'getSessionThread')
  assert.equal(document.paths['/sessions/{sessionId}/summary']?.get?.operationId, 'getSessionForUser')
})

test('PF-01/PF-02/PF-03 OpenAPI publishes Task budgets, operation reconciliation, and Connector-level MCP governance', async () => {
  const workbench = JSON.parse(await readFile(
    new URL('../../../docs/development/openapi-workbench.json', import.meta.url),
    'utf8',
  )) as {
    paths: Record<string, { get?: { operationId?: string; summary?: string }; post?: { operationId?: string; description?: string } }>
    components: { schemas: Record<string, { properties?: Record<string, unknown>; description?: string }> }
  }
  const admin = JSON.parse(await readFile(
    new URL('../../../docs/development/openapi-admin.json', import.meta.url),
    'utf8',
  )) as { paths: Record<string, {
    get?: { operationId?: string; summary?: string }
    post?: { operationId?: string; summary?: string; responses?: Record<string, unknown> }
    patch?: { operationId?: string; summary?: string; responses?: Record<string, unknown> }
    delete?: { operationId?: string; summary?: string }
  }> }

  assert.equal(workbench.paths['/task-executions']?.post?.operationId, 'createTaskExecution')
  assert.equal(workbench.paths['/task-executions/{taskId}']?.get?.operationId, 'getTaskExecution')
  assert.equal(workbench.paths['/task-executions/{taskId}/operations']?.get?.operationId, 'listTaskOperations')
  assert.equal(workbench.paths['/task-executions/{taskId}/cancel']?.post?.operationId, 'cancelTaskExecution')
  assert.equal(workbench.paths['/task-executions/{taskId}/retry']?.post?.operationId, 'retryTaskExecution')
  assert.match(workbench.paths['/task-executions']?.post?.description ?? '', /Token 与成本硬预算当前明确拒绝/)
  assert.match(workbench.paths['/task-executions/{taskId}']?.get?.summary ?? '', /累计预算/)
  assert.deepEqual(Object.keys(workbench.components.schemas['TaskCumulativeBudgetInput']?.properties ?? {}), [
    'maxDurationMs', 'maxToolCalls', 'maxOutputBytes', 'maxTokens', 'maxCostAmount', 'costCurrency',
  ])
  assert.match(workbench.components.schemas['TaskCumulativeBudgetInput']?.description ?? '', /不支持的硬预算会明确失败/)
  assert.equal(admin.paths['/task-executions/{taskId}/operations/{operationId}/resolve']?.post?.operationId, 'resolveTaskOperation')
  assert.equal(admin.paths['/connectors']?.get?.operationId, 'listMcpConnectors')
  assert.equal(admin.paths['/connectors/mcp']?.post?.operationId, 'registerMcpConnector')
  assert.ok(admin.paths['/connectors/mcp']?.post?.responses?.['409'])
  assert.equal(admin.paths['/connectors/mcp/test']?.post?.operationId, 'testMcpConnection')
  assert.equal(admin.paths['/connectors/mcp/{connectorId}']?.delete?.operationId, 'deleteMcpConnector')
  assert.equal(admin.paths['/connectors/mcp/credential']?.patch?.operationId, 'rotateMcpCredential')
  assert.equal(admin.paths['/connectors/check']?.post?.operationId, 'checkConnector')
  assert.ok(admin.paths['/connectors/check']?.post?.responses?.['409'])
  assert.equal(admin.paths['/connectors/mcp/approve'], undefined)
  assert.equal(admin.paths['/connectors/mcp/status']?.patch?.operationId, 'setMcpConnectorStatus')
  assert.ok(admin.paths['/connectors/mcp/status']?.patch?.responses?.['409'])
  assert.equal(admin.paths['/connectors/mcp/agent-access'], undefined)
  assert.equal(admin.paths['/connectors/mcp/invocations']?.get?.operationId, 'listMcpInvocationAudits')
  assert.equal(admin.paths['/runtimes/dsh-tool-connector']?.get?.operationId, 'getDshRuntimeToolConnector')
  assert.equal(admin.paths['/runtimes/dsh-tool-connector/check']?.post?.operationId, 'checkDshRuntimeToolConnector')
})

before(async () => {
  const repository = new PrototypeRepository()
  const router = new Router({ authenticateApi: prototypeApiAuthenticator })
  registerUnavailableWorkbenchCommandRoutes(router)
  registerWorkbenchRoutes(router, new WorkbenchQueryService(repository))
  registerAdminRoutes(router, new AdminQueryService(repository))
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试 HTTP Server 没有获得端口')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

test('workbench and admin audiences return distinct typed envelopes', async () => {
  const workbench = await getJson<SessionEnvelope>('/api/workbench/v1/session')
  assert.equal(workbench.response.status, 200)
  assert.equal(workbench.body.meta.api, 'workbench')
  assert.equal(workbench.body.meta.adapter, 'prototype-memory')
  assert.equal(workbench.body.data.user.role, 'employee')

  const admin = await getJson<SessionEnvelope>('/api/admin/v1/session')
  assert.equal(admin.response.status, 200)
  assert.equal(admin.body.meta.api, 'admin')
  assert.equal(admin.body.data.user.role, 'platform_admin')
})

test('audience-specific routes do not leak into the other API namespace', async () => {
  const result = await getJson<ErrorEnvelope>('/api/workbench/v1/runtimes')
  assert.equal(result.response.status, 404)
  assert.equal(result.body.error.code, 'route_not_found')
  assert.equal(result.body.error.object, '当前接口')
  assert.match(result.body.error.traceId, /^trace-http-/)
})

test('removed management and detail routes stay unavailable', async () => {
  const removedRoutes = [
    '/api/admin/v1/roles',
    '/api/admin/v1/members',
    '/api/admin/v1/sessions/session-demo-001',
    '/api/workbench/v1/workspaces/ws-supply',
  ]
  for (const path of removedRoutes) {
    const result = await getJson<ErrorEnvelope>(path)
    assert.equal(result.response.status, 404, path)
    assert.equal(result.body.error.code, 'route_not_found', path)
  }
})

test('registered personal history reports unavailable persistence rather than a removed route', async () => {
  const result = await getJson<ErrorEnvelope>('/api/workbench/v1/sessions')
  assert.equal(result.response.status, 503)
  assert.equal(result.body.error.code, 'workbench_runtime_not_configured')
  assert.match(result.body.error.traceId, /^trace-http-/)
  assert.ok(result.body.error.suggestion)
  assert.equal('data' in result.body, false, 'missing persistence must not fabricate personal history')
})

test('operations DTOs omit metrics that are not collected', async () => {
  const runtimes = await getJson<RecordListEnvelope>('/api/admin/v1/runtimes')
  assert.equal(runtimes.response.status, 200)
  for (const runtime of runtimes.body.data) {
    assert.equal('cpuUsage' in runtime, false)
    assert.equal('memoryUsage' in runtime, false)
    assert.equal('latency' in runtime, false)
  }

  const health = await getJson<RecordListEnvelope>('/api/admin/v1/health')
  assert.equal(health.response.status, 200)
  for (const component of health.body.data) {
    assert.equal('latency' in component, false)
    assert.equal('availability' in component, false)
  }
})

test('prototype workbench Agent DTO exposes only published employee-safe fields', async () => {
  const result = await getJson<AgentEnvelope>('/api/workbench/v1/agents')
  assert.equal(result.response.status, 200)
  assert.ok(result.body.data.length >= 1)
  assert.ok(result.body.data.every(agent => agent.status === undefined))
  assert.ok(result.body.data.every(agent => agent.systemPrompt === undefined))
  assert.ok(result.body.data.every(agent => agent.owner === undefined))
})

test('prototype workbench Skill plaza exposes only published employee-safe fields', async () => {
  const result = await getJson<SkillEnvelope>('/api/workbench/v1/skills')
  assert.equal(result.response.status, 200)
  assert.equal(result.body.meta.adapter, 'prototype-memory')
  assert.ok(result.body.data.length >= 1)
  assert.ok(result.body.data.every(skill => skill.status === undefined))
  assert.ok(result.body.data.every(skill => skill.instructions === undefined))
  assert.ok(result.body.data.every(skill => skill.toolIds === undefined))
  assert.ok(result.body.data.every(skill => skill.testPrompt.length >= 4))
})

test('prototype workbench exposes exactly one default personal workspace', async () => {
  const result = await getJson<WorkspaceEnvelope>('/api/workbench/v1/workspaces')
  assert.equal(result.response.status, 200)
  const personal = result.body.data.filter(workspace => workspace.type === 'personal')
  assert.equal(personal.length, 1)
  assert.equal(personal[0]?.name, '我的空间')
})

test('prototype admin exposes the operations summary required by the global store', async () => {
  const result = await getJson<OperationsSummaryEnvelope>('/api/admin/v1/operations/summary')
  assert.equal(result.response.status, 200)
  assert.equal(result.body.meta.adapter, 'prototype-memory')
  assert.ok(result.body.data.runs24h > 0)
  assert.ok(result.body.data.modelTokens24h > 0)
  assert.ok(result.body.data.attentionEvents24h >= 0)
})

test('prototype admin exposes the asynchronous Skill test progress contract', async () => {
  const tools = await getJson<{ data: Array<{ id: string; status: string }> }>('/api/admin/v1/tools')
  const tool = tools.body.data.find(item => item.status !== 'disabled')
  assert.ok(tool)
  const createResponse = await fetch(`${baseUrl}/api/admin/v1/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '试运行进度测试',
      category: '测试',
      description: '用于验证异步 Skill 试运行进度接口。',
      instructions: '读取测试输入，执行确定性配置校验，并返回简明结果。',
      toolIds: [tool.id],
      testPrompt: '验证试运行进度',
    }),
  })
  const created = await createResponse.json() as { data: { skill: { id: string } } }
  assert.equal(createResponse.status, 200, JSON.stringify(created))

  const startResponse = await fetch(`${baseUrl}/api/admin/v1/skills/test-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skillId: created.data.skill.id, prompt: '验证试运行进度' }),
  })
  const started = await startResponse.json() as SkillTestProgressEnvelope
  assert.equal(startResponse.status, 202)
  assert.equal(started.data.status, 'passed')
  assert.ok(started.data.steps.some(step => step.status === 'completed'))

  const progress = await getJson<SkillTestProgressEnvelope>(`/api/admin/v1/skills/${created.data.skill.id}/test-runs/${started.data.runId}`)
  assert.equal(progress.response.status, 200)
  assert.equal(progress.body.data.runId, started.data.runId)
  assert.equal(progress.body.data.status, 'passed')
})

test('prototype admin lists and adds approved DSH tools without allowing duplicates', async () => {
  const catalog = await getJson<{ data: Array<{ id: string; status: string; defaultApprovalPolicy: string }> }>('/api/admin/v1/tools/catalog')
  assert.equal(catalog.response.status, 200)
  const candidate = catalog.body.data.find(item => item.status === 'ready')
  assert.ok(candidate)

  const invalid = await fetch(`${baseUrl}/api/admin/v1/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ catalogId: candidate.id, allowedRoles: [], dataScopes: [], approvalPolicy: candidate.defaultApprovalPolicy }),
  })
  assert.equal(invalid.status, 422)

  const response = await fetch(`${baseUrl}/api/admin/v1/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      catalogId: candidate.id,
      allowedRoles: ['试点员工'],
      dataScopes: ['当前工作空间'],
      approvalPolicy: candidate.defaultApprovalPolicy,
    }),
  })
  const body = await response.json() as { data: { id: string; approvalPolicy: string } }
  assert.equal(response.status, 200)
  assert.equal(body.data.id, candidate.id)
  assert.equal(body.data.approvalPolicy, candidate.defaultApprovalPolicy)

  const duplicate = await fetch(`${baseUrl}/api/admin/v1/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      catalogId: candidate.id,
      allowedRoles: ['试点员工'],
      dataScopes: ['当前工作空间'],
      approvalPolicy: candidate.defaultApprovalPolicy,
    }),
  })
  assert.equal(duplicate.status, 409)
})

test('prototype admin separates MCP management from the DSH Runtime tool connector', async () => {
  const connectors = await getJson<{ data: Array<{ id: string; protocol: string }> }>('/api/admin/v1/connectors')
  assert.equal(connectors.response.status, 200)
  assert.ok(connectors.body.data.length > 0)
  assert.ok(connectors.body.data.every(connector => connector.protocol === 'mcp'))
  assert.equal(connectors.body.data.some(connector => connector.id === 'connector-dsh-workspace'), false)

  const runtimeConnector = await getJson<{
    data: { runtimeId: string | null; connectorId: string; catalogDigest: string; toolCount: number }
  }>('/api/admin/v1/runtimes/dsh-tool-connector')
  assert.equal(runtimeConnector.response.status, 200)
  assert.equal(runtimeConnector.body.data.connectorId, 'connector-dsh-workspace')
  assert.ok(runtimeConnector.body.data.runtimeId)
  assert.ok(runtimeConnector.body.data.toolCount > 0)
  assert.match(runtimeConnector.body.data.catalogDigest, /^[a-f0-9]{64}$/)
})

test('unavailable conversation commands return an actionable 503 instead of a route 404', async () => {
  const response = await fetch(`${baseUrl}/api/workbench/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '测试对话' }),
  })
  const body = await response.json() as ErrorEnvelope

  assert.equal(response.status, 503)
  assert.equal(body.error.code, 'workbench_runtime_not_configured')
  assert.equal(body.error.object, '对话')
  assert.match(body.error.message, /对话服务不可用/)
  assert.match(body.error.suggestion, /联系管理员/)
  assert.match(body.error.traceId, /^trace-http-/)

  const deleteResponse = await fetch(`${baseUrl}/api/workbench/v1/sessions/session-demo-001`, {
    method: 'DELETE',
  })
  const deleteBody = await deleteResponse.json() as ErrorEnvelope
  assert.equal(deleteResponse.status, 503)
  assert.equal(deleteBody.error.code, 'workbench_runtime_not_configured')
  assert.equal(deleteBody.error.object, '对话 session-demo-001')
})

test('prototype run result route reports unavailable persistence rather than a route 404', async () => {
  // I-06：无库原型不提供真实结果投影；必须给出可操作的 503，不能 404 伪装成路由缺失。
  const result = await getJson<ErrorEnvelope>('/api/workbench/v1/runs/run-260828-001/result')
  assert.equal(result.response.status, 503)
  assert.equal(result.body.error.code, 'workbench_runtime_not_configured')
  assert.equal('data' in result.body, false)
})

test('prototype Task execution routes report unavailable persistence rather than version skew', async () => {
  for (const [method, path] of [
    ['POST', '/api/workbench/v1/task-executions'],
    ['GET', '/api/workbench/v1/task-executions/task-example'],
    ['GET', '/api/workbench/v1/task-executions/task-example/operations'],
    ['POST', '/api/workbench/v1/task-executions/task-example/cancel'],
    ['POST', '/api/workbench/v1/task-executions/task-example/retry'],
    ['POST', '/api/admin/v1/task-executions/task-example/operations/operation-example/resolve'],
  ] as const) {
    const response = await fetch(`${baseUrl}${path}`, { method })
    const body = await response.json() as ErrorEnvelope
    assert.equal(response.status, 503, `${method} ${path}`)
    assert.equal(body.error.code, 'workbench_runtime_not_configured')
  }
})

test('malformed management payloads use the shared actionable error contract', async () => {
  const response = await fetch(`${baseUrl}/api/admin/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"name":',
  })
  const body = await response.json() as ErrorEnvelope
  assert.equal(response.status, 422)
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'object', 'suggestion', 'traceId'].sort())
  assert.equal(body.error.code, 'invalid_request')
  assert.equal(body.error.object, 'Agent')
})

async function getJson<T>(path: string) {
  const response = await fetch(`${baseUrl}${path}`)
  return { response, body: await response.json() as T }
}
