import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresTaskRepository } from '../../modules/task/postgres-task-repository.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
let throwaway: ThrowawayDatabase
let database: DatabaseClient

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_agent_principal_test', maxConnections: 4 })
  database = throwaway.client
})

after(async () => {
  await throwaway?.dispose()
})

test('new Agent has a stable principal distinct from its governance owner, and disabling it blocks execution', async () => {
  const [systemPrincipal] = await database<{ kind: string; systemKey: string }[]>`
    select kind, system_key as "systemKey" from execution_principals
     where tenant_id = ${tenantId} and kind = 'system'
  `
  assert.deepEqual(systemPrincipal, { kind: 'system', systemKey: 'platform' })
  const [seededAgentPrincipal] = await database<{ kind: string }[]>`
    select kind from execution_principals
     where tenant_id = ${tenantId} and agent_id = 'agent-dsh-work-assistant'
  `
  assert.equal(seededAgentPrincipal?.kind, 'agent')

  const actor = `user-principal-${randomUUID()}`
  const agentId = `agent-principal-${randomUUID().slice(0, 20)}`
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
    values (${actor}, ${tenantId}, ${`directory:${actor}`}, '治理负责人', 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${actor}, 'role-platform-admin', 'local')
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${actor}, 'role-employee', 'local')
  `
  const agents = new PostgresAgentService(database)
  const created = await agents.createAgent({
    id: agentId,
    name: '独立身份测试 Agent',
    description: '验证 Agent 执行身份和治理负责人是不同的主体。',
    owner: '治理负责人',
    department: '平台治理',
    visibility: '指定角色',
    roleIds: ['role-employee'],
    dataScopes: ['workspace:authorized'],
    welcomeMessage: '',
    examplePrompts: ['整理这段文字'],
    systemPrompt: '你是文本整理 Agent，只使用当前输入，不能推断缺失的事实。',
    maxOutputBytes: 65536,
    maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: [],
    tools: [],
    changeSummary: '创建独立身份测试草稿',
    actor,
  })

  const [principal] = await database<{
    id: string; kind: string; agentId: string; humanUserId: string | null; status: string; ownerUserId: string
  }[]>`
    select ep.id, ep.kind, ep.agent_id as "agentId", ep.human_user_id as "humanUserId",
           ep.status, a.owner_user_id as "ownerUserId"
      from execution_principals ep
      join agents a on a.tenant_id = ep.tenant_id and a.id = ep.agent_id
     where ep.tenant_id = ${tenantId} and ep.agent_id = ${agentId}
  `
  assert.deepEqual(principal, {
    id: `principal-agent-${agentId}`,
    kind: 'agent',
    agentId,
    humanUserId: null,
    status: 'active',
    ownerUserId: actor,
  })
  const [human] = await database<{ kind: string; agentId: string | null }[]>`
    select kind, agent_id as "agentId" from execution_principals
     where tenant_id = ${tenantId} and human_user_id = ${actor}
  `
  assert.deepEqual(human, { kind: 'human', agentId: null })

  const versionId = created.version.id
  await agents.getRuntimeSnapshot(versionId)
  await database`
    update agent_versions set status = 'published' where tenant_id = ${tenantId} and id = ${versionId}
  `
  await database`
    update agents set status = 'published', active_version_id = ${versionId}, draft_version_id = null
     where tenant_id = ${tenantId} and id = ${agentId}
  `
  const authorization = new PostgresAuthorizationService(database)
  await authorization.assertAgentDependencyClosure(versionId)
  await authorization.requireActiveAgentPrincipal(versionId)
  assert.equal((await agents.listWorkbenchAgents(actor)).some(agent => agent.id === agentId), true)
  await database`
    insert into data_scope_grants (id, tenant_id, subject_type, subject_id, scope_code, scope_value)
    values (${`grant-${randomUUID()}`}, ${tenantId}, 'user', ${actor}, 'capability', 'workspace:authorized')
  `
  const ungranted = await agents.getAgentPrincipal(agentId)
  assert.deepEqual({ roles: ungranted.roleIds, scopes: ungranted.dataScopes }, { roles: [], scopes: [] })
  await assert.rejects(authorization.authorizeRuntime({ userId: actor, agentVersionId: versionId }),
    /当前用户角色不可使用所选 Agent/)
  await agents.updateAgentPrincipal({ agentId, actor,
    expectedAuthorizationVersion: ungranted.authorizationVersion,
    status: 'active', roleIds: ['role-employee'], dataScopes: ['workspace:authorized'],
  })
  const initialDecision = await authorization.authorizeRuntime({ userId: actor, agentVersionId: versionId })
  assert.equal(initialDecision.executorPrincipalId, principal.id)
  assert.deepEqual(initialDecision.dataScopes, ['workspace:authorized'])
  assert.deepEqual(await authorization.resolveAgentPrincipalTrialScope(versionId,
    ['role-employee', 'role-platform-admin'], ['workspace:authorized', 'enterprise:authorized']),
  { roleIds: ['role-employee'], dataScopes: ['workspace:authorized'] })
  const originalGrant = await agents.getAgentPrincipal(agentId)
  const revoked = await agents.updateAgentPrincipal({ agentId, actor,
    expectedAuthorizationVersion: originalGrant.authorizationVersion,
    status: 'active', roleIds: ['role-employee'], dataScopes: [],
  })
  assert.equal(revoked.dataScopes.length, 0)
  await assert.rejects(authorization.authorizeRuntime({ userId: actor, agentVersionId: versionId }),
    /workspace:authorized/)
  await assert.rejects(agents.updateAgentPrincipal({ agentId, actor,
    expectedAuthorizationVersion: originalGrant.authorizationVersion,
    status: 'active', roleIds: ['role-employee'], dataScopes: ['workspace:authorized'],
  }), /授权已变化/)
  await agents.updateAgentPrincipal({ agentId, actor,
    expectedAuthorizationVersion: revoked.authorizationVersion,
    status: 'active', roleIds: ['role-employee'], dataScopes: ['workspace:authorized'],
  })

  const tasks = new PostgresTaskRepository(database)
  const task = await tasks.createTask({
    tenantId, requestedBy: actor, sourceType: 'api', correlationKey: `principal-${randomUUID()}`,
  })
  assert.equal(task.requestedBy, actor)
  assert.equal(task.initiatedByPrincipalId, `principal-human-${actor}`)
  assert.equal(task.executedAsPrincipalId, null)
  assert.equal(task.approvedByPrincipalId, null)
  const runId = `run-principal-${randomUUID()}`
  await database`
    insert into runs (id, tenant_id, task_id, session_id, requested_by, idempotency_key, status)
    values (${runId}, ${tenantId}, ${task.id}, null, ${actor}, ${`principal-${randomUUID()}`}, 'queued')
  `
  const pinnedRevision = (await agents.getAgentPrincipal(agentId)).authorizationVersion
  await assert.rejects(database`
    insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status)
    values (${`attempt-${randomUUID()}`}, ${tenantId}, ${runId}, 1,
      ${database.json({ agent_version_id: versionId, principal_context: {
        initiated_by: task.initiatedByPrincipalId, executed_as: `principal-human-${actor}`,
        disclosure_user_id: actor, executor_authorization_version: pinnedRevision,
      } })}, ${'c'.repeat(64)}, ${database.json({})}, 'queued')
  `, /Attempt principal context does not match/)
  await database`
    insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status)
    values (${`attempt-${randomUUID()}`}, ${tenantId}, ${runId}, 1,
      ${database.json({ agent_version_id: versionId, principal_context: {
        initiated_by: task.initiatedByPrincipalId, executed_as: principal.id,
        disclosure_user_id: actor, executor_authorization_version: pinnedRevision,
      } })}, ${'a'.repeat(64)}, ${database.json({})}, 'queued')
  `
  assert.equal((await tasks.getTask(tenantId, task.id))?.executedAsPrincipalId, `principal-agent-${agentId}`)
  await assert.rejects(database`
    insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status)
    values (${`attempt-${randomUUID()}`}, ${tenantId}, ${runId}, 2,
      ${database.json({ agent_version_id: null })}, ${'b'.repeat(64)}, ${database.json({})}, 'queued')
  `, /Task executor principal cannot change/)

  const systemTask = await tasks.createTask({
    tenantId, requestedBy: actor, sourceType: 'system', correlationKey: `principal-${randomUUID()}`,
  })
  assert.equal(systemTask.initiatedByPrincipalId, `principal-system-${tenantId}`)
  const forgedTaskId = `task-${randomUUID()}`
  await assert.rejects(database`
    insert into tasks (id, tenant_id, requested_by, source_type, correlation_key,
      budget_scope_task_id, status, initiated_by_principal_id)
    values (${forgedTaskId}, ${tenantId}, ${actor}, 'api', ${`principal-${randomUUID()}`},
      ${forgedTaskId}, 'accepted', ${systemTask.initiatedByPrincipalId})
  `, /Task initiator principal does not match/)
  await database`
    update execution_principals set status = 'disabled'
     where tenant_id = ${tenantId} and human_user_id = ${actor}
  `
  await assert.rejects(tasks.createTask({
    tenantId, requestedBy: actor, sourceType: 'api', correlationKey: `principal-${randomUUID()}`,
  }), /Task initiator principal is missing/)

  await database`
    update execution_principals set status = 'disabled', authorization_version = authorization_version + 1
     where tenant_id = ${tenantId} and agent_id = ${agentId}
  `
  await assert.rejects(agents.getRuntimeSnapshot(versionId), /执行身份已停用/)
  await assert.rejects(authorization.assertAgentDependencyClosure(versionId), /执行身份已停用/)
  await assert.rejects(authorization.requireActiveAgentPrincipal(versionId), /执行身份不存在或已停用/)
  assert.equal((await agents.listWorkbenchAgents(actor)).some(agent => agent.id === agentId), false)
})
