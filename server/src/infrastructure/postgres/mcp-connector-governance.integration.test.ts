import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { PostgresEncryptedCredentialStore } from '../../modules/tool/postgres-encrypted-credential-store.ts'
import type { AgentRuntimePort, McpInspectionResult, McpRuntimeConnection, RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase | undefined
let service: PostgresToolConnectorService
let credentialSecrets: PostgresEncryptedCredentialStore
let discovered: McpInspectionResult['capabilities'] = []
let lastInspectedConnection: McpRuntimeConnection | undefined
let inspectionGate: Promise<void> | undefined
let notifyInspectionStarted: (() => void) | undefined

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
  async inspectMcpConnection(connection) {
    lastInspectedConnection = structuredClone(connection)
    notifyInspectionStarted?.()
    if (inspectionGate) await inspectionGate
    return { latencyMs: 5, capabilities: structuredClone(discovered) }
  },
  async close() {},
}

async function waitForBlockedConnectorCheck(sql: DatabaseClient) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [activity] = await sql<{ blocked: boolean }[]>`
      select exists (
        select 1 from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and wait_event_type = 'Lock'
           and state = 'active'
           and query ilike '%select status from connectors%'
      ) as blocked
    `
    if (activity?.blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('等待中的 Connector 检查未进入行锁竞争')
}

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_mcp_governance', maxConnections: 3 })
  database = throwaway.client
  credentialSecrets = new PostgresEncryptedCredentialStore(database, {
    masterKeyBase64: Buffer.alloc(32, 7).toString('base64'),
    keyId: 'integration-v1',
  })
  service = new PostgresToolConnectorService(database, runtime, undefined, credentialSecrets)
})

test('PF-03 encrypts, resolves, and rotates a Bearer Token without returning plaintext', async () => {
  const initialToken = `mcp-initial-${randomUUID()}`
  const rotatedToken = `mcp-rotated-${randomUUID()}`
  discovered = [{
    name: 'secured_read', description: 'Read secured data.',
    inputSchema: { type: 'object', properties: {} },
  }]

  await assert.rejects(new PostgresToolConnectorService(database, runtime).registerMcpConnector({
    name: '未配置主密钥 MCP',
    endpoint: 'https://missing-key.example.test/rpc',
    authType: 'bearer',
    bearerToken: initialToken,
    scopeDescription: '不得回退明文或环境引用',
    actor: 'U00008',
  }), /加密凭据存储未配置/)

  const registered = await service.registerMcpConnector({
    name: '安全数据 MCP',
    endpoint: 'https://secure-mcp.example.test/rpc',
    authType: 'bearer',
    bearerToken: initialToken,
    scopeDescription: '测试加密凭据边界',
    actor: 'U00008',
  })
  assert.match(registered.id, /^connector-mcp-/)
  assert.match(registered.mcp!.serverName, /^[A-Za-z0-9_-]{1,32}$/)
  assert.equal(registered.system, 'MCP')
  assert.equal(registered.credentialRef, 'Bearer Token 已加密存储')
  assert.doesNotMatch(JSON.stringify(registered), new RegExp(initialToken))

  const firstCheck = await service.checkConnector({ connectorId: registered.id, actor: 'U00008' })
  assert.equal(lastInspectedConnection?.headers.Authorization, `Bearer ${initialToken}`)
  await service.approveMcpConnector({
    connectorId: registered.id,
    capabilityDigest: firstCheck.mcp!.capabilityDigest!,
    actor: 'U00008',
  })
  const [stored] = await database<{
    backend: string; externalRef: string; credentialRefId: string; ciphertext: Uint8Array; version: number
  }[]>`
    select cr.backend, cr.external_ref as "externalRef", cs.credential_ref_id as "credentialRefId",
           cs.ciphertext, cs.version
      from connectors c
      join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
      join credential_secrets cs on cs.tenant_id = cr.tenant_id and cs.credential_ref_id = cr.id
     where c.tenant_id = 'tenant-dsh-work' and c.id = ${registered.id}
  `
  assert.equal(stored?.backend, 'postgres-encrypted')
  assert.equal(stored?.externalRef, stored?.credentialRefId)
  assert.equal(stored?.version, 1)
  assert.notEqual(Buffer.from(stored!.ciphertext).toString('utf8'), initialToken)

  let releaseInspection!: () => void
  inspectionGate = new Promise<void>(resolve => { releaseInspection = resolve })
  const inspectionStarted = new Promise<void>(resolve => { notifyInspectionStarted = resolve })
  const staleCheck = service.checkConnector({ connectorId: registered.id, actor: 'U00008' })
  await inspectionStarted
  let releaseCredentialUpdate!: () => void
  const holdCredentialUpdate = new Promise<void>(resolve => { releaseCredentialUpdate = resolve })
  let notifyCredentialLocked!: () => void
  const credentialLocked = new Promise<void>(resolve => { notifyCredentialLocked = resolve })
  const credentialUpdate = database.begin(async transaction => {
    await transaction`
      update connectors set status = 'degraded', updated_at = now()
       where tenant_id = 'tenant-dsh-work' and id = ${registered.id}
    `
    await credentialSecrets.rotate(transaction, {
      tenantId: 'tenant-dsh-work',
      credentialRefId: stored!.credentialRefId,
      bearerToken: rotatedToken,
      actorId: 'U00008',
    })
    notifyCredentialLocked()
    await holdCredentialUpdate
  })
  await credentialLocked
  try {
    releaseInspection()
    await waitForBlockedConnectorCheck(database)
  } finally {
    releaseCredentialUpdate()
    await credentialUpdate
  }
  const staleResult = await staleCheck
  inspectionGate = undefined
  notifyInspectionStarted = undefined
  assert.equal(staleResult.status, 'degraded', 'an old-token inspection must not restore healthy status')

  const currentCheck = await service.checkConnector({ connectorId: registered.id, actor: 'U00008' })
  assert.equal(currentCheck.status, 'healthy')
  assert.equal(lastInspectedConnection?.headers.Authorization, `Bearer ${rotatedToken}`)
  const [afterRotation] = await database<{ version: number }[]>`
    select cs.version
      from credential_secrets cs
      join connectors c on c.tenant_id = cs.tenant_id and c.credential_ref_id = cs.credential_ref_id
     where c.tenant_id = 'tenant-dsh-work' and c.id = ${registered.id}
  `
  assert.equal(afterRotation?.version, 2)

  await service.setMcpConnectorStatus({ connectorId: registered.id, status: 'disabled', actor: 'U00008' })
  const disabledRotationToken = `mcp-disabled-${randomUUID()}`
  const rotatedWhileDisabled = await service.rotateMcpCredential({
    connectorId: registered.id,
    bearerToken: disabledRotationToken,
    actor: 'U00008',
  })
  assert.equal(rotatedWhileDisabled.status, 'disabled')
  const checkedWhileDisabled = await service.checkConnector({ connectorId: registered.id, actor: 'U00008' })
  assert.equal(checkedWhileDisabled.status, 'disabled')
  assert.equal(lastInspectedConnection?.headers.Authorization, `Bearer ${disabledRotationToken}`)
})

