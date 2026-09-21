import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import type { AgentRuntimePort, McpInspectionResult, RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase | undefined
let service: PostgresToolConnectorService
let discovered: McpInspectionResult['capabilities'] = []

const runtime: AgentRuntimePort = {
  async execute() { throw new Error('此测试不执行 Agent Loop') },
  subscribe() { return () => undefined },
  async cancel() { return { accepted: false } },
  status() { return undefined },
  async health() {
    return {
      status: 'healthy', runtimeId: 'runtime-local-01', activeExecutions: 0,
      acceptingRuns: true, dshRepository: '/test/deepseek-harness',
      transport: 'acp-stdio', message: 'test runtime',
    }
  },
  async inspectMcpConnection() { return { latencyMs: 5, capabilities: structuredClone(discovered) } },
  async close() {},
}

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_mcp_governance', maxConnections: 3 })
  database = throwaway.client
  service = new PostgresToolConnectorService(database, runtime)
})

after(async () => {
  await throwaway?.dispose()
})

test('PF-03 governs an MCP server as one Connector grant and blocks capability drift', async () => {
  const suffix = randomUUID().slice(0, 8)
  const connectorId = `connector-mcp-${suffix}`
  const serverName = `crm_${suffix}`
  discovered = [
    { name: 'customer_get', description: 'Read one customer.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    { name: 'customer_search', description: 'Search customers.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  ]

  const registered = await service.registerMcpConnector({
    id: connectorId,
    name: 'CRM MCP',
    system: 'CRM',
    serverName,
    endpoint: 'https://mcp.example.test/rpc',
    authType: 'none',
    scopeDescription: '测试客户主数据',
    actor: 'U00008',
  })
  assert.equal(registered.protocol, 'mcp')
  assert.equal(registered.mcp?.approvalStatus, 'draft')
  assert.equal(registered.toolCount, 0, 'MCP capabilities must not create platform Tool rows')

  const discoveredConnector = await service.checkConnector({ connectorId, actor: 'U00008' })
  assert.equal(discoveredConnector.status, 'degraded')
  assert.equal(discoveredConnector.mcp?.approvalStatus, 'pending_review')
  assert.equal(discoveredConnector.mcp?.capabilityCount, 2)

  const approved = await service.approveMcpConnector({
    connectorId, capabilityDigest: discoveredConnector.mcp!.capabilityDigest!, actor: 'U00008',
  })
  assert.equal(approved.status, 'healthy')
  assert.equal(approved.mcp?.approvalStatus, 'approved')
  assert.equal(approved.mcp?.approvedDigest, approved.mcp?.capabilityDigest)

  await service.setAgentMcpAccess({
    connectorId,
    agentId: 'agent-dsh-work-assistant',
    enabled: true,
    actor: 'U00008',
  })
  const pins = await service.resolveMcpConnectionsForAgentVersion('agent-version-dsh-work-assistant-1')
  assert.equal(pins.length, 1)
  assert.equal(pins[0]?.connector_id, connectorId)
  assert.equal(pins[0]?.server_name, serverName)
  assert.equal((await service.getTools()).some(tool => tool.connectorId === connectorId), false)

  discovered = [...discovered, {
    name: 'customer_export', description: 'Export customers.',
    inputSchema: { type: 'object', properties: {} },
  }]
  const changed = await service.checkConnector({ connectorId, actor: 'U00008' })
  assert.equal(changed.status, 'degraded')
  assert.equal(changed.mcp?.approvalStatus, 'changes_pending')
  assert.notEqual(changed.mcp?.capabilityDigest, changed.mcp?.approvedDigest)
  assert.deepEqual(await service.resolveMcpConnectionsForAgentVersion('agent-version-dsh-work-assistant-1'), [])
  await assert.rejects(
    service.assertActiveMcpConnections(pins, 'agent-version-dsh-work-assistant-1'),
    /授权已撤销或能力摘要已变化/,
  )
  await assert.rejects(service.approveMcpConnector({
    connectorId, capabilityDigest: approved.mcp!.approvedDigest!, actor: 'U00008',
  }), /能力清单已变化/)

  const reapproved = await service.approveMcpConnector({
    connectorId, capabilityDigest: changed.mcp!.capabilityDigest!, actor: 'U00008',
  })
  const currentPins = await service.resolveMcpConnectionsForAgentVersion('agent-version-dsh-work-assistant-1')
  assert.equal(currentPins.length, 1)
  assert.equal(currentPins[0]?.capability_digest, reapproved.mcp?.approvedDigest)

  const disabled = await service.setMcpConnectorStatus({
    connectorId, status: 'disabled', actor: 'U00008',
  })
  assert.equal(disabled.status, 'disabled')
  const checkedWhileDisabled = await service.checkConnector({ connectorId, actor: 'U00008' })
  assert.equal(checkedWhileDisabled.status, 'disabled', 'discovery must not undo an explicit administrative disable')
  assert.equal(checkedWhileDisabled.mcp?.approvalStatus, 'approved')
  assert.deepEqual(await service.resolveMcpConnectionsForAgentVersion('agent-version-dsh-work-assistant-1'), [])
  const explicitlyEnabled = await service.setMcpConnectorStatus({
    connectorId, status: 'enabled', actor: 'U00008',
  })
  assert.equal(explicitlyEnabled.status, 'healthy')
  assert.equal((await service.resolveMcpConnectionsForAgentVersion('agent-version-dsh-work-assistant-1')).length, 1)

  await service.setMcpConnectorStatus({ connectorId, status: 'disabled', actor: 'U00008' })
  discovered = discovered.map((capability, index) => index === 0
    ? { ...capability, description: `${capability.description} Reviewed revision.` }
    : capability)
  const changedWhileDisabled = await service.checkConnector({ connectorId, actor: 'U00008' })
  assert.equal(changedWhileDisabled.status, 'disabled')
  assert.equal(changedWhileDisabled.mcp?.approvalStatus, 'changes_pending')
  const reapprovedWhileDisabled = await service.approveMcpConnector({
    connectorId, capabilityDigest: changedWhileDisabled.mcp!.capabilityDigest!, actor: 'U00008',
  })
  assert.equal(reapprovedWhileDisabled.status, 'disabled', 'review must not undo an explicit administrative disable')
  assert.equal(reapprovedWhileDisabled.mcp?.approvalStatus, 'approved')
  assert.deepEqual(await service.resolveMcpConnectionsForAgentVersion('agent-version-dsh-work-assistant-1'), [])
  await service.setMcpConnectorStatus({ connectorId, status: 'enabled', actor: 'U00008' })
  const finalPins = await service.resolveMcpConnectionsForAgentVersion('agent-version-dsh-work-assistant-1')
  assert.equal(finalPins.length, 1)

  const runId = `run-mcp-${suffix}`
  const taskId = `task-mcp-${suffix}`
  const attemptId = `attempt-mcp-${suffix}`
  await database`
    insert into tasks (id, tenant_id, requested_by, source_type, correlation_key, budget_scope_task_id, status)
    values (${taskId}, 'tenant-dsh-work', 'U00008', 'api', ${`mcp-audit-${suffix}`}, ${taskId}, 'running')
  `
  await database`
    insert into runs (id, tenant_id, session_id, task_id, requested_by, idempotency_key, status)
    values (${runId}, 'tenant-dsh-work', null, ${taskId}, 'U00008', ${`mcp-audit-${suffix}`}, 'running')
  `
  await database`
    insert into run_attempts (
      id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256,
      model_route_snapshot, status
    ) values (
      ${attemptId}, 'tenant-dsh-work', ${runId}, 1, 'runtime-local-01', '{}'::jsonb,
      ${'a'.repeat(64)}, '{}'::jsonb, 'running'
    )
  `
  await service.recordMcpInvocation({
    run_id: runId,
    attempt_id: attemptId,
    user_context: { user_id: 'U00008', tenant_id: 'tenant-dsh-work', role_ids: ['role-platform-admin'] },
    mcp_connections: finalPins,
  } as unknown as RuntimeManifest, {
    serverName,
    callId: 'call-1',
    capabilityName: 'customer_get',
    parameterDigest: 'b'.repeat(64),
    result: 'success',
  })
  const audits = await database<{ connectorId: string; capabilityName: string; result: string }[]>`
    select connector_id as "connectorId", capability_name as "capabilityName", result
      from mcp_invocation_audits
     where tenant_id = 'tenant-dsh-work' and attempt_id = ${attemptId}
  `
  assert.deepEqual([...audits], [{ connectorId, capabilityName: 'customer_get', result: 'success' }])
  const projectedAudits = await service.listMcpInvocationAudits(connectorId)
  assert.equal(projectedAudits[0]?.attemptId, attemptId)
  assert.equal(projectedAudits[0]?.parameterDigest, 'b'.repeat(64))

  await service.setAgentMcpAccess({
    connectorId,
    agentId: 'agent-dsh-work-assistant',
    enabled: false,
    actor: 'U00008',
  })
  await assert.rejects(
    service.assertActiveMcpConnections(finalPins, 'agent-version-dsh-work-assistant-1'),
    /授权已撤销或能力摘要已变化/,
  )
})
