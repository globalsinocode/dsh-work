import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresMcpConnectorService } from '../../modules/tool/postgres-mcp-connector-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { PostgresEncryptedCredentialStore } from '../../modules/tool/postgres-encrypted-credential-store.ts'
import { MAX_MCP_CONNECTIONS_PER_ATTEMPT, type AgentRuntimePort, type McpInspectionResult, type McpRuntimeConnection, type RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase | undefined
let service: PostgresMcpConnectorService
let credentialSecrets: PostgresEncryptedCredentialStore
let discovered: McpInspectionResult['capabilities'] = []
let lastInspectedConnection: McpRuntimeConnection | undefined
let inspectionGate: Promise<void> | undefined
let notifyInspectionStarted: (() => void) | undefined
let inspectionFailure: Error | undefined
let inspectionCount = 0

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
    inspectionCount += 1
    lastInspectedConnection = structuredClone(connection)
    notifyInspectionStarted?.()
    if (inspectionGate) await inspectionGate
    if (inspectionFailure) throw inspectionFailure
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
  service = new PostgresMcpConnectorService(database, runtime, undefined, credentialSecrets)
})

test('PF-03 tests connection without persistence and registration rechecks before saving', async () => {
  const suffix = randomUUID().slice(0, 8)
  const token = `mcp-preflight-${suffix}`
  discovered = [{
    name: 'preflight_read', description: 'Read preflight data.',
    inputSchema: { type: 'object', properties: {} },
  }]
  const [before] = await database<{ connectorCount: number; credentialCount: number }[]>`
    select
      (select count(*)::int from connectors where tenant_id = 'tenant-dsh-work' and protocol = 'mcp') as "connectorCount",
      (select count(*)::int from credential_refs where tenant_id = 'tenant-dsh-work' and backend = 'postgres-encrypted') as "credentialCount"
  `
  const countBeforeTest = inspectionCount
  const tested = await service.testMcpConnection({
    name: `预检 MCP ${suffix}`,
    endpoint: 'https://preflight-mcp.example.test/rpc',
    authType: 'bearer',
    bearerToken: token,
    actor: 'U00008',
  })
  assert.equal(tested.status, 'reachable')
  assert.equal(tested.capabilityCount, 1)
  assert.equal(inspectionCount, countBeforeTest + 1)
  assert.equal(lastInspectedConnection?.headers.Authorization, `Bearer ${token}`)
  const [afterTest] = await database<{ connectorCount: number; credentialCount: number }[]>`
    select
      (select count(*)::int from connectors where tenant_id = 'tenant-dsh-work' and protocol = 'mcp') as "connectorCount",
      (select count(*)::int from credential_refs where tenant_id = 'tenant-dsh-work' and backend = 'postgres-encrypted') as "credentialCount"
  `
  assert.deepEqual(afterTest, before, 'connection test must not persist a Connector or credential')

  const registered = await service.registerMcpConnector({
    name: `预检 MCP ${suffix}`,
    endpoint: 'https://preflight-mcp.example.test/rpc',
    authType: 'bearer',
    bearerToken: token,
    scopeDescription: '预检后登记仍需服务端复核',
    actor: 'U00008',
  })
  assert.equal(inspectionCount, countBeforeTest + 2, 'registration must not trust a previous browser test')
  assert.equal(registered.status, 'healthy')
  assert.equal(registered.createdBy, '陈默')
  assert.match(registered.createdAt!, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(registered.updatedAt!, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(registered.mcp?.approvalStatus, 'approved')
  assert.equal(registered.mcp?.approvedDigest, registered.mcp?.capabilityDigest)
  assert.equal(registered.mcp?.capabilityCount, 1)

  const activeDigest = registered.mcp?.capabilityDigest
  discovered = []
  const emptyDiscovery = await service.checkMcpConnector({ connectorId: registered.id, actor: 'U00008' })
  assert.equal(emptyDiscovery.status, 'offline')
  assert.match(emptyDiscovery.lastHealthMessage ?? '', /未发现任何 Tool/)
  assert.equal(emptyDiscovery.mcp?.capabilityDigest, activeDigest, 'an empty discovery must not replace the effective snapshot')
  discovered = [{
    name: 'preflight_read', description: 'Read preflight data.',
    inputSchema: { type: 'object', properties: {} },
  }]
  assert.equal((await service.checkMcpConnector({ connectorId: registered.id, actor: 'U00008' })).status, 'healthy')

  await assert.rejects(service.testMcpConnection({
    name: '无效地址', endpoint: 'not-a-url', authType: 'none', actor: 'U00008',
  }), { status: 422, code: 'MCP_CONNECTION_INVALID' })

  inspectionFailure = Object.assign(new Error('MCP 认证失败：该服务要求 Bearer Token'), {
    status: 422,
    code: 'MCP_AUTHENTICATION_REQUIRED',
  })
  try {
    await assert.rejects(service.testMcpConnection({
      name: '需要认证的 MCP', endpoint: 'https://auth-required.example.test/rpc', authType: 'none', actor: 'U00008',
    }), {
      status: 422,
      code: 'MCP_AUTHENTICATION_REQUIRED',
      message: 'MCP 认证失败：该服务要求 Bearer Token',
    })
  } finally {
    inspectionFailure = undefined
  }

  const [beforeFailure] = await database<{ connectorCount: number }[]>`
    select count(*)::int as "connectorCount" from connectors
     where tenant_id = 'tenant-dsh-work' and protocol = 'mcp'
  `
  inspectionFailure = new Error('合成 MCP 离线')
  try {
    await assert.rejects(service.registerMcpConnector({
      name: `离线 MCP ${suffix}`,
      endpoint: 'https://offline-mcp.example.test/rpc',
      authType: 'none',
      scopeDescription: '失败时不得落库',
      actor: 'U00008',
    }), { status: 503, code: 'MCP_CONNECTION_TEST_FAILED' })
  } finally {
    inspectionFailure = undefined
  }
  const [afterFailure] = await database<{ connectorCount: number }[]>`
    select count(*)::int as "connectorCount" from connectors
     where tenant_id = 'tenant-dsh-work' and protocol = 'mcp'
  `
  assert.deepEqual(afterFailure, beforeFailure, 'failed registration recheck must not persist a Connector')
})

test('PF-03 encrypts, resolves, and rotates a Bearer Token without returning plaintext', async () => {
  const initialToken = `mcp-initial-${randomUUID()}`
  const rotatedToken = `mcp-rotated-${randomUUID()}`
  discovered = [{
    name: 'secured_read', description: 'Read secured data.',
    inputSchema: { type: 'object', properties: {} },
  }]

  await assert.rejects(new PostgresMcpConnectorService(database, runtime).registerMcpConnector({
    name: '未配置主密钥 MCP',
    endpoint: 'https://missing-key.example.test/rpc',
    authType: 'bearer',
    bearerToken: initialToken,
    scopeDescription: '不得回退明文或环境引用',
    actor: 'U00008',
  }), {
    status: 503,
    code: 'MCP_CREDENTIAL_STORE_UNAVAILABLE',
    message: 'MCP 加密凭据存储不可用：请配置 DSH_CREDENTIAL_MASTER_KEY 并重启服务',
  })

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

  await service.checkMcpConnector({ connectorId: registered.id, actor: 'U00008' })
  assert.equal(lastInspectedConnection?.headers.Authorization, `Bearer ${initialToken}`)
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
  const staleCheck = service.checkMcpConnector({ connectorId: registered.id, actor: 'U00008' })
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

  const currentCheck = await service.checkMcpConnector({ connectorId: registered.id, actor: 'U00008' })
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
  const checkedWhileDisabled = await service.checkMcpConnector({ connectorId: registered.id, actor: 'U00008' })
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
        system, protocol, endpoint, auth_type, scope_description, updated_at, created_by
      ) values
        (${connectorId}, 'tenant-dsh-work', ${serverName}, '旧版 Bearer MCP', 'mcp', ${credentialId}, 'degraded',
         'MCP', 'mcp', 'https://legacy-mcp.example.test/rpc', 'bearer', '升级兼容测试', now(), 'U00008'),
        (${siblingConnectorId}, 'tenant-dsh-work', ${siblingServerName}, '共享旧凭据 MCP', 'mcp', ${credentialId}, 'degraded',
         'MCP', 'mcp', 'https://legacy-mcp-sibling.example.test/rpc', 'bearer', '共享凭据隔离测试', now(), 'U00008')
    `
    await transaction`
      insert into mcp_connector_profiles (tenant_id, connector_id, server_name)
      values
        ('tenant-dsh-work', ${connectorId}, ${serverName}),
        ('tenant-dsh-work', ${siblingConnectorId}, ${siblingServerName})
    `
  })

  const beforeUpgrade = (await service.getMcpConnectors()).find(item => item.id === connectorId)
  assert.equal(beforeUpgrade?.credentialRef, 'Bearer Token 需要重新录入')
  await assert.rejects(
    service.setMcpConnectorStatus({ connectorId, status: 'enabled', actor: 'U00008' }),
    /需要先重新录入 Token/,
  )
  const failedLegacyCheck = await service.checkMcpConnector({ connectorId, actor: 'U00008' })
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
  }[]>`
    select c.credential_ref_id as "credentialRefId", cr.backend,
           (select count(*)::int from credential_secrets cs
             where cs.tenant_id = c.tenant_id and cs.credential_ref_id = c.credential_ref_id) as "secretCount"
      from connectors c
      join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
     where c.tenant_id = 'tenant-dsh-work' and c.id = ${connectorId}
  `
  assert.equal(evidence?.backend, 'postgres-encrypted')
  assert.notEqual(evidence?.credentialRefId, credentialId)
  assert.equal(evidence?.secretCount, 1)
  const [siblingEvidence] = await database<{ credentialRefId: string; backend: string; secretCount: number }[]>`
    select c.credential_ref_id as "credentialRefId", cr.backend,
           (select count(*)::int from credential_secrets cs
             where cs.tenant_id = c.tenant_id and cs.credential_ref_id = c.credential_ref_id) as "secretCount"
      from connectors c
      join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
     where c.tenant_id = 'tenant-dsh-work' and c.id = ${siblingConnectorId}
  `
  assert.deepEqual(siblingEvidence, {
    credentialRefId: credentialId,
    backend: 'dsh-managed',
    secretCount: 0,
  })
  const siblingAfterUpgrade = (await service.getMcpConnectors()).find(item => item.id === siblingConnectorId)
  assert.equal(siblingAfterUpgrade?.credentialRef, 'Bearer Token 需要重新录入')

  discovered = [{ name: 'legacy_read', description: 'Read legacy data.', inputSchema: { type: 'object', properties: {} } }]
  await service.checkMcpConnector({ connectorId, actor: 'U00008' })
  assert.equal(lastInspectedConnection?.headers.Authorization, `Bearer ${replacementToken}`)
})

after(async () => {
  await throwaway?.dispose()
})

test('PF-03 resolves only the Connectors an Agent Version selected and confirms capability changes', async () => {
  const suffix = randomUUID().slice(0, 8)
  const customerGet = { name: 'customer_get', description: 'Read one customer.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }
  const customerSearch = { name: 'customer_search', description: 'Search customers.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }
  const customerExport = { name: 'customer_export', description: 'Export customers.', inputSchema: { type: 'object', properties: {} } }
  discovered = [customerGet, customerSearch]

  const registered = await service.registerMcpConnector({
    name: 'CRM MCP', endpoint: 'https://mcp.example.test/rpc', authType: 'none',
    scopeDescription: '测试客户主数据', actor: 'U00008',
  })
  const connectorId = registered.id
  const serverName = registered.mcp!.serverName
  assert.equal(registered.protocol, 'mcp')
  assert.equal(registered.status, 'healthy')
  assert.equal(registered.mcp?.approvalStatus, 'approved')
  assert.equal(registered.mcp?.capabilityCount, 2)
  assert.deepEqual(registered.mcp?.pendingCapabilities, [])
  const [schemaEvidence] = await database<{ grantTable: string | null }[]>`
    select to_regclass('public.agent_mcp_grants')::text as "grantTable"
  `
  assert.equal(schemaEvidence?.grantTable, null, 'selection lives on the Agent Version, not in a grant table')

  // 只有显式选择的 Agent Version 才能拿到该连接器。
  const selected = { mode: 'selected' as const, connectorIds: [connectorId] }
  const pins = await service.resolveConnections(selected)
  assert.deepEqual(pins.map(pin => [pin.connector_id, pin.server_name]), [[connectorId, serverName]])
  assert.deepEqual(await service.resolveConnections({ mode: 'none', connectorIds: [] }), [])
  assert.deepEqual(await service.resolveConnections(undefined), [])
  const allPins = await service.resolveConnections({ mode: 'all', connectorIds: [] })
  assert.ok(allPins.some(pin => pin.connector_id === connectorId))
  await service.validateSelection([connectorId])
  await assert.rejects(service.validateSelection([connectorId, 'connector-mcp-missing']), { status: 422 })
  await service.assertPinnedConnections(pins)

  // 新增 Tool 进入待确认：不生效，也不影响已固定的 Attempt。
  discovered = [customerGet, customerSearch, customerExport]
  const added = await service.checkMcpConnector({ connectorId, actor: 'U00008' })
  assert.equal(added.status, 'healthy')
  assert.equal(added.mcp?.approvalStatus, 'changes_pending')
  assert.equal(added.mcp?.capabilityCount, 2)
  assert.deepEqual(added.mcp?.pendingCapabilities.map(item => item.name), ['customer_export'])
  assert.equal(added.mcp?.approvedDigest, registered.mcp?.approvedDigest)
  await service.assertPinnedConnections(pins)

  await assert.rejects(
    service.approveMcpCapabilities({ connectorId, capabilityDigest: registered.mcp!.capabilityDigest!, actor: 'U00008' }),
    { status: 409 },
    'confirmation must target the list the administrator actually saw',
  )
  const approved = await service.approveMcpCapabilities({ connectorId, capabilityDigest: added.mcp!.capabilityDigest!, actor: 'U00008' })
  assert.equal(approved.mcp?.approvalStatus, 'approved')
  assert.equal(approved.mcp?.capabilityCount, 3)
  assert.deepEqual(approved.mcp?.pendingCapabilities, [])
  await assert.rejects(service.assertPinnedConnections(pins), /生效能力已变化/,
    'an already prepared Attempt stays pinned to the list it started with')
  const approvedPins = await service.resolveConnections(selected)
  assert.equal(approvedPins[0]?.capability_digest, approved.mcp?.approvedDigest)

  // Schema 变化暂停该 Tool；远端删除的 Tool 立即下线；只改描述自动生效。
  const changedGet = { ...customerGet, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
  discovered = [changedGet, { ...customerExport, description: 'Export customers as CSV.' }]
  const changed = await service.checkMcpConnector({ connectorId, actor: 'U00008' })
  assert.equal(changed.mcp?.approvalStatus, 'changes_pending')
  assert.deepEqual(changed.mcp?.capabilities.map(item => [item.name, item.description]), [['customer_export', 'Export customers as CSV.']])
  assert.deepEqual(changed.mcp?.pendingCapabilities.map(item => item.name), ['customer_get'])
  const reapproved = await service.approveMcpCapabilities({ connectorId, capabilityDigest: changed.mcp!.capabilityDigest!, actor: 'U00008' })
  assert.deepEqual(reapproved.mcp?.capabilities.map(item => item.name), ['customer_export', 'customer_get'])

  const disabled = await service.setMcpConnectorStatus({ connectorId, status: 'disabled', actor: 'U00008' })
  assert.equal(disabled.status, 'disabled')
  const checkedWhileDisabled = await service.checkMcpConnector({ connectorId, actor: 'U00008' })
  assert.equal(checkedWhileDisabled.status, 'disabled', 'discovery must not undo an explicit administrative disable')
  await assert.rejects(service.resolveConnections(selected), /已选 MCP Connector 不可用/,
    'selected must fail closed when its Connector is disabled')
  assert.equal((await service.setMcpConnectorStatus({ connectorId, status: 'enabled', actor: 'U00008' })).status, 'healthy')
  const finalPins = await service.resolveConnections(selected)
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
  const manifest = {
    run_id: runId,
    attempt_id: attemptId,
    agent_version_id: 'agent-version-dsh-work-assistant-1',
    user_context: { user_id: 'U00008', tenant_id: 'tenant-dsh-work', role_ids: ['role-platform-admin'] },
    mcp_connections: finalPins,
  } as unknown as RuntimeManifest
  const [runtimeConnection] = await service.resolveRuntimeConnections(manifest)
  assert.deepEqual(runtimeConnection?.capabilities?.map(item => item.name), ['customer_export', 'customer_get'])
  await service.recordMcpInvocation(manifest, {
    serverName, callId: 'call-1', capabilityName: 'customer_get', parameterDigest: 'b'.repeat(64), result: 'success',
  })
  const audits = await database<{ connectorId: string; capabilityName: string; result: string }[]>`
    select connector_id as "connectorId", capability_name as "capabilityName", result
      from mcp_invocation_audits
     where tenant_id = 'tenant-dsh-work' and attempt_id = ${attemptId}
  `
  assert.deepEqual([...audits], [{ connectorId, capabilityName: 'customer_get', result: 'success' }])
  await service.finalizeMcpInvocationAudit({ run_id: runId, attempt_id: attemptId } as RuntimeManifest)
  const [auditState] = await database<{ finalized: boolean }[]>`
    select mcp_audit_finalized_at is not null as finalized from run_attempts
     where tenant_id = 'tenant-dsh-work' and id = ${attemptId}
  `
  assert.equal(auditState?.finalized, true)
  const projectedAudits = await service.listMcpInvocationAudits(connectorId)
  assert.equal(projectedAudits[0]?.attemptId, attemptId)
  assert.equal(projectedAudits[0]?.parameterDigest, 'b'.repeat(64))

  await service.setMcpConnectorStatus({ connectorId, status: 'disabled', actor: 'U00008' })
  await assert.rejects(service.assertPinnedConnections(finalPins), /已停用、删除或生效能力已变化/)

  const deletion = await service.deleteMcpConnector({ connectorId, actor: 'U00008' })
  assert.equal(deletion.credentialDestroyed, false)
  assert.equal((await service.getMcpConnectors()).some(connector => connector.id === connectorId), false)
  await assert.rejects(service.resolveConnections(selected), /已选 MCP Connector 不可用/)
  await assert.rejects(service.validateSelection([connectorId]), { status: 422 })
  const retainedAudits = await service.listMcpInvocationAudits(connectorId)
  assert.equal(retainedAudits[0]?.attemptId, attemptId, 'deletion must retain invocation evidence')
})

test('PF-03 deletion removes the Connector from Agent selections and destroys an exclusive encrypted credential', async () => {
  const suffix = randomUUID().slice(0, 8)
  discovered = [{
    name: 'deletion_read', description: 'Read deletion fixture.',
    inputSchema: { type: 'object', properties: {} },
  }]
  const registered = await service.registerMcpConnector({
    name: `待删除 MCP ${suffix}`,
    endpoint: 'https://delete-mcp.example.test/rpc',
    authType: 'bearer',
    bearerToken: `delete-token-${suffix}`,
    scopeDescription: '删除治理测试',
    actor: 'U00008',
  })
  const connectorId = registered.id
  const selected = { mode: 'selected' as const, connectorIds: [connectorId] }
  assert.equal((await service.resolveConnections(selected)).length, 1)
  const [before] = await database<{ credentialRefId: string }[]>`
    select credential_ref_id as "credentialRefId" from connectors
     where tenant_id = 'tenant-dsh-work' and id = ${connectorId}
  `
  assert.ok(before?.credentialRefId)

  const result = await service.deleteMcpConnector({ connectorId, actor: 'U00008' })
  assert.deepEqual(result, { connectorId, credentialDestroyed: true })
  const [evidence] = await database<{
    status: string; deletedAt: Date | null; deletedBy: string | null; credentialRefId: string | null;
    profileCount: number; healthCount: number;
    credentialRefCount: number; secretCount: number
  }[]>`
    select c.status, c.deleted_at as "deletedAt", c.deleted_by as "deletedBy",
           c.credential_ref_id as "credentialRefId",
           (select count(*)::int from mcp_connector_profiles p
             where p.tenant_id = c.tenant_id and p.connector_id = c.id) as "profileCount",
           (select count(*)::int from connector_health_checks h
             where h.tenant_id = c.tenant_id and h.connector_id = c.id) as "healthCount",
           (select count(*)::int from credential_refs cr
             where cr.tenant_id = c.tenant_id and cr.id = ${before!.credentialRefId}) as "credentialRefCount",
           (select count(*)::int from credential_secrets cs
             where cs.tenant_id = c.tenant_id and cs.credential_ref_id = ${before!.credentialRefId}) as "secretCount"
      from connectors c
     where c.tenant_id = 'tenant-dsh-work' and c.id = ${connectorId}
  `
  assert.equal(evidence?.status, 'disabled')
  assert.ok(evidence?.deletedAt)
  assert.equal(evidence?.deletedBy, 'U00008')
  assert.equal(evidence?.credentialRefId, null)
  assert.equal(evidence?.profileCount, 1)
  assert.ok((evidence?.healthCount ?? 0) >= 1)
  assert.equal(evidence?.credentialRefCount, 0)
  assert.equal(evidence?.secretCount, 0)
  await assert.rejects(service.resolveConnections(selected), /已选 MCP Connector 不可用/)
  await assert.rejects(service.deleteMcpConnector({ connectorId, actor: 'U00008' }), /不存在/)
})

test('PF-03 has no tenant-wide Connector cap; the per-Attempt limit applies to each Agent selection', async () => {
  const suffix = randomUUID().slice(0, 8)
  discovered = [{ name: 'capacity_read', description: 'Read capacity test data.', inputSchema: { type: 'object', properties: {} } }]
  const ids: string[] = []
  for (let index = 0; index <= MAX_MCP_CONNECTIONS_PER_ATTEMPT; index += 1) {
    ids.push((await service.registerMcpConnector({
      name: `容量 MCP ${index} ${suffix}`,
      endpoint: `https://capacity-${index}-${suffix}.example.test/rpc`,
      authType: 'none',
      scopeDescription: '租户不再限制连接器总数',
      actor: 'U00008',
    })).id)
  }
  const [final] = await database<{ connectorCount: number }[]>`
    select count(*)::int as "connectorCount" from connectors
     where tenant_id = 'tenant-dsh-work' and protocol = 'mcp' and status = 'healthy' and deleted_at is null
  `
  assert.ok(final!.connectorCount > MAX_MCP_CONNECTIONS_PER_ATTEMPT)
  await assert.rejects(service.resolveConnections({ mode: 'selected', connectorIds: ids }), { status: 422 })
  assert.equal((await service.resolveConnections({ mode: 'selected', connectorIds: ids.slice(0, MAX_MCP_CONNECTIONS_PER_ATTEMPT) })).length, MAX_MCP_CONNECTIONS_PER_ATTEMPT)
})

