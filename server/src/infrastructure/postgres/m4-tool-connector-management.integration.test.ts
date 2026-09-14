import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import type { AgentRuntimePort, RuntimeHealth } from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let runtimeStatus: RuntimeHealth['status'] = 'healthy'
let tools: PostgresToolConnectorService
let skills: PostgresSkillService
let agents: PostgresAgentService

const runtime: AgentRuntimePort = {
  async execute() { throw new Error('此测试不执行真实 Runtime') },
  subscribe() { return () => undefined },
  async cancel() { return { accepted: false } },
  status() { return undefined },
  async health() {
    return {
      status: runtimeStatus,
      runtimeId: 'runtime-local-01',
      activeExecutions: 0,
      acceptingRuns: runtimeStatus === 'healthy',
      dshRepository: '/test/deepseek-harness',
      transport: 'acp-stdio',
      message: `测试 Runtime：${runtimeStatus}`,
    }
  },
  async listTools() {
    return [
      { id: 'edit', description: 'Edit an existing file.', inputSchema: { type: 'object' } },
      { id: 'todo_write', description: 'Update the task list.', inputSchema: { type: 'object' } },
      { id: 'bash', description: 'Execute a shell command.', inputSchema: { type: 'object' } },
      { id: 'subagent', description: 'Delegate work.', inputSchema: { type: 'object' } },
    ]
  },
  async close() {},
}

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据累积影响断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m4_tool_test', maxConnections: 3 })
  database = throwaway.client
  tools = new PostgresToolConnectorService(database, runtime)
  skills = new PostgresSkillService(database, undefined, tools)
  agents = new PostgresAgentService(database, undefined, skills, tools)
})

after(async () => {
  await throwaway.dispose()
})

