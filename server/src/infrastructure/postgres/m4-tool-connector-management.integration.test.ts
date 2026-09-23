import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import type { AgentRuntimePort, RuntimeHealth } from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { publishDraftWithSealedTrial } from './test-release-fixture.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let runtimeStatus: RuntimeHealth['status'] = 'healthy'
let runtimeTools = [
  runtimeTool('read', 'Read a file.', 'read'),
  runtimeTool('glob', 'Find files.', 'read'),
  runtimeTool('grep', 'Search files.', 'read'),
  runtimeTool('write', 'Write an artifact.', 'write'),
  runtimeTool('edit', 'Edit an existing file.', 'write'),
  runtimeTool('todo_write', 'Update the task list.', 'write'),
  runtimeTool('read_image', 'Read an image from the workspace.', 'read'),
  runtimeTool('str_replace_editor', 'View or edit a workspace text file.', 'write'),
  runtimeTool('web_fetch', 'Fetch a public web page.', 'read'),
  runtimeTool('web_search', 'Search the public web.', 'read'),
  runtimeTool('bash', 'Execute a shell command.', 'write'),
  runtimeTool('subagent', 'Delegate work.', 'write'),
  runtimeTool('workflow', 'Control a runtime workflow.', 'write'),
]
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
    return runtimeTools
  },
  async close() {},
}

