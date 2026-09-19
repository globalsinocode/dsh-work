import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { AuthorizationDeniedError, isAuthorizationDenial } from '../../modules/authorization/authorization-errors.ts'
import { classifyHttpError } from '../../http/router.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../modules/runtime/runtime-types.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresWorkspaceAgentMemberService } from '../../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let authorization: PostgresAuthorizationService
let agents: PostgresAgentService
let conversations: PostgresConversationRepository
let runtime: CapturingAuthorizationRuntime
let orchestration: RunOrchestrationService

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据累积影响断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m4_auth_test', maxConnections: 5 })
  database = throwaway.client
  authorization = new PostgresAuthorizationService(database)
  const tools = new PostgresToolConnectorService(database)
  const skills = new PostgresSkillService(database, undefined, tools)
  agents = new PostgresAgentService(database, undefined, skills, tools)
  conversations = new PostgresConversationRepository(database)
  runtime = new CapturingAuthorizationRuntime()
  orchestration = new RunOrchestrationService(
    new PostgresRunRepository(database),
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    undefined,
    undefined,
    agents,
    undefined,
    authorization,
    // TW-10：团队会话必须经 @Agent 成员发起执行。
    { agentMembers: new PostgresWorkspaceAgentMemberService(database, authorization, agents) },
  )
})

after(async () => {
  if (orchestration) await orchestration.close()
  await throwaway.dispose()
})