test('Tool and Connector management gates immutable Agent and Skill references', async () => {
  const catalog = await tools.getTools()
  assert.deepEqual(catalog.map(tool => tool.id).sort(), ['glob', 'grep', 'read', 'write'])
  assert.ok(catalog.every(tool => tool.version === '1.0.0'))
  assert.equal(catalog.find(tool => tool.id === 'write')?.mode, 'write')

  const [connector] = await tools.getConnectors()
  assert.equal(connector?.id, 'connector-dsh-workspace')
  assert.equal(connector?.name, 'DSH 工作空间文件连接器')
  assert.equal(connector?.protocol, 'runtime')
  assert.equal(connector?.toolCount, 4)

  const candidates = await tools.getToolCatalog()
  assert.deepEqual(candidates.map(candidate => candidate.id).sort(), ['bash', 'edit', 'subagent', 'todo_write'])
  assert.deepEqual(candidates.filter(candidate => candidate.status === 'ready').map(candidate => candidate.id).sort(), ['edit', 'todo_write'])
  assert.equal(candidates.find(candidate => candidate.id === 'subagent')?.status, 'unavailable')
  assert.equal(candidates.find(candidate => candidate.id === 'bash')?.status, 'unavailable')
  assert.match(candidates.find(candidate => candidate.id === 'bash')?.availabilityMessage ?? '', /不开放任意 Shell/)
  await assert.rejects(tools.addTool({
    catalogId: 'subagent', allowedRoles: ['平台管理员'], dataScopes: ['workspace:authorized'],
    approvalPolicy: 'always', actor: 'U00008',
  }), /尚未接入/)
  const added = await tools.addTool({
    catalogId: 'edit',
    allowedRoles: ['普通员工', '平台管理员'],
    dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none',
    actor: 'U00008',
  })
  assert.equal(added.id, 'edit')
  assert.equal(added.mode, 'write')
  assert.equal(added.approvalPolicy, 'none')
  await tools.assertAvailableReferences(['edit@1.0.0'])
  assert.equal(await tools.resolveRuntimeApprovalMode(['edit@1.0.0']), 'never')
  await assert.rejects(tools.addTool({
    catalogId: 'edit', allowedRoles: ['普通员工'], dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none', actor: 'U00008',
  }), /已存在/)
  assert.equal((await tools.getToolCatalog()).find(candidate => candidate.id === 'edit')?.status, 'installed')
  await assert.rejects(tools.addTool({
    catalogId: 'bash',
    allowedRoles: ['平台管理员'],
    dataScopes: ['workspace:authorized'],
    approvalPolicy: 'always',
    actor: 'U00008',
  }), /不开放任意 Shell/)
  await database`
    insert into tools (
      id, tenant_id, key, name, source, status, connector_id, system, description,
      dsh_tool_name, mode, timeout_seconds, allowed_role_ids, data_scopes, approval_policy
    ) values (
      'bash', 'tenant-dsh-work', 'dsh-bash-disabled-test', '执行 Shell 命令', 'platform', 'disabled',
      'connector-dsh-workspace', 'DSH Runtime', '不可授权的测试记录', 'bash', 'write', 60,
      '["role-platform-admin"]'::jsonb, '["workspace:authorized"]'::jsonb, 'always'
    )
  `
  await database`
    insert into tool_versions (id, tenant_id, tool_id, version, input_schema, output_schema, risk_level, status)
    values ('tool-version-bash-disabled-test', 'tenant-dsh-work', 'bash', '1.0.0', '{}'::jsonb, '{}'::jsonb, 'high', 'published')
  `
  assert.match((await tools.getToolCatalog()).find(candidate => candidate.id === 'bash')?.availabilityMessage ?? '', /已安装但不可授权/)
  await assert.rejects(tools.setToolStatus({ toolId: 'bash', status: 'available', actor: 'U00008' }), /逐次审批尚未接入/)
  await assert.rejects(tools.assertAvailableReferences(['bash@1.0.0']), /不可用/)

  await tools.assertAvailableReferences(['read@1.0.0', 'glob@1.0.0', 'grep@1.0.0', 'write@1.0.0'])
  await assert.rejects(tools.assertAvailableReferences(['read']), /锁定版本/)
  assert.equal(await tools.resolveRuntimeApprovalMode(['write@1.0.0']), 'never')

  assert.equal(await tools.resolveRuntimeApprovalMode(['read@1.0.0']), 'never')
  await assert.rejects(tools.updateToolPermissions({
    toolId: 'read',
    allowedRoles: ['普通员工', '平台管理员'],
    dataScopes: ['workspace:authorized'],
    approvalPolicy: 'always',
    actor: 'U00008',
  }), /平台安全策略固定/)
  await assert.rejects(tools.updateToolPermissions({
    toolId: 'read',
    allowedRoles: ['普通员工', '平台管理员'],
    dataScopes: ['workspace:authorized'],
    approvalPolicy: 'sensitive',
    actor: 'U00008',
  }), /平台安全策略固定/)

  const permissionUpdated = await tools.updateToolPermissions({
    toolId: 'read',
    allowedRoles: ['普通员工', '平台管理员'],
    dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none',
    actor: 'U00008',
  })
  assert.deepEqual(permissionUpdated.allowedRoles, ['普通员工', '平台管理员'])
  assert.equal(await tools.resolveRuntimeApprovalMode(['activate_skill@1.0.0']), 'never')

  await tools.setToolStatus({ toolId: 'read', status: 'disabled', actor: 'U00008' })
  await assert.rejects(tools.assertAvailableReferences(['read@1.0.0']), /不可用/)
  await tools.setToolStatus({ toolId: 'read', status: 'available', actor: 'U00008' })

  runtimeStatus = 'degraded'
  const degraded = await tools.checkConnector({ connectorId: 'connector-dsh-workspace', actor: 'U00008' })
  assert.equal(degraded.status, 'degraded')
  await assert.rejects(tools.assertAvailableReferences(['read@1.0.0']), /不可用/)
  runtimeStatus = 'healthy'
  const healthy = await tools.checkConnector({ connectorId: 'connector-dsh-workspace', actor: 'U00008' })
  assert.equal(healthy.status, 'healthy')
  await tools.assertAvailableReferences(['read@1.0.0'])

  const suffix = randomUUID().slice(0, 8)
  const baseInput = {
    id: `agent-tool-${suffix}`,
    name: '只读工具验证助手',
    description: '验证 Agent 只能使用已发布、可用且由 Skill 明确依赖的只读工具。',
    owner: '客户端占位',
    department: '客户端占位',
    visibility: '全体试点员工',
    roleIds: ['role-employee'],
    dataScopes: ['workspace:authorized'],
    welcomeMessage: '',
    examplePrompts: ['整理当前工作空间文档'],
    systemPrompt: '你是只读文档助手，只能读取当前工作空间已经授权的文件，不得执行任何写入操作。',
    maxTokens: 12000,
    timeoutSeconds: 300,
    skills: ['skill-document@1.0.0'],
    changeSummary: '验证 Tool 和 Skill 的强引用约束',
    actor: 'U00008',
  }
  await assert.rejects(agents.createAgent({ ...baseInput, tools: ['glob@1.0.0'] }), /必须显式授权/)
  const created = await agents.createAgent({ ...baseInput, tools: ['read@1.0.0'] })
  await agents.testAgent({ agentId: created.agent.id, prompt: '整理当前工作空间文档', actor: 'U00008' })
  await agents.setStatus({ agentId: created.agent.id, status: 'published', actor: 'U00008' })
  const snapshot = await agents.getRuntimeSnapshot(created.version.id)
  assert.deepEqual(snapshot.tools, ['read@1.0.0'])
  assert.deepEqual(snapshot.runtimeTools, ['read@1.0.0'])
  assert.equal(snapshot.approvalMode, 'never')
  assert.deepEqual(snapshot.skillInstructions[0]?.tools, ['read@1.0.0'])

  const checks = await database<{ status: string }[]>`
    select status from connector_health_checks
     where tenant_id = 'tenant-dsh-work' and connector_id = 'connector-dsh-workspace'
  `
  assert.deepEqual(new Set(checks.map(check => check.status)), new Set(['healthy', 'degraded']))
})
