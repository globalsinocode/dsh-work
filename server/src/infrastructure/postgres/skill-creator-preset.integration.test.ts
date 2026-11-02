import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PostgresAgentAccessService } from '../../modules/agent/agent-access-service.ts'
import { agentSpecFromConfiguration } from '../../modules/agent/agent-spec.ts'
import { PostgresAgentValidationService } from '../../modules/agent/agent-validation-service.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { loadSkillCreatorPreset, seedSkillCreatorDraft } from '../../modules/agent/skill-creator-preset.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const presetRoot = fileURLToPath(new URL('../../../config/agent-presets', import.meta.url))
const preset = loadSkillCreatorPreset(presetRoot)
const EMPLOYEE = 'U00001'
const ADMIN = 'U00008'

/** 每条用例独立的一次性数据库（迁移后的初始状态），用例之间不共享数据。 */
async function withEnvironment(run: (env: {
  db: ThrowawayDatabase['client']
  agents: PostgresAgentService
  validation: PostgresAgentValidationService
  seed: () => ReturnType<typeof seedSkillCreatorDraft>
}) => Promise<void>) {
  const throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_skill_creator_preset_test', maxConnections: 4 })
  try {
    const skills = new PostgresSkillService(throwaway.client)
    const agents = new PostgresAgentService(throwaway.client, undefined, skills)
    const validation = new PostgresAgentValidationService(throwaway.client, agents, skills)
    await run({
      db: throwaway.client, agents, validation,
      seed: () => seedSkillCreatorDraft(throwaway.client, agents, validation, preset),
    })
  } finally {
    await throwaway.dispose()
  }
}

function presetDraftInput(overrides: Partial<Parameters<PostgresAgentService['createAgent']>[0]> = {}) {
  return {
    id: preset.id, name: preset.name, description: preset.description, owner: '', department: '',
    welcomeMessage: preset.welcomeMessage, examplePrompts: preset.examplePrompts, systemPrompt: preset.systemPrompt,
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300, skills: [], skillCreationEnabled: true,
    changeSummary: '预置', actor: ADMIN, ...overrides,
  }
}

test('SKC-05: preset definition matches plan 5.1 and 5.2', () => {
  assert.equal(preset.systemPrompt, readFileSync(new URL('../../../config/agent-presets/skill-creator/SOUL.md', import.meta.url), 'utf8'))
  assert.equal(preset.name, 'Skill 创建专家')
  assert.equal(preset.examplePrompts.length, 3)
  assert.equal(preset.testPrompts.length, 5)
})

test('SKC-05: a fresh environment gets an unpublished draft; roles make it releasable; restart does not seed again', async () => {
  await withEnvironment(async ({ db, agents, validation, seed }) => {
    assert.deepEqual(await seed(), { status: 'created', agentId: preset.id })

    const [row] = await db<{
      status: string; activeVersionId: string | null; visibleRoleIds: string[]; ownerUserId: string
      versionStatus: string; skillCreation: boolean; recommendation: boolean; webSearch: boolean
      systemPrompt: string; spec: unknown; mcpScope: unknown
    }[]>`
      select a.status, a.active_version_id as "activeVersionId", a.visible_role_ids as "visibleRoleIds",
             a.owner_user_id as "ownerUserId", v.status as "versionStatus", v.skill_creation_enabled as "skillCreation",
             v.agent_recommendation_enabled as recommendation, v.web_search_enabled as "webSearch",
             v.system_prompt as "systemPrompt", v.agent_spec as spec, v.mcp_scope as "mcpScope"
        from agents a join agent_versions v on v.tenant_id = a.tenant_id and v.id = a.draft_version_id
       where a.id = ${preset.id}
    `
    assert.ok(row)
    assert.equal(row.status, 'draft')
    assert.equal(row.activeVersionId, null)
    assert.equal(row.versionStatus, 'draft')
    assert.deepEqual(row.visibleRoleIds, [])
    assert.equal(row.ownerUserId, ADMIN)
    assert.equal(row.skillCreation, true)
    assert.equal(row.recommendation, false)
    assert.equal(row.webSearch, false)
    assert.deepEqual(row.mcpScope, { mode: 'none', connectorIds: [] })
    assert.equal(row.systemPrompt, preset.systemPrompt.trim())
    assert.deepEqual(row.spec, agentSpecFromConfiguration({
      id: preset.id, name: preset.name, description: preset.description, welcomeMessage: preset.welcomeMessage,
      examplePrompts: preset.examplePrompts, systemPrompt: preset.systemPrompt.trim(), skills: [],
      webSearchEnabled: false, projectTasksEnabled: false, agentRecommendationEnabled: false, skillCreationEnabled: true,
      timeoutSeconds: 300, maxToolCalls: 20, maxOutputBytes: 65536,
    }, '0.1.0'))

    const before = await validation.getOverview(preset.id)
    assert.deepEqual(before.testCases.map(item => item.prompt), preset.testPrompts)
    assert.deepEqual(before.checks.filter(check => !check.passed).map(check => check.id).sort(), ['audience', 'roles'])
    // 未发布：员工的 AI 同事列表看不到它；Skill 广场“创建 Skill”入口与推荐都取自这一列表（SKC-04、REC）。
    assert.ok(!(await agents.listWorkbenchAgents(EMPLOYEE)).some(agent => agent.id === preset.id))

    const access = new PostgresAgentAccessService(db)
    const current = await access.getAccess(preset.id)
    await access.updateAccess({
      agentId: preset.id, actor: ADMIN, expectedRevision: current.revision,
      visibleRoleIds: ['role-employee', 'role-platform-admin'], roleIds: ['role-employee'], dataScopes: [],
    })
    assert.deepEqual((await validation.getOverview(preset.id)).checks.filter(check => !check.passed), [])

    assert.deepEqual(await seed(), { status: 'skipped', reason: 'exists' })
    const [{ count }] = await db<{ count: number }[]>`select count(*)::int as count from agent_versions where skill_creation_enabled`
    assert.equal(count, 1)
  })
})

