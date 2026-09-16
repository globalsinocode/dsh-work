import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { DatabaseClient } from './database.ts'
import { publishDraftWithSealedTrial } from './test-release-fixture.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let agents: PostgresAgentService

/**
 * 草稿发布只能走发布治理链路（封存试运行证据 + 事务内发布）。
 * 本套件验证版本/回滚/可见性等生命周期机制，以治理证据夹具驱动同一个事务内
 * publish 入口；真实 DSH 试运行到发布的端到端覆盖见 agent-release-governance 套件。
 */
const publishDraft = (agentId: string) => publishDraftWithSealedTrial(database, agents, agentId, 'U00008')

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据累积影响断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m4_agent_test', maxConnections: 3 })
  database = throwaway.client
  agents = new PostgresAgentService(database)
})

after(async () => {
  await throwaway.dispose()
})

test('Agent lifecycle persists test evidence, publishes, versions, rolls back and controls employee visibility', async () => {
  const suffix = randomUUID().slice(0, 8)
  const agentId = `agent-integration-${suffix}`
  const created = await agents.createAgent({
    id: agentId,
    name: '集成测试助手',
    description: '用于验证 Agent 完整版本生命周期和员工端可见性。',
    owner: '不会采用客户端负责人',
    department: '不会采用客户端部门',
    visibility: '全体试点员工',
    roleIds: ['role-employee'],
    dataScopes: ['enterprise:authorized'],
    welcomeMessage: '',
    examplePrompts: ['请介绍你的能力'],
    systemPrompt: '你是集成测试助手，只能根据当前授权数据回答，并且必须给出简洁、可验证的结论。',
    maxTokens: 12000,
    timeoutSeconds: 300,
    skills: ['skill-document@1.0.0'],
    tools: ['tool-runtime-file-read@1.0.0'],
    changeSummary: '创建集成测试 Agent',
    actor: 'U00008',
  })
  assert.equal(created.agent.owner, '陈默')
  assert.equal(created.agent.status, 'draft')
  assert.equal(created.agent.version, '0.1.0')

  // 状态直改不再能发布草稿：必须走发布工作台的封存试运行链路
  await assert.rejects(
    agents.setStatus({ agentId, status: 'published', actor: 'U00008' }),
    /发布工作台/,
  )
  const tested = await agents.testAgent({ agentId, prompt: '请介绍你的能力', actor: 'U00008' })
  assert.equal(tested.status, 'passed')
  await publishDraft(agentId)
  assert.equal((await agents.getAgents()).find(agent => agent.id === agentId)?.status, 'published')

  const employeeAgents = await agents.listWorkbenchAgents('U00001')
  assert.ok(employeeAgents.some(agent => agent.id === agentId && agent.version === '0.1.0'))
  const activeVersionId = await agents.resolveWorkbenchAgentVersion(agentId, 'U00001')
  const snapshot = await agents.getRuntimeSnapshot(activeVersionId)
  assert.match(snapshot.systemPrompt, /集成测试助手/)
  assert.deepEqual(snapshot.skills, ['skill-document@1.0.0'])

  const draft = await agents.updateAgent({
    agentId,
    name: '集成测试助手二版',
    description: '用于验证 Agent 新版本、测试、发布和回滚能力。',
    owner: '陈默',
    department: 'platform',
    visibility: '全体试点员工',
    roleIds: ['role-employee'],
    dataScopes: ['enterprise:authorized'],
    welcomeMessage: '欢迎使用二版测试助手。',
    examplePrompts: ['请验证二版能力'],
    systemPrompt: '你是集成测试助手二版，只能在授权范围内回答，并明确标注结论所依据的输入。',
    maxTokens: 16000,
    timeoutSeconds: 240,
    skills: ['skill-document@1.0.0'],
    tools: ['tool-runtime-file-read@1.0.0'],
    changeSummary: '创建二版配置',
    actor: 'U00008',
  })
  assert.equal(draft.agent.status, 'draft')
  assert.equal(draft.agent.version, '0.2.0')
  assert.equal((await agents.listWorkbenchAgents('U00001')).find(agent => agent.id === agentId)?.version, '0.1.0')

  await agents.testAgent({ agentId, prompt: '请验证二版能力', actor: 'U00008' })
  await publishDraft(agentId)
  assert.equal((await agents.getAgents()).find(agent => agent.id === agentId)?.version, '0.2.0')

  const rolledBack = await agents.rollback({ agentId, version: '0.1.0', actor: 'U00008' })
  assert.equal(rolledBack.agent.version, '0.1.0')
  const disabled = await agents.setStatus({ agentId, status: 'disabled', actor: 'U00008' })
  assert.equal(disabled.agent.status, 'disabled')
  assert.ok(!(await agents.listWorkbenchAgents('U00001')).some(agent => agent.id === agentId))
  const enabled = await agents.setStatus({ agentId, status: 'published', actor: 'U00008' })
  assert.equal(enabled.agent.status, 'published')

  const postRollbackDraft = await agents.updateAgent({
    agentId,
    name: '集成测试助手三版',
    description: '验证回滚后仍然按照历史最高版本继续生成单调递增版本。',
    owner: '陈默',
    department: 'platform',
    visibility: '全体试点员工',
    roleIds: ['role-employee'],
    dataScopes: ['enterprise:authorized'],
    welcomeMessage: '欢迎使用三版测试助手。',
    examplePrompts: ['请验证回滚后的新版本'],
    systemPrompt: '你是集成测试助手三版，只能在授权范围内回答，并提供可验证的依据。',
    maxTokens: 16000,
    timeoutSeconds: 240,
    skills: ['skill-document@1.0.0'],
    tools: ['tool-runtime-file-read@1.0.0'],
    changeSummary: '验证回滚后的版本单调递增',
    actor: 'U00008',
  })
  assert.equal(postRollbackDraft.agent.version, '0.3.0')

  const releases = (await agents.getReleaseRecords()).filter(record => record.agentId === agentId)
  assert.deepEqual(new Set(releases.map(record => record.action)), new Set(['published', 'rollback', 'disabled', 'enabled']))
})
