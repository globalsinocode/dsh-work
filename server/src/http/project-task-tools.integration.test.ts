/**
 * 项目空间 S6：Agent 项目任务工具处理器（PS-S6-01）。
 * 直接调用 ProjectTaskTools，覆盖读/写、via 归因、只读拒绝、Agent 任务手动规则。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import { PostgresAgentService } from '../modules/agent/postgres-agent-service.ts'
import { ModelGovernanceService } from '../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../modules/run/postgres-run-repository.ts'
import { PostgresTaskRepository } from '../modules/task/postgres-task-repository.ts'
import { UnavailableRuntime } from '../modules/runtime/execution-capabilities.ts'
import type {
  AgentRuntimePort, RuntimeExecutionHandle, RuntimeExecutionSnapshot, RuntimeHealth, RuntimeManifest,
} from '../modules/runtime/runtime-types.ts'
import { PostgresConversationRepository } from '../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresProjectArchiveService } from '../modules/workbench/application/postgres-project-archive-service.ts'
import { PostgresProjectService } from '../modules/workbench/application/postgres-project-service.ts'
import { ProjectTaskTools } from '../modules/workbench/application/project-task-tools.ts'
import { PostgresWorkspaceAgentMemberService } from '../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import { RequestError } from '../domain/request-errors.ts'
import { PlatformToolError } from '../modules/runtime/platform-tool-contract.ts'

const tenantId = 'tenant-dsh-work'
const signal = new AbortController().signal

let throwaway: ThrowawayDatabase
let database: DatabaseClient
let projects: PostgresProjectService
let tools: ProjectTaskTools
let assembling: RunOrchestrationService
let agentMembers: PostgresWorkspaceAgentMemberService
const captured: RuntimeManifest[] = []
let space: {
  id: string
  owner: string
  member: string
  viewer: string
  agentMemberId: string
  agentId: string
  agentVersionId: string
  agentName: string
}

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_project_task_tools', maxConnections: 6 })
  database = throwaway.client
  const authorization = new PostgresAuthorizationService(database)
  const agents = new PostgresAgentService(database)
  agentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
  const projectArchive = new PostgresProjectArchiveService(database)
  projects = new PostgresProjectService(database, agentMembers, projectArchive)
  const conversations = new PostgresConversationRepository(database)
  const runs = new PostgresRunRepository(database)
  const orchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    new UnavailableRuntime('runtime-local-01'),
    undefined,
    undefined,
    agents,
    undefined,
    authorization,
    { agentMembers, projectTasks: projects, projectArchive, tasks: new PostgresTaskRepository(database) },
  )
  projects.attachRunStarter(orchestration)
  tools = new ProjectTaskTools(projects, database)
  // 装配验证用：记录提交给 Runtime 的 Manifest，执行停在受理后。
  assembling = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    new CapturingRuntime(),
    undefined,
    undefined,
    agents,
    undefined,
    authorization,
    { agentMembers, projectTasks: projects, projectArchive, tasks: new PostgresTaskRepository(database) },
  )
  space = await seed()
})

after(async () => {
  if (throwaway) await throwaway.dispose()
})

test('list / get 返回本空间任务与可指派成员，不含任务对话内容', async () => {
  const listed = await tools.list({}, manifest(space.member), signal) as {
    tasks: Array<{ id: string; title: string }>
    members: Array<{ type: string; id: string }>
  }
  assert.ok(listed.tasks.some(task => task.title === '已有员工任务'))
  assert.ok(listed.members.some(item => item.type === 'employee' && item.id === space.member))
  assert.ok(listed.members.some(item => item.type === 'agent' && item.id === space.agentMemberId))
  assert.ok(!JSON.stringify(listed).includes('任务对话'))

  const existing = listed.tasks.find(task => task.title === '已有员工任务')!
  const detail = await tools.get({ taskId: existing.id }, manifest(space.member), signal) as {
    task: { id: string; description: string }
  }
  assert.equal(detail.task.id, existing.id)
  assert.equal(detail.task.description, '说明')
})

test('create：发起人归因 + via；Agent 任务固定手动且不立即执行', async () => {
  const created = await tools.create({
    title: '经助手分配的周报',
    description: '周五前提交',
    assignee: { type: 'employee', id: space.member },
    dueDate: '2026-12-31',
  }, manifest(space.owner), signal) as { task: { id: string; status: string } }

  const [row] = await database<{
    createdBy: string
    via: { agentMemberId: string; agentName: string; runId: string } | null
  }[]>`
    select created_by as "createdBy", created_via as via
      from project_tasks where tenant_id = ${tenantId} and id = ${created.task.id}
  `
  assert.equal(row?.createdBy, space.owner)
  assert.equal(row?.via?.agentMemberId, space.agentMemberId)
  assert.equal(row?.via?.agentName, space.agentName)
  assert.equal(row?.via?.runId, 'run-s6-test')

  const agentTask = await tools.create({
    title: '交给助手跟进',
    assignee: { type: 'agent', id: space.agentMemberId },
  }, manifest(space.owner), signal) as { task: { id: string } }
  const task = await projects.getTask(space.id, agentTask.task.id, space.owner)
  assert.equal(task.schedule?.kind, 'manual')
  assert.equal(task.latestRunId, null)
  assert.equal(task.status, 'todo')
})

test('update：编辑写入 edited 事件并带 via；只读成员写入被拒', async () => {
  const created = await tools.create({
    title: '待改标题',
    assignee: { type: 'employee', id: space.member },
  }, manifest(space.owner), signal) as { task: { id: string } }

  await tools.update({
    taskId: created.task.id,
    title: '已改标题',
    status: 'in_progress',
  }, manifest(space.owner), signal)

  const events = await projects.listTaskEvents(space.id, created.task.id, space.owner)
  const edited = events.find(event => event.kind === 'edited')
  const status = events.find(event => event.kind === 'status_changed')
  assert.ok(edited)
  assert.equal((edited!.metadata.via as { agentName: string }).agentName, space.agentName)
  assert.equal(edited!.metadata.title, '已改标题')
  assert.ok(status)
  assert.equal((status!.metadata.via as { agentName: string }).agentName, space.agentName)

  await assert.rejects(
    () => tools.create({
      title: '只读不能建',
      assignee: { type: 'employee', id: space.member },
    }, manifest(space.viewer), signal),
    (error: unknown) =>
      error instanceof PlatformToolError
      || (error instanceof RequestError && error.status === 403)
      || (error as { status?: number }).status === 403,
  )
})

test('update：负责人未变时保留原执行规则；经 Agent 改派给 Agent 记改派事件并改为手动', async () => {
  // 人建的 Agent 任务：默认每天执行。
  const daily = await projects.createTask(space.id, space.owner, {
    title: '每日库存检查',
    assignee: { type: 'agent', id: space.agentMemberId },
  })
  assert.equal(daily.schedule?.kind, 'daily')
  await tools.update({
    taskId: daily.id, title: '每日库存检查（改名）', assignee: { type: 'agent', id: space.agentMemberId },
  }, manifest(space.owner), signal)
  const kept = await projects.getTask(space.id, daily.id, space.owner)
  assert.equal(kept.schedule?.kind, 'daily', '只改标题时不改执行规则')
  const keptEvents = await projects.listTaskEvents(space.id, daily.id, space.owner)
  assert.ok(!keptEvents.some(event => event.kind === 'schedule_changed'))

  // 员工任务经 Agent 改派给 Agent：新任务对话中记改派事件（带 via），执行规则为手动。
  const employeeTask = await projects.createTask(space.id, space.owner, {
    title: '交接给助手', assignee: { type: 'employee', id: space.member },
  })
  await tools.update({
    taskId: employeeTask.id, assignee: { type: 'agent', id: space.agentMemberId },
  }, manifest(space.owner), signal)
  const moved = await projects.getTask(space.id, employeeTask.id, space.owner)
  assert.equal(moved.assignee.type, 'agent')
  assert.equal(moved.schedule?.kind, 'manual')
  const [reassigned] = await database<{ metadata: { from: string; to: string; via?: { agentName: string } } }[]>`
    select metadata from project_task_events
     where tenant_id = ${tenantId} and task_id = ${employeeTask.id} and kind = 'reassigned'`
  assert.equal(reassigned?.metadata.from, '成员')
  assert.equal(reassigned?.metadata.to, space.agentName)
  assert.equal(reassigned?.metadata.via?.agentName, space.agentName)
})

test('update：字段已修改而状态推进失败时报告结果未知，不报告未执行', async () => {
  const created = await projects.createTask(space.id, space.owner, {
    title: '半途失败', assignee: { type: 'employee', id: space.member },
  })
  const failing = Object.create(projects) as PostgresProjectService
  failing.setTaskStatus = async () => { throw new RequestError(409, 'state_conflict', '任务状态已变化') }
  const partialTools = new ProjectTaskTools(failing, database)
  await assert.rejects(
    () => partialTools.update({ taskId: created.id, title: '半途失败（已改名）', status: 'done' }, manifest(space.owner), signal),
    (error: unknown) => error instanceof PlatformToolError && error.effectState === 'unknown' && /标题已修改/.test(error.message),
  )
  assert.equal((await projects.getTask(space.id, created.id, space.owner)).title, '半途失败（已改名）')
})

test('list：按页读完再筛选，较早创建的未完成任务不会被漏掉', async () => {
  const old = await projects.createTask(space.id, space.owner, {
    title: '很早的未完成任务', assignee: { type: 'employee', id: space.member },
  })
  for (let index = 0; index < 55; index += 1) {
    const task = await projects.createTask(space.id, space.owner, {
      title: `已完成任务 ${index}`, assignee: { type: 'employee', id: space.member },
    })
    await database`update project_tasks set status = 'done' where tenant_id = ${tenantId} and id = ${task.id}`
  }
  const listed = await tools.list({ status: 'open', query: '很早的' }, manifest(space.member), signal) as {
    tasks: Array<{ id: string }>; total: number; truncated: boolean
  }
  assert.deepEqual(listed.tasks.map(task => task.id), [old.id])
  assert.equal(listed.total, 1)
  assert.equal(listed.truncated, false)
})

test('运行中 Agent 成员升级版本后仍可写入；成员停用后拒绝写入', async () => {
  const upgradedVersionId = `${space.agentVersionId}-v2`
  await database`
    insert into agent_versions
    select * from jsonb_populate_record(null::agent_versions,
      (select to_jsonb(av) from agent_versions av where av.tenant_id = ${tenantId} and av.id = ${space.agentVersionId})
        || jsonb_build_object('id', ${upgradedVersionId}::text, 'version', '1.0.1'))
  `
  await database`update workspace_agent_members set agent_version_id = ${upgradedVersionId} where tenant_id = ${tenantId} and id = ${space.agentMemberId}`
  try {
    // 本次运行的 Manifest 仍是旧版本。
    const created = await tools.create({
      title: '升级后仍可创建', assignee: { type: 'employee', id: space.member },
    }, manifest(space.owner), signal) as { task: { id: string } }
    assert.ok(created.task.id)

    await database`update workspace_agent_members set status = 'disabled' where tenant_id = ${tenantId} and id = ${space.agentMemberId}`
    await assert.rejects(
      () => tools.create({ title: '停用后不能创建', assignee: { type: 'employee', id: space.member } }, manifest(space.owner), signal),
      /Agent 成员不可用/,
    )
  } finally {
    await database`
      update workspace_agent_members set agent_version_id = ${space.agentVersionId}, status = 'available'
       where tenant_id = ${tenantId} and id = ${space.agentMemberId}`
  }
})

test('装配：群聊 @Agent 与重试装配读写工具，定时执行只装配读取工具', async () => {
  const taskTools = (manifest: RuntimeManifest) => manifest.tools.map(tool => tool.id).filter(id => id.startsWith('project_task'))
  // 提交给 Runtime 发生在调度之后：等到这一次运行的 Manifest 出现。
  const manifestFor = async (runId: string, count = 1) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = captured.filter(item => item.run_id === runId)
      if (found.length >= count) return found.at(-1)!
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`没有等到运行 ${runId} 的 Manifest`)
  }
  // 经正式入口建群（含 Agent 成员的授权来源），与线上一致。
  const workspaceId = await agentMembers.createTeamWorkspace({ name: 'S6 装配验证', description: '' }, [space.agentId], space.owner, ['role-employee'])
  const [member] = await database<{ id: string }[]>`
    select id from workspace_agent_members where tenant_id = ${tenantId} and workspace_id = ${workspaceId}`
  const session = await assembling.createSession({ userId: space.owner, title: '装配验证', workspaceId, agentVersionId: null })
  const run = (await assembling.startRun({
    userId: space.owner, sessionId: session.id, prompt: '@S6 助手 看看任务',
    idempotencyKey: `s6-assembly-${randomUUID()}`, workspaceAgentMemberId: member!.id,
  }))!
  assert.deepEqual(taskTools(await manifestFor(run.id)), ['project_tasks_list', 'project_task_get', 'project_task_create', 'project_task_update'])

  const scheduledSession = await assembling.createSession({ userId: space.owner, title: '定时装配验证', workspaceId, agentVersionId: null })
  const scheduledRun = (await assembling.startRun({
    userId: space.owner, sessionId: scheduledSession.id, prompt: '定时检查',
    idempotencyKey: `s6-scheduled-${randomUUID()}`, workspaceAgentMemberId: member!.id, scheduled: true,
  }))!
  assert.deepEqual(taskTools(await manifestFor(scheduledRun.id)), ['project_tasks_list', 'project_task_get'])

  // 原运行失败后由人重试：沿用读写工具。
  await database`update run_attempts set status = 'failed', ended_at = now() where tenant_id = ${tenantId} and run_id = ${run.id}`
  await database`update runs set status = 'failed' where tenant_id = ${tenantId} and id = ${run.id}`
  await assembling.retry(run.id, space.owner)
  assert.deepEqual(taskTools(await manifestFor(run.id, 2)), ['project_tasks_list', 'project_task_get', 'project_task_create', 'project_task_update'])
})

test('系统运行 purpose 拒绝装配路径上的调用', async () => {
  await assert.rejects(
    () => tools.list({}, { ...manifest(space.member), purpose: 'project-archive' }, signal),
    /系统或管理运行/,
  )
})

async function seed() {
  const id = `ws-s6-${randomUUID().slice(0, 8)}`
  const owner = `${id}-owner`
  const member = `${id}-member`
  const viewer = `${id}-viewer`
  for (const [userId, name] of [[owner, '负责人'], [member, '成员'], [viewer, '只读']] as const) {
    await database`
      insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
      values (${userId}, ${tenantId}, ${`local:${userId}`}, ${name}, 'active', 'local', true)
    `
    await database`
      insert into user_roles (tenant_id, user_id, role_id, source_key)
      values (${tenantId}, ${userId}, 'role-employee', 'local')
    `
  }
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${id}, ${tenantId}, 'S6 任务工具', '', 'team', ${owner}, 'active')
  `
  for (const [userId, role] of [[owner, 'owner'], [member, 'member'], [viewer, 'viewer']] as const) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${id}, ${userId}, ${role}, ${owner})
    `
  }

  const agentId = `agent-s6-${randomUUID().slice(0, 8)}`
  const agentVersionId = `${agentId}-v1`
  const agentName = 'S6 助手'
  await database`
    insert into agents (id, tenant_id, name, description, welcome_message, owner_user_id, created_by, status, active_version_id, allow_workspace_join, visible_role_ids)
    values (${agentId}, ${tenantId}, ${agentName}, 'S6 集成测试助手。', '', ${owner}, ${owner}, 'published', null, true, ${database.json(['role-employee'])})
  `
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message, example_prompts, system_prompt,
      max_output_bytes, max_tool_calls, timeout_seconds, skill_refs, web_search_enabled, project_tasks_enabled,
      status, created_by, change_summary
    ) values (
      ${agentVersionId}, ${tenantId}, ${agentId}, '1.0.0', ${agentName}, 'S6 集成测试助手。', '',
      ${database.json(['测试'] as string[])}, '你是项目任务测试助手，按发起成员的要求查看与维护本项目空间的任务。', 65536, 20, 300,
      ${database.json([] as string[])}, false, true, 'published', ${owner}, 'S6'
    )
  `
  await database`update agents set active_version_id = ${agentVersionId} where tenant_id = ${tenantId} and id = ${agentId}`
  await database`
    insert into agent_principal_role_grants (tenant_id, principal_id, role_id)
    values (${tenantId}, ${`principal-agent-${agentId}`}, 'role-employee')
    on conflict do nothing
  `
  const agentMemberId = `wam-s6-${randomUUID().slice(0, 8)}`
  await database`
    insert into workspace_agent_members (id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by)
    values (${agentMemberId}, ${tenantId}, ${id}, ${agentId}, ${agentVersionId}, 'available', ${owner})
  `

  await projects.createTask(id, owner, {
    title: '已有员工任务',
    description: '说明',
    assignee: { type: 'employee', id: member },
  })

  return { id, owner, member, viewer, agentMemberId, agentId, agentVersionId, agentName }
}

function manifest(userId: string): RuntimeManifest {
  return {
    manifest_version: '1.0',
    run_id: 'run-s6-test',
    attempt_id: 'attempt-s6-test',
    task_id: 'task-s6-test',
    session_id: null,
    workspace_id: space.id,
    agent_version_id: space.agentVersionId,
    agent_configuration: { system_prompt: 'test', skill_instructions: [] },
    user_context: { user_id: userId, tenant_id: tenantId, role_ids: ['role-employee'] },
    permission_policy: { approval_mode: 'never', network_policy: 'deny', write_policy: 'workspace_only' },
    skills: [],
    tools: [
      { id: 'project_tasks_list', version: '1.0.0' },
      { id: 'project_task_get', version: '1.0.0' },
      { id: 'project_task_create', version: '1.0.0' },
      { id: 'project_task_update', version: '1.0.0' },
    ],
    data_scopes: [],
    knowledge_context: [],
    model_route_id: 'default',
    input: { message: '测试', file_mounts: [] },
    budget: {
      scope_task_id: 'task-s6-test',
      cumulative_limits: { max_duration_ms: null, max_tool_calls: null, max_output_bytes: null },
      reservation: { duration_ms: 5000, tool_calls: 10, output_bytes: 64 * 1024 },
      enforcement: {
        duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported',
      },
    },
    limits: { timeout_seconds: 300, max_tool_calls: 20, max_output_bytes: 65536 },
    created_at: new Date().toISOString(),
    trace_id: 'trace-s6',
  }
}

/** 记录 Manifest、受理后不结束的 Runtime。 */
class CapturingRuntime implements AgentRuntimePort {
  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    captured.push(manifest)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: new Date().toISOString(), done: new Promise(() => undefined) }
  }
  subscribe() { return () => undefined }
  async cancel() { return { accepted: false } }
  status(): RuntimeExecutionSnapshot | undefined { return undefined }
  async health(): Promise<RuntimeHealth> {
    return {
      status: 'healthy', runtimeId: 'runtime-local-01', activeExecutions: 0,
      acceptingRuns: true, dshRepository: '/tmp', transport: 'acp-stdio', message: 'test',
    }
  }
  async close() {}
}