function runtimeTool(id: string, description: string, effect: 'read' | 'write') {
  return {
    id, description, effect, inputSchema: { type: 'object' },
    outputSchema: { 'x-dsh-work-output-validation': 'unavailable' },
    outputValidation: 'unavailable' as const,
    retryPolicy: effect === 'read' ? 'safe' as const : 'never' as const,
    concurrencyPolicy: effect === 'read' ? 'concurrent' as const : 'serialized' as const,
    completionSemantics: 'completed' as const, timeoutSeconds: 30,
  }
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
  assert.equal(catalog.find(tool => tool.id === 'read')?.outputValidation, 'unavailable')
  assert.equal(catalog.find(tool => tool.id === 'read')?.retryPolicy, 'safe')
  assert.equal(catalog.find(tool => tool.id === 'read')?.concurrencyPolicy, 'concurrent')
  assert.equal(catalog.find(tool => tool.id === 'write')?.retryPolicy, 'never')
  assert.equal(catalog.find(tool => tool.id === 'write')?.concurrencyPolicy, 'serialized')
  assert.equal(catalog.find(tool => tool.id === 'write')?.completionSemantics, 'completed')
  assert.deepEqual(JSON.parse(catalog.find(tool => tool.id === 'write')?.outputSchema ?? '{}'), {
    'x-dsh-work-output-validation': 'unavailable',
  })

  const [connector] = await tools.getConnectors()
  assert.equal(connector?.id, 'connector-dsh-workspace')
  assert.equal(connector?.name, 'DSH Runtime 内置工具连接器')
  assert.equal(connector?.protocol, 'runtime')
  assert.equal(connector?.toolCount, 4)
  assert.deepEqual(await tools.getMcpConnectors(), [])
  const runtimeConnector = await tools.getDshRuntimeToolConnectorStatus()
  assert.equal(runtimeConnector.runtimeId, 'runtime-local-01')
  assert.equal(runtimeConnector.connectorId, 'connector-dsh-workspace')
  assert.equal(runtimeConnector.toolCount, 4)
  assert.match(runtimeConnector.catalogDigest, /^[a-f0-9]{64}$/)

  await database`
    insert into connectors (
      id, tenant_id, key, name, connector_type, system, protocol, endpoint, auth_type,
      scope_description, status, latency_ms, last_checked_at, created_by
    ) values (
      'connector-external-test', 'tenant-dsh-work', 'external-test', '外部测试连接器',
      'enterprise', '外部系统', 'rest', 'https://example.invalid/tools', 'none',
      '验证普通工具管理边界', 'healthy', 1, now(), 'U00008'
    )
  `
  await database`
    insert into tools (
      id, tenant_id, key, name, source, status, connector_id, system, description,
      mode, timeout_seconds, allowed_role_ids, data_scopes, approval_policy
    ) values (
      'external-tool-test', 'tenant-dsh-work', 'external-tool-test', '外部测试工具',
      'platform', 'available', 'connector-external-test', '外部系统', '不应进入 DSH 工具管理列表',
      'read', 30, '["role-platform-admin"]'::jsonb, '["external:test"]'::jsonb, 'none'
    )
  `
  await database`
    insert into tool_versions (
      id, tenant_id, tool_id, version, input_schema, output_schema, risk_level, status
    ) values (
      'tool-version-external-test', 'tenant-dsh-work', 'external-tool-test', '1.0.0',
      '{}'::jsonb, '{}'::jsonb, 'low', 'published'
    )
  `
  await database`
    insert into tool_binding_revisions (
      id, tenant_id, tool_id, tool_version, revision, connector_id, executor, endpoint,
      identity_policy, environment, allowed_role_ids, data_scopes, approval_policy,
      content_digest, status, created_by
    ) values (
      'binding-external-test', 'tenant-dsh-work', 'external-tool-test', '1.0.0', 1,
      'connector-external-test', 'external-test', 'https://example.invalid/tools',
      'service', 'default', '["role-platform-admin"]'::jsonb, '["external:test"]'::jsonb,
      'none', ${'0'.repeat(64)}, 'active', 'U00008'
    )
  `
  await database`
    insert into tools (
      id, tenant_id, key, name, source, status, connector_id, system, description,
      dsh_tool_name, mode, timeout_seconds, allowed_role_ids, data_scopes,
      approval_policy, admission_status, admission_message
    ) values (
      'subagent', 'tenant-dsh-work', 'dsh-subagent', 'subagent', 'platform', 'disabled',
      'connector-dsh-workspace', 'DSH Runtime', '历史同步的 DSH 内部协作工具',
      'subagent', 'write', 30, '["role-platform-admin"]'::jsonb,
      '["workspace:authorized"]'::jsonb, 'always', 'unavailable', '历史记录'
    )
  `
  await database`
    insert into tool_versions (
      id, tenant_id, tool_id, version, input_schema, output_schema, risk_level, status
    ) values (
      'tool-version-subagent-test', 'tenant-dsh-work', 'subagent', '1.0.0',
      '{}'::jsonb, '{}'::jsonb, 'high', 'published'
    )
  `
  assert.deepEqual((await tools.getTools()).map(tool => tool.id).sort(), ['glob', 'grep', 'read', 'write'])
  assert.equal((await tools.listToolBindings()).some(binding => binding.tool === 'external-tool-test@1.0.0'), false)
  await assert.rejects(tools.assertAvailableReferences(['external-tool-test@1.0.0']), /不符合受控运行策略/)
  await assert.rejects(tools.resolveToolBindings(['external-tool-test@1.0.0']), /不符合受控运行策略/)
  await assert.rejects(tools.setToolStatus({ toolId: 'external-tool-test', status: 'disabled', actor: 'U00008' }), /只允许操作 DSH 内置工具/)

  const candidates = await tools.getToolCatalog()
  assert.deepEqual(candidates.map(candidate => candidate.id).sort(), [
    'bash', 'edit', 'glob', 'grep', 'read', 'read_image', 'str_replace_editor', 'todo_write', 'web_fetch', 'web_search', 'write',
  ])
  assert.deepEqual(candidates.filter(candidate => candidate.status === 'ready').map(candidate => candidate.id).sort(), [
    'edit', 'read_image', 'str_replace_editor', 'todo_write', 'web_search',
  ])
  assert.equal(candidates.some(candidate => candidate.id === 'subagent'), false)
  assert.equal(candidates.some(candidate => candidate.id === 'workflow'), false)
  assert.equal(candidates.find(candidate => candidate.id === 'bash')?.status, 'unavailable')
  assert.match(candidates.find(candidate => candidate.id === 'bash')?.availabilityMessage ?? '', /不开放任意 Shell/)
  assert.equal(candidates.find(candidate => candidate.id === 'web_fetch')?.status, 'unavailable')

  const synchronized = await tools.syncToolCatalog({ actor: 'U00008' })
  assert.equal(synchronized.discoveredCount, 11)
  assert.equal(synchronized.admittedCount, 9)
  assert.equal(synchronized.unavailableCount, 2)
  const synchronizedTools = await tools.getTools()
  assert.deepEqual(synchronizedTools.map(tool => tool.id).sort(), [
    'bash', 'edit', 'glob', 'grep', 'read', 'read_image', 'str_replace_editor', 'todo_write', 'web_fetch', 'web_search', 'write',
  ])
  const added = synchronizedTools.find(tool => tool.id === 'edit')!
  assert.equal(added.mode, 'write')
  assert.equal(added.status, 'available')
  assert.equal(added.admissionStatus, 'approved')
  assert.equal(added.approvalPolicy, 'none')
  assert.equal(added.outputValidation, 'unavailable')
  assert.equal(added.retryPolicy, 'never')
  assert.equal(added.concurrencyPolicy, 'serialized')
  assert.equal(added.completionSemantics, 'completed')
  const [editStoredContract] = await database<Record<string, unknown>[]>`
    select input_schema as "inputSchema", output_schema as "outputSchema", risk_level as risk,
           output_validation as "outputValidation", retry_policy as "retryPolicy",
           concurrency_policy as "concurrencyPolicy", completion_semantics as "completionSemantics"
      from tool_versions where tenant_id = 'tenant-dsh-work' and tool_id = 'edit' and version = ${added.version}
  `
  assert.deepEqual(editStoredContract, {
    inputSchema: { type: 'object' }, outputSchema: { 'x-dsh-work-output-validation': 'unavailable' },
    risk: 'low', outputValidation: 'unavailable', retryPolicy: 'never',
    concurrencyPolicy: 'serialized', completionSemantics: 'completed',
  })
  const bash = synchronizedTools.find(tool => tool.id === 'bash')!
  assert.equal(bash.status, 'disabled')
  assert.equal(bash.admissionStatus, 'unavailable')
  assert.match(bash.admissionMessage ?? '', /不开放任意 Shell/)
  for (const id of ['read_image', 'str_replace_editor', 'web_search']) {
    const admitted = synchronizedTools.find(tool => tool.id === id)!
    assert.equal(admitted.status, 'available')
    assert.equal(admitted.admissionStatus, 'approved')
    assert.equal(admitted.approvalPolicy, 'none')
  }
  assert.equal(synchronizedTools.some(tool => tool.id === 'subagent'), false)
  assert.equal(synchronizedTools.some(tool => tool.id === 'workflow'), false)
  const [hiddenSubagent] = await database<{ status: string; admissionStatus: string; admissionMessage: string }[]>`
    select status, admission_status as "admissionStatus", admission_message as "admissionMessage"
      from tools where id = 'subagent'
  `
  assert.equal(hiddenSubagent?.status, 'disabled')
  assert.equal(hiddenSubagent?.admissionStatus, 'unavailable')
  assert.match(hiddenSubagent?.admissionMessage ?? '', /内部控制工具/)
  assert.equal((await tools.listToolBindings()).some(binding => binding.tool.startsWith('bash@')), false)
  assert.equal((await tools.listToolBindings()).some(binding => binding.tool.startsWith('subagent@')), false)
  await tools.assertAvailableReferences(['edit@1.0.0', 'read_image@1.0.0', 'str_replace_editor@1.0.0', 'web_search@1.0.0'])
  await assert.rejects(tools.assertAvailableReferences(['web_fetch@1.0.0']), /不可用/)
  await database`
    update tools set status = 'disabled', admission_status = 'unavailable', admission_message = '旧状态'
     where id = 'web_fetch'
  `
  await tools.syncToolCatalog({ actor: 'U00008' })
  const webFetch = (await tools.getTools()).find(tool => tool.id === 'web_fetch')!
  assert.equal(webFetch.status, 'disabled')
  assert.equal(webFetch.admissionStatus, 'unavailable')
  assert.equal((await tools.listToolBindings()).some(binding => binding.tool.startsWith('web_fetch@')), false)
  const editAfterResync = (await tools.getTools()).find(tool => tool.id === 'edit')!
  assert.equal(editAfterResync.version, added.version, 'unchanged contracts must reuse the published Tool Version')
  const [editVersionCount] = await database<{ count: number }[]>`
    select count(*)::integer as count from tool_versions
     where tenant_id = 'tenant-dsh-work' and tool_id = 'edit' and status = 'published'
  `
  assert.equal(editVersionCount?.count, 1)
  assert.equal(await tools.resolveRuntimeApprovalMode(['edit@1.0.0']), 'never')
  assert.equal((await tools.getToolCatalog()).find(candidate => candidate.id === 'edit')?.status, 'installed')
  assert.match((await tools.getToolCatalog()).find(candidate => candidate.id === 'bash')?.availabilityMessage ?? '', /已安装但不可授权/)
  await assert.rejects(tools.setToolStatus({ toolId: 'bash', status: 'available', actor: 'U00008' }), /不开放任意 Shell/)
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

  runtimeTools = runtimeTools.filter(tool => tool.id !== 'todo_write')
  const afterRemoval = await tools.syncToolCatalog({ actor: 'U00008' })
  assert.equal(afterRemoval.discoveredCount, 10)
  const removedTool = (await tools.getTools()).find(tool => tool.id === 'todo_write')!
  assert.equal(removedTool.status, 'disabled')
  assert.equal(removedTool.admissionStatus, 'unavailable')
  assert.match(removedTool.admissionMessage ?? '', /不再加载/)
  assert.equal((await tools.listToolBindings()).some(binding => binding.tool.startsWith('todo_write@') && binding.status === 'active'), false)
  await assert.rejects(tools.assertAvailableReferences(['todo_write@1.0.0']), /不可用/)

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
    maxOutputBytes: 65536, maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: ['skill-document@1.0.0'],
    changeSummary: '验证 Tool 和 Skill 的强引用约束',
    actor: 'U00008',
  }
  await assert.rejects(agents.createAgent({ ...baseInput, tools: ['glob@1.0.0'] }), /必须显式授权/)
  const created = await agents.createAgent({ ...baseInput, tools: ['read@1.0.0'] })
  await publishDraftWithSealedTrial(database, agents, created.agent.id, 'U00008')
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