test('authorization is fail-closed and compiles the effective identity into Runtime Manifest', async () => {
  const allowed = await authorization.authorizeRuntime({
    userId: 'U00001',
    workspaceId: 'ws-supply',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  assert.deepEqual(allowed.roleIds, ['role-employee'])
  assert.ok(allowed.permissions.includes('workbench:use'))
  assert.ok(allowed.dataScopes.includes('enterprise:authorized'))
  assert.ok(allowed.dataScopes.includes('workspace:authorized'))
  assert.ok(allowed.dataScopes.includes('domain:supply-chain'))

  const personalWorkspaceId = await conversations.resolveWorkspaceId(undefined, 'U00001')
  assert.equal(personalWorkspaceId, 'ws-personal-U00001')
  const personalAllowed = await authorization.authorizeRuntime({
    userId: 'U00001',
    workspaceId: personalWorkspaceId,
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  assert.equal(personalAllowed.workspaceId, personalWorkspaceId)
  const [personalGrantCount] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_capability_grants
     where tenant_id = 'tenant-dsh-work' and workspace_id = ${personalWorkspaceId}
  `
  assert.equal(personalGrantCount?.count, 0)
  await assert.rejects(
    authorization.authorizeWorkbench({ userId: 'U00008', workspaceId: personalWorkspaceId }),
    /不是成员/,
  )

  const defaultSession = await orchestration.createSession({
    userId: 'U00001',
    title: '默认个人空间归属验证',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  assert.equal(defaultSession.workspaceId, personalWorkspaceId)

  await assert.rejects(
    authorization.authorizeRuntime({
      userId: 'U00008',
      workspaceId: 'ws-supply',
      agentVersionId: 'agent-version-dsh-work-assistant-1',
    }),
    /不是成员/,
  )

  const workspaceId = `ws-auth-${randomUUID().slice(0, 8)}`
  await database.begin(async transaction => {
    await transaction`
      insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
      values (${workspaceId}, 'tenant-dsh-work', '未授权能力空间', '用于验证能力授权默认拒绝', 'team', 'U00001', 'active')
    `
    await transaction`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values ('tenant-dsh-work', ${workspaceId}, 'U00001', 'owner', 'U00001')
    `
  })
  await assert.rejects(
    authorization.authorizeRuntime({
      userId: 'U00001',
      workspaceId,
      agentVersionId: 'agent-version-dsh-work-assistant-1',
    }),
    /未配置Agent授权/,
  )

  await assert.rejects(
    agents.createAgent({
      id: `agent-denied-${randomUUID().slice(0, 8)}`,
      name: '越权创建验证',
      description: '普通员工不能通过管理服务创建 Agent。',
      owner: '', department: '', visibility: '普通员工',
      roleIds: ['role-employee'], dataScopes: ['enterprise:authorized'],
      welcomeMessage: '', examplePrompts: ['测试权限'],
      systemPrompt: '这是一个不会被创建的越权测试 Agent 配置。',
      maxTokens: 12000, timeoutSeconds: 300,
      skills: [], tools: [], changeSummary: '越权测试', actor: '林岚',
    }),
    /不是平台管理员/,
  )

  await database`
    delete from data_scope_grants
     where tenant_id = 'tenant-dsh-work' and id = 'grant-role-employee-workspace'
  `
  try {
    await assert.rejects(
      authorization.authorizeRuntime({
        userId: 'U00001',
        agentVersionId: 'agent-version-dsh-work-assistant-1',
      }),
      /workspace:authorized/,
    )
  } finally {
    await database`
      insert into data_scope_grants (id, tenant_id, subject_type, subject_id, scope_code, scope_value)
      values ('grant-role-employee-workspace', 'tenant-dsh-work', 'role', 'role-employee', 'capability', 'workspace:authorized')
      on conflict do nothing
    `
  }

  const session = await orchestration.createSession({
    userId: 'U00001',
    title: '授权清单验证',
    workspaceId: 'ws-supply',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  // TW-10：团队会话经 @Agent 成员发起执行——成员固定版本即本测试断言的版本。
  await database`
    insert into workspace_agent_members (id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by)
    values ('wam-supply-assistant', 'tenant-dsh-work', 'ws-supply',
            'agent-dsh-work-assistant', 'agent-version-dsh-work-assistant-1', 'available', 'U00001')
    on conflict (id) do nothing
  `
  const run = await orchestration.startRun({
    userId: 'U00001',
    sessionId: session.id,
    prompt: '读取工作空间文件并整理重点',
    idempotencyKey: randomUUID(),
    workspaceAgentMemberId: 'wam-supply-assistant',
  })
  assert.ok(run)
  await waitForRun(run.id)
  const manifest = runtime.manifest(run.id)
  assert.deepEqual(manifest?.user_context.role_ids, ['role-employee'])
  assert.ok(manifest?.data_scopes.includes('domain:supply-chain'))
  assert.deepEqual(manifest?.skills, [{ id: 'skill-document', version: '1.0.0' }])
  assert.deepEqual(manifest?.tools, [
    { id: 'read', version: '1.0.0' },
    { id: 'activate_skill', version: '1.0.0' },
  ])

  const [audit] = await database<{ blocked: number; success: number }[]>`
    select count(*) filter (where result = 'blocked')::integer as blocked,
           count(*) filter (where result = 'success')::integer as success
      from audit_events
     where tenant_id = 'tenant-dsh-work' and object_type = 'authorization'
  `
  assert.ok((audit?.blocked ?? 0) >= 3)
  assert.ok((audit?.success ?? 0) >= 1)
})

test('personal Skill sessions use a compatible stable default Agent and reject an incompatible fixed pairing before persistence', async () => {
  const suffix = randomUUID().slice(0, 8)
  const agentId = `agent-incompatible-default-${suffix}`
  const agentVersionId = `agent-version-incompatible-default-${suffix}`
  await database.begin(async transaction => {
    await transaction`
      insert into agents (
        id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
        status, active_version_id, updated_at
      ) values (
        ${agentId}, 'tenant-dsh-work', '无读取能力的候选 Agent', '验证 Skill 与 Agent 的工具兼容选择。', '',
        'U00008', 'U00008', 'published', null, now() + interval '1 hour'
      )
    `
    await transaction`
      insert into agent_versions (
        id, tenant_id, agent_id, version, name, description, welcome_message,
        example_prompts, system_prompt, visible_role_ids, data_scopes, max_tokens,
        timeout_seconds, skill_refs, tool_refs, status, created_by, published_at
      ) values (
        ${agentVersionId}, 'tenant-dsh-work', ${agentId}, '1.0.0', '无读取能力的候选 Agent',
        '验证 Skill 与 Agent 的工具兼容选择。', '', '[]', '只处理不需要工具的文本任务。',
        '["role-employee"]', '["enterprise:authorized"]', 12000, 300, '[]', '[]',
        'published', 'U00008', now()
      )
    `
    await transaction`update agents set active_version_id = ${agentVersionId} where id = ${agentId}`
  })

  const listed = await agents.listWorkbenchAgents('U00001')
  assert.equal(listed[0]?.id, 'agent-dsh-work-assistant', '默认 Agent 不应随最近更新时间漂移')
  assert.equal(
    await agents.resolveWorkbenchAgentVersion(undefined, 'U00001', undefined, ['skill-document@1.0.0']),
    'agent-version-dsh-work-assistant-output-1',
  )
  await assert.rejects(
    agents.resolveWorkbenchAgentVersion(agentId, 'U00001', undefined, ['skill-document@1.0.0']),
    /必须显式授权所选 Skill 依赖的工具：read@1.0.0/,
  )

  const title = `不兼容 Skill 会话-${suffix}`
  await assert.rejects(
    orchestration.createSession({
      userId: 'U00001',
      title,
      agentVersionId,
      selectedSkillVersionId: 'skill-version-document-1',
      selectedSkillReference: 'skill-document@1.0.0',
    }),
    /必须显式授权所选 Skill 依赖的工具：read@1.0.0/,
  )
  const [persisted] = await database<{ count: number }[]>`
    select count(*)::integer as count from sessions
     where tenant_id = 'tenant-dsh-work' and title = ${title}
  `
  assert.equal(persisted?.count, 0)
})

test('Runtime-owned Skill tools do not require duplicate Agent tool authorization', async () => {
  const suffix = randomUUID().slice(0, 8)
  const skillId = `skill-runtime-intrinsic-${suffix}`
  const versionId = `skill-version-runtime-intrinsic-${suffix}`
  await database.begin(async transaction => {
    await transaction`
      insert into skills (
        id, tenant_id, key, name, category, description, owner_user_id, created_by,
        status, active_version_id
      ) values (
        ${skillId}, 'tenant-dsh-work', ${skillId}, '内置工具 Skill', '测试', '验证 Runtime 内置工具授权。',
        'U00008', 'U00008', 'published', null
      )
    `
    await transaction`
      insert into skill_versions (
        id, tenant_id, skill_id, version, name, category, description, instructions,
        manifest, tool_refs, test_prompt, status, created_by, published_at
      ) values (
        ${versionId}, 'tenant-dsh-work', ${skillId}, '1.0.0', '内置工具 Skill', '测试',
        '验证 Runtime 内置工具授权。', '必须使用平台提供的按需激活与 Python 执行工具。', '{}',
        '["activate_skill@1.0.0", "python_execute@1.0.0"]', '执行最小示例', 'published', 'U00008', now()
      )
    `
    await transaction`update skills set active_version_id = ${versionId} where id = ${skillId}`
  })

  await assert.doesNotReject(authorization.authorizeRuntime({
    userId: 'U00001',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
    additionalSkillReferences: [`${skillId}@1.0.0`],
  }))
})

// 5-T4：管理操作人校验与会话「不存在或不可访问」原先抛裸 Error，HTTP 层靠中文文案
// 正则才落 403；类型化后状态码与 code 不变，但不再依赖文案。
test('5-T4 管理操作人与会话拒绝类型化：HTTP 仍是 403 permission_denied', async () => {
  const actorDenial = await agents.createAgent({
    id: `agent-typed-denied-${randomUUID().slice(0, 8)}`,
    name: '类型化越权验证',
    description: '普通员工不能通过 Agent 管理服务创建 Agent。',
    owner: '', department: '', visibility: '普通员工',
    roleIds: ['role-employee'], dataScopes: ['enterprise:authorized'],
    welcomeMessage: '', examplePrompts: ['测试权限'],
    systemPrompt: '这是一个不会被创建的越权测试 Agent 配置。',
    maxTokens: 12000, timeoutSeconds: 300,
    skills: [], tools: [], changeSummary: '越权测试', actor: '林岚',
  }).then(() => null, (error: unknown) => error)
  assert.ok(actorDenial instanceof AuthorizationDeniedError, `必须是类型化授权拒绝，实际：${String(actorDenial)}`)
  assert.equal(actorDenial.status, 403)
  assert.equal(actorDenial.code, 'permission_denied')
  assert.match(actorDenial.message, /不是平台管理员/)
  assert.equal(classifyHttpError(actorDenial, '/api/admin/v1/agents').error.code, 'permission_denied')

  const missingSession = `session-typed-missing-${randomUUID()}`
  const readDenial = await conversations.requireSession(missingSession, 'U00001')
    .then(() => null, (error: unknown) => error)
  assert.ok(readDenial instanceof AuthorizationDeniedError, `必须是类型化授权拒绝，实际：${String(readDenial)}`)
  assert.equal(readDenial.message, `Session 不存在或不可访问：${missingSession}`)
  assert.equal(isAuthorizationDenial(readDenial), true, '类型化后撤权分类器必须识别会话语义拒绝')
  assert.equal(classifyHttpError(readDenial, `/api/workbench/v1/sessions/${missingSession}`).status, 403)

  const archiveDenial = await conversations.archiveSession(missingSession, 'U00001')
    .then(() => null, (error: unknown) => error)
  assert.ok(archiveDenial instanceof AuthorizationDeniedError, `必须是类型化授权拒绝，实际：${String(archiveDenial)}`)
  assert.equal(archiveDenial.status, 403)
  assert.equal(archiveDenial.code, 'permission_denied')
})

async function waitForRun(runId: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const task = await conversations.getTask(runId, 'U00001')
    if (task?.status === 'succeeded') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('等待授权测试 Run 完成超时')
}

interface Execution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
  done: Promise<RuntimeExecutionSnapshot>
  resolveDone: (snapshot: RuntimeExecutionSnapshot) => void
}

class CapturingAuthorizationRuntime implements AgentRuntimePort {
  private readonly executions = new Map<string, Execution>()

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => { resolveDone = resolve })
    const now = new Date().toISOString()
    const snapshot: RuntimeExecutionSnapshot = {
      runId: manifest.run_id,
      attemptId: manifest.attempt_id,
      status: 'queued',
      acceptedAt: now,
      startedAt: null,
      endedAt: null,
      manifestSha256: 'authorization-test',
      attemptDirectory: '/tmp/authorization-test',
      errorCode: null,
      errorMessage: null,
    }
    const execution = { manifest, events: [], listeners: new Set<RuntimeEventListener>(), snapshot, done, resolveDone }
    this.executions.set(manifest.run_id, execution)
    this.emit(execution, 'run.queued', '授权后进入队列')
    setTimeout(() => {
      execution.snapshot.status = 'running'
      execution.snapshot.startedAt = new Date().toISOString()
      this.emit(execution, 'run.started', '开始执行授权测试')
      this.emit(execution, 'assistant.completed', '授权测试完成。')
      execution.snapshot.status = 'completed'
      execution.snapshot.endedAt = new Date().toISOString()
      this.emit(execution, 'run.completed', '授权测试完成')
      execution.resolveDone(structuredClone(execution.snapshot))
    }, 10)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener) {
    const execution = this.executions.get(runId)
    if (!execution) throw new Error('Run not found')
    execution.events.forEach(listener)
    execution.listeners.add(listener)
    return () => execution.listeners.delete(listener)
  }

  async cancel() { return { accepted: false } }
  status(runId: string) { return this.executions.get(runId)?.snapshot }
  async health() {
    return {
      status: 'healthy' as const,
      runtimeId: 'runtime-local-01',
      activeExecutions: 0,
      acceptingRuns: true,
      dshRepository: '/tmp',
      transport: 'acp-stdio' as const,
      message: 'test',
    }
  }
  async close() {}
  manifest(runId: string) { return this.executions.get(runId)?.manifest }

  private emit(execution: Execution, eventType: RuntimeEvent['event_type'], displayMessage: string) {
    const event: RuntimeEvent = {
      event_id: randomUUID(),
      run_id: execution.manifest.run_id,
      attempt_id: execution.manifest.attempt_id,
      sequence: execution.events.length + 1,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      display_message: displayMessage,
      safe_metadata: {},
      trace_id: `trace-${execution.manifest.run_id}`,
      parent_event_id: execution.events.at(-1)?.event_id ?? null,
    }
    execution.events.push(event)
    execution.listeners.forEach(listener => listener(event))
  }
}
