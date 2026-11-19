import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { registerSkillRoutes } from '../../http/admin/skill-routes.ts'
import { classifyHttpError, Router } from '../../http/router.ts'
import { testApiAuthenticator } from '../../testing/test-identity.ts'
import { SkillArtifactStore } from '../../modules/skill/skill-artifact-store.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { insertSkillDraft, useSyntheticSkillTrials } from './test-skill-fixture.ts'
import { LocalObjectStorage } from '../storage/local-object-storage.ts'

let db: ThrowawayDatabase, service: PostgresSkillService, root: string, base: string, draftId: string, legacyId: string
const servers: Server[] = []
let artifactStore: SkillArtifactStore
const actor = 'U00008', publishedId = 'skill-document'
const configuration = {
  name: '错误分类用例', category: '测试', description: '仅用于隔离数据库的 Skill 域错误回归验证。',
  instructions: '读取合成输入后生成确定性文字，不访问真实模型和业务系统。',
  toolIds: ['read@1.0.0'], testPrompt: '验证合成测试输入。', actor,
}
before(async () => {
  db = await createThrowawayDatabase({ namePrefix: 'review_p2_skill' })
  root = await mkdtemp(join(tmpdir(), 'review-p2-skill-'))
  artifactStore = new SkillArtifactStore(new LocalObjectStorage(root, { fileMode: 0o400 }))
  service = new PostgresSkillService(db.client, undefined, artifactStore)
  draftId = (await insertSkillDraft(db.client, artifactStore, configuration)).skillId
  legacyId = (await insertSkillDraft(db.client, artifactStore, { ...configuration, name: '旧文本接口草稿', legacy: true })).skillId
  base = await listen(service)
})
after(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await db?.dispose()
  if (root) await rm(root, { recursive: true, force: true })
})
async function listen(skillService: PostgresSkillService) {
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerSkillRoutes(router, skillService, async () => ({ skills: [], scenarios: [], disabledBuiltinSkills: [] }))
  const server = createServer((request, response) => void router.handle(request, response))
  servers.push(server)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/admin/v1`
}
async function request(path: string, body?: unknown, method = 'POST', origin = base) {
  const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() as { error?: { code: string; message: string; suggestion: string }; data?: { status: string } } }
}
async function expectError(path: string, body: unknown, status: number, code: string, method = 'POST') {
  const result = await request(path, body, method)
  assert.equal(result.status, status)
  assert.equal(result.body.error?.code, code)
  assert.equal(typeof result.body.error?.suggestion, 'string')
  assert.ok(result.body.error!.suggestion.length > 0)
}
for (const endpoint of ['/skills/test', '/skills/test-runs']) {
  test(`P2-2 RED: missing Skill returns typed 404 (${endpoint})`, async () => {
    await expectError(endpoint, { skillId: 'skill-does-not-exist' }, 404, 'skill_not_found')
  })
  test(`P2-2 RED: published Skill without draft returns 409 (${endpoint})`, async () => {
    await expectError(endpoint, { skillId: publishedId }, 409, 'skill_draft_required')
  })
  test(`P2-2 RED: short/blank prompt returns typed 422 (${endpoint})`, async () => {
    for (const prompt of ['abc', '   ']) await expectError(endpoint, { skillId: draftId, prompt }, 422, 'skill_test_prompt_invalid')
  })
  test(`P2-2: malformed runtime inputs cannot cause TypeError/SQL 500 (${endpoint})`, async () => {
    for (const prompt of [123, null, [], {}]) await expectError(endpoint, { skillId: draftId, prompt }, 422, 'skill_test_prompt_invalid')
    for (const skillId of [123, null, '']) await expectError(endpoint, { skillId }, 422, 'skill_input_invalid')
  })
}

test('P2-2 RED: published/draft lifecycle conflicts have explicit stable codes', async () => {
  await expectError('/skills/status', { skillId: draftId, status: 'disabled' }, 409, 'skill_state_conflict', 'PATCH')
  await expectError('/skills/status', { skillId: publishedId, status: 'published' }, 409, 'skill_state_conflict', 'PATCH')
  await expectError('/skills/status', { skillId: draftId, status: 'published' }, 409, 'skill_test_coverage_incomplete', 'PATCH')
  await expectError('/skills/rollback', { skillId: publishedId, version: '99.99.99' }, 404, 'skill_version_not_found')
})
test('P2-2: invalid status fields are 422, not implicit publication or TypeError', async () => {
  await expectError('/skills/status', { skillId: draftId, status: 'destroyed' }, 422, 'skill_input_invalid', 'PATCH')
})
test('文本创建/更新 Skill 的接口已删除，只能经安装或员工提交进入', async () => {
  await expectError('/skills', configuration, 404, 'route_not_found')
  await expectError('/skills', { ...configuration, skillId: draftId }, 404, 'route_not_found', 'PATCH')
})
test('P2-2: progress endpoints classify missing Skills and non-testable state', async () => {
  await expectError('/skills/skill-does-not-exist/test-runs/missing-run', undefined, 404, 'skill_not_found', 'GET')
  await expectError(`/skills/${publishedId}/test-runs/missing-run`, undefined, 409, 'skill_draft_required', 'GET')
  await expectError(`/skills/${legacyId}/test-runs/missing-run`, undefined, 409, 'skill_legacy_draft_unsupported', 'GET')
})
test('旧文本接口留下的草稿在试运行、进度与发布入口都被明确拒绝，建议放弃后重新安装', async () => {
  const suggestion = '请在 Skill 详情的“版本历史”中放弃该草稿（已发布版本不受影响），再经 ZIP、链接或管理助手安装新包。'
  for (const [path, body, method] of [
    ['/skills/test', { skillId: legacyId, prompt: '有效的测试问题' }, 'POST'],
    ['/skills/test-runs', { skillId: legacyId, prompt: '有效的测试问题' }, 'POST'],
    [`/skills/${legacyId}/test-runs/missing-run`, undefined, 'GET'],
    ['/skills/status', { skillId: legacyId, status: 'published' }, 'PATCH'],
  ] as const) {
    const result = await request(path, body, method)
    assert.equal(result.status, 409, path)
    assert.equal(result.body.error?.code, 'skill_legacy_draft_unsupported', path)
    // 管理端只显示 message，放弃草稿的指引须写在 message 中。
    assert.match(result.body.error?.message ?? '', /已删除的文本创建\/更新接口.*“版本历史”中放弃该草稿后重新安装/)
    assert.equal(result.body.error?.suggestion, suggestion)
  }
  const [tests] = await db.client<{ count: number }[]>`select count(*)::int as count from skill_test_runs where skill_id = ${legacyId}`
  assert.equal(tests?.count, 0)
})
test('P2-2: installed drafts pass strict tests on sync and async endpoints (synthetic evidence)', async () => {
  const trials = new PostgresSkillService(db.client, undefined, artifactStore)
  useSyntheticSkillTrials(db.client, trials)
  const origin = await listen(trials)
  const sync = await request('/skills/test', { skillId: draftId, prompt: '有效的测试问题' }, 'POST', origin)
  assert.equal(sync.status, 200); assert.equal(sync.body.data?.status, 'passed')
  const async = await request('/skills/test-runs', { skillId: draftId, prompt: '有效的测试问题' }, 'POST', origin)
  assert.equal(async.status, 202); assert.equal(async.body.data?.status, 'passed')
})
test('P2-2: service domain errors carry status/code without depending on Router wording', async () => {
  await assert.rejects(service.testSkill({ skillId: 'skill-does-not-exist', actor }), { status: 404, code: 'skill_not_found' })
  await assert.rejects(service.testSkill({ skillId: publishedId, actor }), { status: 409, code: 'skill_draft_required' })
  await assert.rejects(service.setStatus({ skillId: draftId, actor, status: 'disabled' }), { status: 409, code: 'skill_state_conflict' })
})
test('P2-2: existing admin authorization still denies ordinary users before object lookup', async () => {
  await assert.rejects(service.testSkill({ skillId: draftId, actor: 'U00001' }), { status: 403, code: 'permission_denied' })
})
test('P2-2: unexpected dependency failure remains a sanitized 500, not a client error', async () => {
  const internal = new Error('fixture database transport broke')
  const failing = new PostgresSkillService((() => { throw internal }) as unknown as typeof db.client)
  await assert.rejects(failing.testSkill({ skillId: draftId, actor }), error => error === internal)
  const failure = classifyHttpError(internal, '/api/admin/v1/skills/test')
  assert.equal(failure.status, 500); assert.equal(failure.error.code, 'operation_failed')
  assert.doesNotMatch(failure.error.message, /transport/)
})

test('P2-2: missing strict runner remains service-unavailable 503 on test/start/progress', async () => {
  const id = (await insertSkillDraft(db.client, artifactStore, { ...configuration, name: '执行能力不可用测试' })).skillId
  await expectError('/skills/test', { skillId: id }, 503, 'skill_service_unavailable')
  await expectError('/skills/test-runs', { skillId: id }, 503, 'skill_service_unavailable')
  await expectError(`/skills/${id}/test-runs/missing-run`, undefined, 503, 'skill_service_unavailable', 'GET')
})