test('Tool service registration, credential rotation and check keep approved snapshot resolvable', async () => {
  const managed = new PostgresToolConnectorService(database, runtime, undefined, credentialSecrets)
  const runtimeScope = new PostgresMcpConnectorService(database, runtime, undefined, credentialSecrets)
  const suffix = randomUUID().slice(0, 8)
  discovered = [
    { name: 'customer_get', description: '读取客户', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    { name: 'customer_search', description: '搜索客户', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  ]
  const connector = await managed.registerMcpConnector({
    name: `跨服务 MCP ${suffix}`,
    endpoint: `https://cross-service-${suffix}.example.test/rpc`,
    authType: 'bearer',
    bearerToken: `initial-${suffix}`,
    scopeDescription: '跨服务生效快照测试',
    actor: 'U00008',
  })
  await managed.rotateMcpCredential({ connectorId: connector.id, bearerToken: `rotated-${suffix}`, actor: 'U00008' })
  await managed.checkMcpConnector({ connectorId: connector.id, actor: 'U00008' })
  const resolved = await runtimeScope.resolveConnections({ mode: 'selected', connectorIds: [connector.id] })
  assert.equal(resolved.length, 1)
  const [profile] = await database<{ approvedLength: number }[]>`
    select jsonb_array_length(approved_snapshot) as "approvedLength"
      from mcp_connector_profiles where tenant_id = 'tenant-dsh-work' and connector_id = ${connector.id}
  `
  assert.ok((profile?.approvedLength ?? 0) > 0)
})
