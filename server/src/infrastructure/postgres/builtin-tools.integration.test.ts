import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { builtinTools, missingDshBuiltinTools } from '../../modules/runtime/builtin-tools.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const ADMIN = 'U00008'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let agents: PostgresAgentService
let operations: PostgresOperationsService

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_builtin_tools_test', maxConnections: 3 })
  database = throwaway.client
  operations = new PostgresOperationsService(database)
  agents = new PostgresAgentService(database, operations, new PostgresSkillService(database, operations))
})

after(async () => {
  await throwaway.dispose()
})

test('迁移后工具治理表与 DSH 内置工具连接器不再存在', async () => {
  const tables = await database<{ name: string }[]>`
    select table_name as name from information_schema.tables
     where table_schema = current_schema()
       and table_name in ('tools', 'tool_versions', 'agent_version_tools', 'tool_binding_revisions')
  `
  assert.equal(tables.length, 0)
  const connectors = await database<{ id: string }[]>`select id from connectors where id = 'connector-dsh-workspace'`
  assert.equal(connectors.length, 0)
  const [column] = await database<{ name: string }[]>`
    select column_name as name from information_schema.columns
     where table_name = 'tool_audit_logs' and column_name = 'tool_name'
  `
  assert.equal(column?.name, 'tool_name')
  await assert.rejects(database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values (${tenantId}, 'ws-supply', 'tool', 'read')
  `, /capability_type_check|violates/)
  const [runtime] = await database<{ disabledTools: unknown }[]>`
    select disabled_tools as "disabledTools" from runtime_configurations
     where tenant_id = ${tenantId} and runtime_id = 'runtime-local-01'
     order by revision desc limit 1
  `
  assert.deepEqual(runtime?.disabledTools, [])
})

test('注册表与 DSH 工具目录比对：缺失的 DSH 工具被报告，平台工具不参与比对', () => {
  const dsh = builtinTools.filter(tool => tool.source === 'dsh').map(tool => tool.name)
  assert.deepEqual(missingDshBuiltinTools([...dsh, 'bash']), [])
  assert.deepEqual(missingDshBuiltinTools(dsh.filter(name => name !== 'todo_write')), ['todo_write'])
  assert.equal(builtinTools.some(tool => tool.name === 'bash' || tool.name === 'web_fetch'), false)
})

test('Agent 运行装配默认内置工具，联网搜索按版本开关；Skill 依赖平台不提供的工具时拒绝', async () => {
  const base = {
    name: '只读文档助手',
    description: '读取当前工作空间已授权的文件并整理要点。',
    owner: '平台治理', department: '平台治理',
    welcomeMessage: '', examplePrompts: ['整理当前工作空间文档'],
    systemPrompt: '你是只读文档助手，只能读取当前工作空间已经授权的文件。',
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
    skills: ['skill-document@1.0.0'],
    changeSummary: '验证内置工具装配', actor: ADMIN,
    executionRoleIds: ['role-employee'], executionDataScopes: ['workspace:authorized'],
  }
  const created = await agents.createAgent({ ...base, id: `agent-builtin-${randomUUID().slice(0, 8)}` })
  assert.equal(created.agent.webSearchEnabled, false)
  assert.equal(created.agent.projectTasksEnabled, false)
  const snapshot = await agents.getRuntimeSnapshot(created.version.id)
  assert.deepEqual(snapshot.runtimeTools, builtinTools.filter(tool => tool.assembly === 'always').map(tool => tool.name))
  assert.equal(snapshot.approvalMode, 'never')
  assert.deepEqual(snapshot.skillInstructions[0]?.tools, ['read@1.0.0'])

  const withSearch = await agents.createAgent({ ...base, id: `agent-builtin-web-${randomUUID().slice(0, 8)}`, webSearchEnabled: true })
  const [stored] = await database<{ webSearchEnabled: boolean }[]>`
    select web_search_enabled as "webSearchEnabled" from agent_versions where tenant_id = ${tenantId} and id = ${withSearch.version.id}
  `
  assert.equal(stored?.webSearchEnabled, true)
  assert.ok((await agents.getRuntimeSnapshot(withSearch.version.id)).runtimeTools.includes('web_search'))

  const withTasks = await agents.createAgent({ ...base, id: `agent-builtin-tasks-${randomUUID().slice(0, 8)}`, projectTasksEnabled: true })
  const [taskFlag] = await database<{ projectTasksEnabled: boolean }[]>`
    select project_tasks_enabled as "projectTasksEnabled" from agent_versions
     where tenant_id = ${tenantId} and id = ${withTasks.version.id}
  `
  assert.equal(taskFlag?.projectTasksEnabled, true)
  assert.equal(withTasks.agent.projectTasksEnabled, true)
  // 项目任务工具按运行时 workspace 装配，不进入 Agent 快照的默认 runtimeTools。
  assert.ok(!(await agents.getRuntimeSnapshot(withTasks.version.id)).runtimeTools.includes('project_tasks_list'))

  const skillId = `skill-shell-${randomUUID().slice(0, 8)}`
  await database.begin(async transaction => {
    await transaction`
      insert into skills (id, tenant_id, key, name, category, description, owner_user_id, created_by, status)
      values (${skillId}, ${tenantId}, ${skillId}, 'Shell 脚本', '开发', '需要任意 Shell 的历史 Skill。', ${ADMIN}, ${ADMIN}, 'published')
    `
    await transaction`
      insert into skill_versions (
        id, tenant_id, skill_id, version, name, category, description, instructions,
        manifest, tool_refs, test_prompt, status, created_by, published_by, published_at, change_summary
      ) values (
        ${`${skillId}-1`}, ${tenantId}, ${skillId}, '1.0.0', 'Shell 脚本', '开发', '需要任意 Shell 的历史 Skill。',
        '运行仓库里的构建脚本并汇报每一步的输出结果。', '{}', ${transaction.json(['bash@1.0.0'])}, '运行构建',
        'published', ${ADMIN}, ${ADMIN}, now(), '测试 Skill'
      )
    `
    await transaction`update skills set active_version_id = ${`${skillId}-1`} where tenant_id = ${tenantId} and id = ${skillId}`
  })
  await assert.rejects(
    agents.createAgent({ ...base, id: `agent-builtin-bash-${randomUUID().slice(0, 8)}`, skills: [`${skillId}@1.0.0`] }),
    /bash@1\.0\.0（平台不提供该工具）/,
  )
})

test('Runtime 停用清单只接受 DSH 内置工具，省略时保留当前设置', async () => {
  const runtime = (await operations.getRuntimes()).find(item => item.id === 'runtime-local-01')!
  const update = (disabledTools?: string[]) => operations.updateRuntimeConfiguration({
    runtimeId: runtime.id, maxConcurrentWorkers: runtime.maxConcurrentWorkers,
    attemptTimeoutMinutes: runtime.attemptTimeoutMinutes, schedulingStatus: 'draining', disabledTools, actor: ADMIN,
  })
  await assert.rejects(update(['python_execute']), /只能停用 DSH 内置工具/)
  assert.deepEqual((await update(['web_search', 'web_search', 'read_image']))?.disabledTools, ['read_image', 'web_search'])
  assert.deepEqual((await update(undefined))?.disabledTools, ['read_image', 'web_search'])
  assert.deepEqual((await operations.getRuntimePolicy(runtime.id)).disabledTools, ['read_image', 'web_search'])
  assert.deepEqual((await update([]))?.disabledTools, [])
})
