import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { registerSkillRoutes } from '../../http/admin/skill-routes.ts'
import { classifyHttpError, Router } from '../../http/router.ts'
import { prototypeApiAuthenticator } from '../../modules/identity/prototype-authenticator.ts'
import { FileSystemSkillArtifactStore } from '../../modules/skill/file-system-skill-artifact-store.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

let db: ThrowawayDatabase, service: PostgresSkillService, server: Server, root: string, base: string, draftId: string
const actor = 'U00008', publishedId = 'skill-document'
const configuration = {
  name: '错误分类用例', category: '测试', description: '仅用于隔离数据库的 Skill 域错误回归验证。',
  instructions: '读取合成输入后生成确定性文字，不访问真实模型和业务系统。',
  toolIds: ['read@1.0.0'], testPrompt: '验证合成测试输入。', actor,
}
before(async () => {
  db = await createThrowawayDatabase({ namePrefix: 'review_p2_skill' })
  root = await mkdtemp(join(tmpdir(), 'review-p2-skill-'))
  service = new PostgresSkillService(db.client, undefined, new PostgresToolConnectorService(db.client), new FileSystemSkillArtifactStore(root))
  draftId = (await service.createSkill(configuration)).skill.id
  const router = new Router({ authenticateApi: prototypeApiAuthenticator })
  registerSkillRoutes(router, service)
  server = createServer((request, response) => void router.handle(request, response))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/admin/v1`
})
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await db?.dispose()
  if (root) await rm(root, { recursive: true, force: true })
})
async function request(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
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
  await expectError('/skills/status', { skillId: draftId, status: 'published' }, 409, 'skill_test_required', 'PATCH')
  await expectError('/skills/rollback', { skillId: publishedId, version: '99.99.99' }, 404, 'skill_version_not_found')
})
test('P2-2: invalid status/configuration fields are 422, not implicit publication or TypeError', async () => {
  await expectError('/skills/status', { skillId: draftId, status: 'destroyed' }, 422, 'skill_input_invalid', 'PATCH')
  await expectError('/skills', { ...configuration, name: null }, 422, 'skill_input_invalid')
  await expectError('/skills', { ...configuration, toolIds: [123] }, 422, 'skill_input_invalid')
  await expectError('/skills', { ...configuration, name: 'X' }, 422, 'skill_input_invalid')
})
test('P2-2: progress endpoints classify missing Skills and non-testable state', async () => {
  await expectError('/skills/skill-does-not-exist/test-runs/missing-run', undefined, 404, 'skill_not_found', 'GET')
  await expectError(`/skills/${publishedId}/test-runs/missing-run`, undefined, 409, 'skill_draft_required', 'GET')
  await expectError(`/skills/${draftId}/test-runs/missing-run`, undefined, 409, 'skill_test_state_conflict', 'GET')
})
test('P2-2: successful configuration-only tests still work on sync and async endpoints', async () => {
  const sync = await request('/skills/test', { skillId: draftId, prompt: '有效的测试问题' })
  assert.equal(sync.status, 200); assert.equal(sync.body.data?.status, 'passed')
  const async = await request('/skills/test-runs', { skillId: draftId, prompt: '有效的测试问题' })
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
  const id = (await service.createSkill({ ...configuration, name: '执行能力不可用测试' })).skill.id
  await db.client`update skill_versions set manifest = manifest || '{"installationId":"fixture-unavailable-runner"}'::jsonb where skill_id = ${id}`
  await expectError('/skills/test', { skillId: id }, 503, 'skill_service_unavailable')
  await expectError('/skills/test-runs', { skillId: id }, 503, 'skill_service_unavailable')
  await expectError(`/skills/${id}/test-runs/missing-run`, undefined, 503, 'skill_service_unavailable', 'GET')
})
