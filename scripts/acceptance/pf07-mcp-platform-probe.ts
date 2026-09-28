/** Disposable PostgreSQL + actual Run/Attempt + DSH + loopback MCP write probe. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { startPf07McpFixture } from './pf07-mcp-fixture.mjs'
import { PostgresOperationsService } from '../../server/src/modules/admin/application/postgres-operations-service.ts'
import { PostgresAgentService } from '../../server/src/modules/agent/postgres-agent-service.ts'
import type { AgentMcpScope } from '../../server/src/domain/types.ts'
import { toManifestToolBinding } from '../../server/src/domain/tool-binding.ts'
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
let secondaryFixture: Awaited<ReturnType<typeof startPf07McpFixture>> | undefined
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
  await secondaryFixture?.close()
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

  secondaryFixture = await startPf07McpFixture({ token })
  const otherConnector = await toolService.registerMcpConnector({
    name: `PF-07 unselected ${nonce}`, endpoint: secondaryFixture.url, authType: 'bearer', bearerToken: token,
    scopeDescription: '同租户但不属于选定 Agent 使用范围的一次性连接器', actor: 'U00008',
  })
  assert.equal(otherConnector.status, 'healthy')

  // This disposable fixture publishes a second version directly so the real
  // Run/Attempt chain can validate the new selected-Connector policy. Release
  // approval itself is covered by the release-governance integration suite.
  const workInstructions = '先核对本次连接器的范围与操作键，再执行获准调用；结束前查询回执，无法核对时明确标记未知结果。'
  const defaultRefs = await toolService.resolvePlatformDefaultToolReferences(['role-employee'], ['workspace:authorized'])
  const sealedBindings = (await toolService.resolveToolBindings(defaultRefs)).map(toManifestToolBinding)
  async function createPublishedProbeAgent(suffix: string, mcpScope: AgentMcpScope) {
    const id = `agent-pf07-${suffix}-${nonce}`
    const created = await agents.createAgent({
      id, name: `一次性 ${suffix} 范围验证`,
      description: '仅在可丢弃本地服务中核对 Agent 的 MCP 使用范围。',
      owner: actorId, department: '验收', visibility: '指定角色',
      roleIds: ['role-employee'], dataScopes: ['workspace:authorized'],
      executionRoleIds: ['role-employee'], executionDataScopes: ['workspace:authorized'],
      welcomeMessage: '', examplePrompts: ['检查本次任务结果'],
      systemPrompt: '你是一次性 MCP 范围验收助手。只执行本次明确要求的任务，并核对结果。',
      workInstructions, skills: [], tools: [], mcpScope,
      maxOutputBytes: 65536, maxToolCalls: 12, timeoutSeconds: 180,
      changeSummary: '一次性真实 DSH 验证 MCP 使用范围', actor: 'U00008',
    })
    await database`
      update agent_versions set status = 'published', published_at = now(), published_by = 'U00008',
         binding_refs = ${database.json(sealedBindings)}
       where tenant_id = ${tenantId} and id = ${created.version.id} and status = 'draft'
    `
    await database`
      update agents set status = 'published', active_version_id = ${created.version.id}, draft_version_id = null
       where tenant_id = ${tenantId} and id = ${id}
    `
    return created
  }
  const selectedAgent = await createPublishedProbeAgent('selected', { mode: 'selected', connectorIds: [connector.id] })
  const selectedAgentId = selectedAgent.agent.id
  const selectedMember = await agentMembers.addAgentMember(workspaceId, selectedAgentId, actorId, ['role-employee'])
  const selectedSession = await orchestration.createSession({
    userId: actorId, workspaceId, title: 'PF-07 selected MCP scope', agentVersionId: selectedAgent.version.id,
  })
  const selectedOperationKey = `${operationKey}-selected`
  const selectedRun = await orchestration.startRun({
    userId: actorId, sessionId: selectedSession.id,
    prompt: `按工作规程执行：调用 mcp__${connector.mcp!.serverName}__put_receipt，参数为 operationKey="${selectedOperationKey}"、value="selected-scope"；再调用 mcp__${connector.mcp!.serverName}__get_receipt 查询相同 operationKey，只报告回执 ID。`,
    idempotencyKey: `pf07-selected-${nonce}`, workspaceAgentMemberId: selectedMember.id,
  })
  let selectedStatus = ''
  const selectedDeadline = Date.now() + 240_000
  while (Date.now() < selectedDeadline) {
    selectedStatus = (await runs.getRun(tenantId, selectedRun.id))?.status ?? ''
    if (['succeeded', 'failed', 'cancelled'].includes(selectedStatus)) break
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  assert.equal(selectedStatus, 'succeeded', `Selected-scope Run did not succeed: ${selectedStatus}`)
  const [selectedAttempt] = await database<{ id: string; manifest: { agent_configuration: { system_prompt: string }; tools: Array<{ id: string }>; mcp_connections?: Array<{ connector_id: string }> } }[]>`
    select id, manifest from run_attempts where tenant_id = ${tenantId} and run_id = ${selectedRun.id}
     order by attempt_no desc limit 1
  `
  assert.ok(selectedAttempt)
  assert.match(selectedAttempt.manifest.agent_configuration.system_prompt, /AGENTS\.md · 工作规程/)
  assert.ok(selectedAttempt.manifest.agent_configuration.system_prompt.includes(workInstructions))
  assert.deepEqual(selectedAttempt.manifest.mcp_connections?.map(item => item.connector_id), [connector.id])
  assert.ok(!JSON.stringify(selectedAttempt.manifest).includes(otherConnector.mcp!.serverName))
  assert.ok(selectedAttempt.manifest.tools.some(item => item.id === 'read'))
  assert.ok(selectedAttempt.manifest.tools.some(item => item.id === 'write'))
  assert.equal(fixture.getReceipt(selectedOperationKey)?.status, 'completed')
  assert.equal(secondaryFixture.getReceipt(selectedOperationKey), null)
  const [selectedAudit] = await database<{ count: number }[]>`
    select count(*)::int as count from mcp_invocation_audits
     where tenant_id = ${tenantId} and run_id = ${selectedRun.id} and attempt_id = ${selectedAttempt.id}
       and capability_name = 'put_receipt' and result = 'success'
  `
  assert.ok((selectedAudit?.count ?? 0) >= 1)

  const noneAgent = await createPublishedProbeAgent('none', { mode: 'none', connectorIds: [] })
  const noneMember = await agentMembers.addAgentMember(workspaceId, noneAgent.agent.id, actorId, ['role-employee'])
  const noneSession = await orchestration.createSession({
    userId: actorId, workspaceId, title: 'PF-07 no MCP scope', agentVersionId: noneAgent.version.id,
  })
  const noneRun = await orchestration.startRun({
    userId: actorId, sessionId: noneSession.id,
    prompt: `请使用 write 工具在 output/pf07-agent-output.md 写入一行“PF07_NONE_SCOPE_OK ${nonce}”，再用 read 工具核对该文件内容，最后简短回复。不要调用 MCP。`,
    idempotencyKey: `pf07-none-${nonce}`, workspaceAgentMemberId: noneMember.id,
  })
  let noneStatus = ''
  const noneDeadline = Date.now() + 240_000
  while (Date.now() < noneDeadline) {
    noneStatus = (await runs.getRun(tenantId, noneRun.id))?.status ?? ''
    if (['succeeded', 'failed', 'cancelled'].includes(noneStatus)) break
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  assert.equal(noneStatus, 'succeeded', `No-MCP Run did not succeed: ${noneStatus}`)
  const [noneAttempt] = await database<{ id: string; manifest: { mcp_connections?: Array<{ connector_id: string }> } }[]>`
    select id, manifest from run_attempts where tenant_id = ${tenantId} and run_id = ${noneRun.id}
     order by attempt_no desc limit 1
  `
  assert.ok(noneAttempt)
  assert.deepEqual(noneAttempt.manifest.mcp_connections ?? [], [])
  const [noneArtifact] = await database<{ id: string; name: string; storageKey: string }[]>`
    select av.id, a.name, fo.storage_key as "storageKey"
      from artifact_versions av
      join artifacts a on a.tenant_id = av.tenant_id and a.id = av.artifact_id
      join file_objects fo on fo.tenant_id = av.tenant_id and fo.id = av.file_object_id
     where av.tenant_id = ${tenantId} and av.source_run_id = ${noneRun.id}
       and av.source_attempt_id = ${noneAttempt.id}
  `
  assert.equal(noneArtifact?.name, 'pf07-agent-output.md')
  assert.match(await readFile(join(directory, 'storage', noneArtifact.storageKey), 'utf8'), new RegExp(`PF07_NONE_SCOPE_OK ${nonce}`))
  const [noneAudit] = await database<{ count: number }[]>`
    select count(*)::int as count from mcp_invocation_audits
     where tenant_id = ${tenantId} and run_id = ${noneRun.id}
  `
  assert.equal(noneAudit?.count ?? 0, 0)

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
  assert.deepEqual((await toolService.resolveMcpConnectionsForAgentVersion(agent.activeVersionId)).map(item => item.connector_id), [otherConnector.id])
  await assert.rejects(toolService.resolveMcpConnectionsForAgentVersion(selectedAgent.version.id))
  console.log(JSON.stringify({
    status: 'passed', scope: 'disposable-postgres-real-dsh-mcp-run',
    identity: 'synthetic', runtimeVersion: installation.version, runtimeCommit: installation.commit,
    connectorId: connector.id, runId: started.id, attemptId: attempt.id, receiptId: receipt.id,
    selectedScope: { agentVersionId: selectedAgent.version.id, runId: selectedRun.id, attemptId: selectedAttempt.id,
      connectorId: connector.id, excludedConnectorId: otherConnector.id, defaultToolRefs: defaultRefs },
    noneScope: { agentVersionId: noneAgent.version.id, runId: noneRun.id, attemptId: noneAttempt.id,
      artifactVersionId: noneArtifact.id },
    audits, boundaries: ['encrypted-credential', 'no-secret-in-manifest', 'invalid-credential-rejected', 'catalog-drift-rejected', 'disabled-rejected', 'deleted-rejected'],
  }))
} finally {
  await cleanup()
}
