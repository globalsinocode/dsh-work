/** Disposable PostgreSQL + actual Run/Attempt + DSH + loopback MCP write probe. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { startPf07McpFixture } from './pf07-mcp-fixture.mjs'
import { PostgresOperationsService } from '../../server/src/modules/admin/application/postgres-operations-service.ts'
import { PostgresAgentService } from '../../server/src/modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../../server/src/modules/authorization/postgres-authorization-service.ts'
import { createThrowawayDatabase, requireMaintenanceUrl } from '../../server/src/infrastructure/postgres/test-database.ts'
import { ModelGovernanceService } from '../../server/src/modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../server/src/modules/model/postgres-model-governance-repository.ts'
import { PostgresRunRepository } from '../../server/src/modules/run/postgres-run-repository.ts'
import { RunOrchestrationService } from '../../server/src/modules/run/run-orchestration-service.ts'
import { DshAcpRuntimeAdapter } from '../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts'
import { preflightDshRuntime, resolveDshRuntimeInstallation } from '../../server/src/modules/runtime/dsh-runtime-installation.ts'
import { PostgresEncryptedCredentialStore } from '../../server/src/modules/tool/postgres-encrypted-credential-store.ts'
import { PostgresToolConnectorService } from '../../server/src/modules/tool/postgres-tool-connector-service.ts'
import { PostgresContentService } from '../../server/src/modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../../server/src/modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresWorkspaceAgentMemberService } from '../../server/src/modules/workbench/application/postgres-workspace-agent-member-service.ts'

const maintenanceUrl = new URL(requireMaintenanceUrl())
if (!['localhost', '127.0.0.1', '::1'].includes(maintenanceUrl.hostname)) {
  throw new Error('PF-07 probe only accepts a loopback PostgreSQL maintenance host')
}
const projectRoot = resolve(import.meta.dirname, '../..')
const installation = await resolveDshRuntimeInstallation({ projectRoot })
await preflightDshRuntime(installation)

const tenantId = 'tenant-dsh-work'
const nonce = randomUUID().slice(0, 8)
const actorId = `user-pf07-${nonce}`
const workspaceId = `ws-pf07-${nonce}`
const operationKey = `pf07-${nonce}`
const token = randomBytes(32).toString('hex')
const fixture = await startPf07McpFixture({ token })
const directory = await mkdtemp(join(tmpdir(), 'pf07-mcp-platform-'))
let disposable: Awaited<ReturnType<typeof createThrowawayDatabase>> | undefined
let runtime: DshAcpRuntimeAdapter | undefined
let orchestration: RunOrchestrationService | undefined
let toolService: PostgresToolConnectorService | undefined
let cleanedUp = false

async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  await orchestration?.close().catch(() => undefined)
  await runtime?.close().catch(() => undefined)
  await disposable?.dispose()
  await fixture.close()
  await rm(directory, { recursive: true, force: true })
}

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(exitCode)) })
}

try {
  disposable = await createThrowawayDatabase({ namePrefix: 'dsh_work_pf07_mcp', maxConnections: 8 })
  const database = disposable.client
  const authorization = new PostgresAuthorizationService(database)
  const conversations = new PostgresConversationRepository(database)
  const content = new PostgresContentService(database, resolve(directory, 'storage'), authorization)
  const runs = new PostgresRunRepository(database)
  runtime = new DshAcpRuntimeAdapter({
    runtimeId: 'runtime-local-01',
    runtimeRoot: resolve(directory, 'attempts'),
    dshRepository: installation.home,
    runtimeVersion: installation.version,
    runtimeCommit: installation.commit,
    protocolVersion: installation.protocolVersion,
    launchMode: installation.launchMode,
    process: installation.process,
    authorizeExecution: async manifest => {
      if (!orchestration) throw new Error('orchestration is unavailable')
      await orchestration.assertCurrentRunAuthorization(manifest)
    },
    resolveMcpConnections: async manifest => {
      if (!toolService) throw new Error('connector service is unavailable')
      return toolService.resolveMcpRuntimeConnections(manifest)
    },
    recordMcpInvocation: async (manifest, invocation) => {
      if (!toolService) throw new Error('connector service is unavailable')
      await toolService.recordMcpInvocation(manifest, invocation)
    },
    permissionDecision: async () => 'allow_once',
    collectArtifacts: (manifest, workspaceDirectory) => content.publishRuntimeArtifacts({ manifest, workspaceDirectory }),
  })
  const operations = new PostgresOperationsService(database, runtime, authorization, 'mock')
  const secrets = new PostgresEncryptedCredentialStore(database, {
    masterKeyBase64: randomBytes(32).toString('base64'), keyId: 'pf07-disposable',
  })
  toolService = new PostgresToolConnectorService(database, runtime, operations, secrets)
  const agents = new PostgresAgentService(database, operations, undefined, toolService)
  const agentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
  orchestration = new RunOrchestrationService(
    runs, conversations, new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime, content, operations, agents, undefined, authorization,
    { agentMembers, toolBindings: toolService },
  )

  await database`
    insert into users (id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user)
    values (${actorId}, ${tenantId}, ${`directory:${actorId}`}, 'PF-07 一次性测试用户', null, 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${actorId}, 'role-employee', 'local')
  `
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, 'PF-07 一次性 MCP 空间', '', 'team', ${actorId}, 'active')
  `
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values (${tenantId}, ${workspaceId}, ${actorId}, 'owner', ${actorId})
  `
  const connector = await toolService.registerMcpConnector({
    name: `PF-07 disposable ${nonce}`, endpoint: fixture.url, authType: 'bearer', bearerToken: token,
    scopeDescription: '仅本机一次性验收回执，不含业务数据', actor: 'U00008',
  })
  assert.equal(connector.status, 'healthy')
  const agentMember = await agentMembers.addAgentMember(workspaceId, 'agent-dsh-work-assistant', actorId, ['role-employee'])
  const [agent] = await database<{ activeVersionId: string | null }[]>`
    select active_version_id as "activeVersionId" from agents
     where tenant_id = ${tenantId} and id = 'agent-dsh-work-assistant'
  `
  assert.ok(agent?.activeVersionId)
  const session = await orchestration.createSession({
    userId: actorId, workspaceId, title: 'PF-07 MCP disposable write', agentVersionId: agent.activeVersionId,
  })
  const started = await orchestration.startRun({
    userId: actorId, sessionId: session.id,
    prompt: `请调用 mcp__${connector.mcp!.serverName}__put_receipt，参数严格为 operationKey="${operationKey}"、value="disposable-write"；接着调用 mcp__${connector.mcp!.serverName}__get_receipt 查询相同 operationKey，并只报告回执 ID。`,
    idempotencyKey: `pf07-${nonce}`,
    workspaceAgentMemberId: agentMember.id,
  })
  assert.ok(started)
  const deadline = Date.now() + 240_000
  let status = ''
  while (Date.now() < deadline) {
    status = (await runs.getRun(tenantId, started.id))?.status ?? ''
    if (['succeeded', 'failed', 'cancelled'].includes(status)) break
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  assert.equal(status, 'succeeded', `Run did not succeed: ${status}`)
  const [attempt] = await database<{ id: string; status: string }[]>`
    select id, status from run_attempts where tenant_id = ${tenantId} and run_id = ${started.id}
     order by attempt_no desc limit 1
  `
  assert.equal(attempt?.status, 'succeeded')
  const receipt = fixture.getReceipt(operationKey)
  assert.equal(receipt?.status, 'completed')
  const audits = await database<{ capabilityName: string; result: string }[]>`
    select capability_name as "capabilityName", result from mcp_invocation_audits
     where tenant_id = ${tenantId} and run_id = ${started.id} and attempt_id = ${attempt.id}
  `
  assert.ok(audits.some(row => row.capabilityName === 'put_receipt' && row.result === 'success'))
  assert.ok(audits.some(row => row.capabilityName === 'get_receipt' && row.result === 'success'))
  const pinned = await toolService.resolveMcpConnectionsForAgentVersion(agent.activeVersionId)
  assert.equal(pinned.length, 1)
  const [manifestRow] = await database<{ manifest: unknown }[]>`
    select manifest from run_attempts where tenant_id = ${tenantId} and id = ${attempt.id}
  `
  assert.ok(!JSON.stringify(manifestRow?.manifest).includes(token), 'Manifest must never persist the bearer secret')
  const [secretRow] = await database<{ ciphertext: Uint8Array }[]>`
    select cs.ciphertext from credential_secrets cs
      join connectors c on c.tenant_id = cs.tenant_id and c.credential_ref_id = cs.credential_ref_id
     where c.tenant_id = ${tenantId} and c.id = ${connector.id}
  `
  assert.ok(secretRow?.ciphertext.byteLength)
  assert.ok(!Buffer.from(secretRow.ciphertext).toString('utf8').includes(token), 'Credential must be encrypted')

  await toolService.rotateMcpCredential({ connectorId: connector.id, bearerToken: `${token}-invalid`, actor: 'U00008' })
  assert.equal((await toolService.checkConnector({ connectorId: connector.id, actor: 'U00008' })).status, 'offline')
  await assert.rejects(toolService.assertActiveMcpConnections(pinned, agent.activeVersionId))
  await toolService.rotateMcpCredential({ connectorId: connector.id, bearerToken: token, actor: 'U00008' })
  assert.equal((await toolService.checkConnector({ connectorId: connector.id, actor: 'U00008' })).status, 'healthy')

  fixture.setCatalogVersion(2)
  assert.equal((await toolService.checkConnector({ connectorId: connector.id, actor: 'U00008' })).status, 'healthy')
  await assert.rejects(toolService.assertActiveMcpConnections(pinned, agent.activeVersionId))
  const changedPins = await toolService.resolveMcpConnectionsForAgentVersion(agent.activeVersionId)
  assert.notEqual(changedPins[0]?.capability_digest, pinned[0]?.capability_digest)
  await toolService.setMcpConnectorStatus({ connectorId: connector.id, status: 'disabled', actor: 'U00008' })
  await assert.rejects(toolService.assertActiveMcpConnections(changedPins, agent.activeVersionId))
  await toolService.deleteMcpConnector({ connectorId: connector.id, actor: 'U00008' })
  assert.deepEqual(await toolService.resolveMcpConnectionsForAgentVersion(agent.activeVersionId), [])
  console.log(JSON.stringify({
    status: 'passed', scope: 'disposable-postgres-real-dsh-mcp-run',
    identity: 'synthetic', runtimeVersion: installation.version, runtimeCommit: installation.commit,
    connectorId: connector.id, runId: started.id, attemptId: attempt.id, receiptId: receipt.id,
    audits, boundaries: ['encrypted-credential', 'no-secret-in-manifest', 'invalid-credential-rejected', 'catalog-drift-rejected', 'disabled-rejected', 'deleted-rejected'],
  }))
} finally {
  await cleanup()
}
