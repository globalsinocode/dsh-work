import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { SkillArtifactStore } from '../../modules/skill/skill-artifact-store.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { publishDraftWithSealedTrial } from './test-release-fixture.ts'
import { insertSkillDraft } from './test-skill-fixture.ts'
import { LocalObjectStorage } from '../storage/local-object-storage.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let skills: PostgresSkillService
let agents: PostgresAgentService
let artifactRoot: string
let artifactStore: SkillArtifactStore

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据累积影响断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m4_skill_test', maxConnections: 3 })
  database = throwaway.client
  artifactRoot = await mkdtemp(join(tmpdir(), 'dsh-skill-lifecycle-test-'))
  artifactStore = new SkillArtifactStore(new LocalObjectStorage(artifactRoot, { fileMode: 0o400 }))
  skills = new PostgresSkillService(database, undefined, artifactStore)
  agents = new PostgresAgentService(database, undefined, skills)
})

after(async () => {
  await throwaway.dispose()
  await rm(artifactRoot, { recursive: true, force: true })
})

test('Skill 发布需通过测试，新草稿不影响已固定的引用，回滚、停用与启用保留版本历史', async () => {
  // 旧文本创建/更新接口已删除，草稿经测试夹具写入；安装链路的版本生成见 admin-skill-installation 集成套件。
  const { skillId } = await insertSkillDraft(database, artifactStore, {
    name: '订单风险归纳',
    category: '供应链',
    description: '汇总订单状态并按照统一口径识别交付风险和后续动作。',
    instructions: '读取当前输入中的订单事实，先说明分析口径，再按风险等级输出问题、证据和建议动作；不得补充输入中不存在的数据。',
    toolIds: ['read@1.0.0'],
    testPrompt: '分析当前订单的交付风险。',
    actor: 'U00008',
  })

  await assert.rejects(
    skills.setStatus({ skillId, status: 'published', actor: 'U00008' }),
    /服务端测试/,
  )
  await skills.testSkill({ skillId, actor: 'U00008' })
  const firstPublished = await skills.setStatus({ skillId, status: 'published', actor: 'U00008' })
  assert.equal(firstPublished.skill.status, 'published')
  assert.equal(firstPublished.skill.activeVersion, '0.1.0')
  await skills.assertPublishedReferences([`${skillId}@0.1.0`])

  const agentId = `agent-skill-${skillId.slice(-8)}`
  const agentDraft = await agents.createAgent({
    id: agentId,
    name: 'Skill 集成助手',
    description: '验证 Agent 能够锁定并执行已发布的 Skill Version。',
    owner: '客户端占位',
    department: '客户端占位',
    visibleRoleIds: ['role-employee'],
    welcomeMessage: '',
    examplePrompts: ['分析当前订单风险'],
    systemPrompt: '你是 Skill 集成验证助手，只能依据已授权输入和固定 Skill 指令生成可验证结论。',
    maxOutputBytes: 65536, maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: [`${skillId}@0.1.0`],
    changeSummary: '验证 Skill Version 引用',
    actor: 'U00008',
  })
  await publishDraftWithSealedTrial(database, agents, agentId, 'U00008')
  const firstAgentSnapshot = await agents.getRuntimeSnapshot(agentDraft.version.id)
  assert.equal(firstAgentSnapshot.skillInstructions[0]?.version, '0.1.0')
  assert.match(firstAgentSnapshot.skillInstructions[0]?.instructions ?? '', /风险等级/)

  await insertSkillDraft(database, artifactStore, {
    skillId,
    version: '0.2.0',
    name: '订单风险归纳二版',
    category: '供应链',
    description: '增加影响程度和建议优先级，形成更加稳定的订单交付风险结论。',
    instructions: '读取当前输入中的订单事实，说明分析口径，按风险等级和影响程度排序，输出证据、负责人建议和处理优先级；禁止虚构业务数据。',
    toolIds: ['read@1.0.0'],
    testPrompt: '按优先级分析当前订单风险。',
    actor: 'U00008',
  })
  const withDraft = (await skills.getSkills()).find(skill => skill.id === skillId)
  assert.equal(withDraft?.version, '0.2.0')
  assert.equal(withDraft?.activeVersion, '0.1.0')
  await assert.rejects(
    insertSkillDraft(database, artifactStore, { skillId, version: '0.3.0', name: '订单风险归纳', description: '不应写入的第三版。',
      instructions: '已有草稿时夹具拒绝追加，避免留下孤立草稿。', toolIds: ['read@1.0.0'], testPrompt: '验证夹具拒绝追加。', actor: 'U00008' }),
    /已有草稿/,
  )
  await skills.assertPublishedReferences([`${skillId}@0.1.0`])
  await assert.rejects(
    skills.setStatus({ skillId, status: 'published', actor: 'U00008' }),
    /服务端测试/,
  )

  await skills.testSkill({ skillId, actor: 'U00008' })
  const secondPublished = await skills.setStatus({ skillId, status: 'published', actor: 'U00008' })
  assert.equal(secondPublished.skill.activeVersion, '0.2.0')
  await skills.assertPublishedReferences([`${skillId}@0.2.0`])
  assert.equal((await agents.getRuntimeSnapshot(agentDraft.version.id)).skillInstructions[0]?.version, '0.1.0')

  const rolledBack = await skills.rollback({ skillId, version: '0.1.0', actor: 'U00008' })
  assert.equal(rolledBack.skill.activeVersion, '0.1.0')
  const disabled = await skills.setStatus({ skillId, status: 'disabled', actor: 'U00008' })
  assert.equal(disabled.skill.status, 'disabled')
  await assert.rejects(skills.assertPublishedReferences([`${skillId}@0.1.0`]), /已停用/)
  assert.equal((await skills.resolveRuntimeSkills([`${skillId}@0.1.0`]))[0]?.version, '0.1.0')
  const enabled = await skills.setStatus({ skillId, status: 'published', actor: 'U00008' })
  assert.equal(enabled.skill.status, 'published')

  const releases = (await skills.getReleaseRecords()).filter(record => record.skillId === skillId)
  assert.deepEqual(new Set(releases.map(record => record.action)), new Set(['published', 'rollback', 'disabled', 'enabled']))
  await assert.rejects(
    database`update skill_versions set instructions = '不允许修改' where tenant_id = 'tenant-dsh-work' and skill_id = ${skillId} and version = '0.1.0'`,
    /immutable/,
  )
})