test('PF-03 upgrades a legacy Connector without rotating another Connector that shared its reference', async () => {
  const suffix = randomUUID().slice(0, 8)
  const connectorId = `connector-legacy-mcp-${suffix}`
  const siblingConnectorId = `connector-legacy-mcp-sibling-${suffix}`
  const credentialId = `credential-legacy-mcp-${suffix}`
  const serverName = `legacy_${suffix}`
  const siblingServerName = `legacy_sibling_${suffix}`
  await database.begin(async transaction => {
    await transaction`
      insert into credential_refs (id, tenant_id, backend, external_ref, status, last_verified_at, updated_by)
      values (${credentialId}, 'tenant-dsh-work', 'dsh-managed', ${`DSH_MCP_CREDENTIAL_LEGACY_${suffix.toUpperCase()}`}, 'configured', now(), 'U00008')
    `
    await transaction`
      insert into connectors (
        id, tenant_id, key, name, connector_type, credential_ref_id, status,
        system, protocol, endpoint, auth_type, scope_description, updated_at
      ) values
        (${connectorId}, 'tenant-dsh-work', ${serverName}, '旧版 Bearer MCP', 'mcp', ${credentialId}, 'degraded',
         'MCP', 'mcp', 'https://legacy-mcp.example.test/rpc', 'bearer', '升级兼容测试', now()),
        (${siblingConnectorId}, 'tenant-dsh-work', ${siblingServerName}, '共享旧凭据 MCP', 'mcp', ${credentialId}, 'degraded',
         'MCP', 'mcp', 'https://legacy-mcp-sibling.example.test/rpc', 'bearer', '共享凭据隔离测试', now())
    `
    await transaction`
      insert into mcp_connector_profiles (tenant_id, connector_id, server_name)
      values
        ('tenant-dsh-work', ${connectorId}, ${serverName}),
        ('tenant-dsh-work', ${siblingConnectorId}, ${siblingServerName})
    `
    await transaction`
      insert into agent_mcp_grants (tenant_id, agent_id, connector_id, status, granted_by)
      values
        ('tenant-dsh-work', 'agent-dsh-work-assistant', ${connectorId}, 'active', 'U00008'),
        ('tenant-dsh-work', 'agent-dsh-work-assistant', ${siblingConnectorId}, 'active', 'U00008')
    `
  })

  const beforeUpgrade = (await service.getConnectors()).find(item => item.id === connectorId)
  assert.equal(beforeUpgrade?.credentialRef, 'Bearer Token 需要重新录入')
  await assert.rejects(
    service.setMcpConnectorStatus({ connectorId, status: 'enabled', actor: 'U00008' }),
    /需要先重新录入 Token/,
  )
  const failedLegacyCheck = await service.checkConnector({ connectorId, actor: 'U00008' })
  assert.equal(failedLegacyCheck.status, 'offline')

  const replacementToken = `legacy-replacement-${randomUUID()}`
  const upgraded = await service.rotateMcpCredential({
    connectorId,
    bearerToken: replacementToken,
    actor: 'U00008',
  })
  assert.equal(upgraded.id, connectorId)
  assert.equal(upgraded.credentialRef, 'Bearer Token 已加密存储')
  assert.equal(upgraded.status, 'degraded')
  const [evidence] = await database<{
    credentialRefId: string
    backend: string
    secretCount: number
    grantCount: number
  }[]>`
    select c.credential_ref_id as "credentialRefId", cr.backend,
           (select count(*)::int from credential_secrets cs
             where cs.tenant_id = c.tenant_id and cs.credential_ref_id = c.credential_ref_id) as "secretCount",
           (select count(*)::int from agent_mcp_grants g
             where g.tenant_id = c.tenant_id and g.connector_id = c.id and g.status = 'active') as "grantCount"
      from connectors c
      join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
     where c.tenant_id = 'tenant-dsh-work' and c.id = ${connectorId}
  `
  assert.equal(evidence?.backend, 'postgres-encrypted')
  assert.notEqual(evidence?.credentialRefId, credentialId)
  assert.equal(evidence?.secretCount, 1)
  assert.equal(evidence?.grantCount, 1)
  const [siblingEvidence] = await database<{ credentialRefId: string; backend: string; secretCount: number; grantCount: number }[]>`
    select c.credential_ref_id as "credentialRefId", cr.backend,
           (select count(*)::int from credential_secrets cs
             where cs.tenant_id = c.tenant_id and cs.credential_ref_id = c.credential_ref_id) as "secretCount",
           (select count(*)::int from agent_mcp_grants g
             where g.tenant_id = c.tenant_id and g.connector_id = c.id and g.status = 'active') as "grantCount"
      from connectors c
      join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
     where c.tenant_id = 'tenant-dsh-work' and c.id = ${siblingConnectorId}
  `
  assert.deepEqual(siblingEvidence, {
    credentialRefId: credentialId,
    backend: 'dsh-managed',
    secretCount: 0,
    grantCount: 1,
  })
  const siblingAfterUpgrade = (await service.getConnectors()).find(item => item.id === siblingConnectorId)
  assert.equal(siblingAfterUpgrade?.credentialRef, 'Bearer Token 需要重新录入')

  discovered = [{ name: 'legacy_read', description: 'Read legacy data.', inputSchema: { type: 'object', properties: {} } }]
  await service.checkConnector({ connectorId, actor: 'U00008' })
  assert.equal(lastInspectedConnection?.headers.Authorization, `Bearer ${replacementToken}`)
})

after(async () => {
  await throwaway?.dispose()
})

test('PF-03 governs an MCP server as one Connector grant and blocks capability drift', async () => {
  const suffix = randomUUID().slice(0, 8)
  discovered = [
    { name: 'customer_get', description: 'Read one customer.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    { name: 'customer_search', description: 'Search customers.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  ]

  const registered = await service.registerMcpConnector({
    name: 'CRM MCP',
    endpoint: 'https://mcp.example.test/rpc',
    authType: 'none',
    scopeDescription: '测试客户主数据',
    actor: 'U00008',
  })
  assert.equal(registered.protocol, 'mcp')
  const connectorId = registered.id
  const serverName = registered.mcp!.serverName
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