test('SKC-05: a draft created before a failed test-case write gets its test cases on the next start', async () => {
  await withEnvironment(async ({ agents, validation, seed }) => {
    await agents.createAgent(presetDraftInput())
    assert.deepEqual(await seed(), { status: 'resumed', agentId: preset.id })
    assert.deepEqual((await validation.getOverview(preset.id)).testCases.map(item => item.prompt), preset.testPrompts)
    assert.deepEqual(await seed(), { status: 'skipped', reason: 'exists' })
  })
})

test('SKC-05: an Agent with the preset id but without skill creation is left alone', async () => {
  await withEnvironment(async ({ agents, validation, seed }) => {
    await agents.createAgent(presetDraftInput({ skillCreationEnabled: false }))
    assert.deepEqual(await seed(), { status: 'skipped', reason: 'exists' })
    assert.equal((await validation.getOverview(preset.id)).testCases.length, 0)
  })
})

test('SKC-05: an existing creator Agent (any id, unpublished) prevents seeding', async () => {
  await withEnvironment(async ({ db, agents, seed }) => {
    await agents.createAgent(presetDraftInput({
      id: 'agent-admin-made-creator', name: '管理员自建的专家', description: '管理员自己创建的 Skill 创建专家',
      systemPrompt: '你帮员工把反复使用的工作方法写成 Skill 草稿，保存后由员工提交审核。',
    }))
    assert.deepEqual(await seed(), { status: 'skipped', reason: 'exists' })
    const [{ count }] = await db<{ count: number }[]>`select count(*)::int as count from agents where id = ${preset.id}`
    assert.equal(count, 0)
  })
})

test('SKC-05: without a local platform admin nothing is seeded', async () => {
  await withEnvironment(async ({ db, seed }) => {
    await db`delete from user_roles where role_id in (select id from roles where permissions ? 'admin:*' or permissions ? 'admin:write')`
    assert.deepEqual(await seed(), { status: 'skipped', reason: 'no_admin' })
    const [{ count }] = await db<{ count: number }[]>`select count(*)::int as count from agents where id = ${preset.id}`
    assert.equal(count, 0)
  })
})

test('SKC-05: two instances starting together create one draft', async () => {
  await withEnvironment(async ({ db, validation, seed }) => {
    const results = await Promise.all([seed(), seed()])
    assert.equal(results.filter(result => result.status === 'created').length, 1)
    const [{ count }] = await db<{ count: number }[]>`select count(*)::int as count from agents where id = ${preset.id}`
    assert.equal(count, 1)
    assert.deepEqual((await validation.getOverview(preset.id)).testCases.map(item => item.prompt), preset.testPrompts)
  })
})
