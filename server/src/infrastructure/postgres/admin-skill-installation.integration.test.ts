import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Router } from '../../http/router.ts'
import { registerAssistantRoutes } from '../../http/admin/assistant-routes.ts'
import { prototypeApiAuthenticator } from '../../modules/identity/prototype-authenticator.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { DshAcpRuntimeAdapter } from '../../modules/runtime/dsh-acp-runtime-adapter.ts'
import { resolveDshRuntimeInstallation } from '../../modules/runtime/dsh-runtime-installation.ts'
import { AdminSkillInstallationService } from '../../modules/skill/admin-skill-installation-service.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { acquireSkillSource } from '../../modules/skill/skill-source.ts'

const tenant = 'tenant-dsh-work', actor = 'U00008'
const real = process.env.DSH_WORK_SKILL_REAL_DSH === '1'
let database: ThrowawayDatabase, orchestration: RunOrchestrationService, service: AdminSkillInstallationService
let runtimeRoot: string, conversations: PostgresConversationRepository, runs: PostgresRunRepository
const body = '---\nname: installation-test\ndescription: Read a reference file and return its exact contents.\n---\nUse the read tool to read references/value.txt and report exactly the value, never infer or fabricate it.\n'
const bytes = zipSync({ 'SKILL.md': strToU8(body), 'references/value.txt': strToU8('SKILL_RESOURCE_MARKER_7F31') })
before(async () => {
  database = await createThrowawayDatabase({ namePrefix: 'dsh_skill_installation_test' })
  runtimeRoot = await mkdtemp(join(tmpdir(), 'dsh-install-test-'))
  const projectRoot = resolve(import.meta.dirname, '../../../..')
  const installation = real ? await resolveDshRuntimeInstallation({ projectRoot }) : null
  const runtime = new DshAcpRuntimeAdapter({ runtimeId: 'runtime-local-01', runtimeRoot, dshRepository: installation?.home ?? runtimeRoot,
    process: installation?.process ?? { command: process.execPath, args: ['--experimental-strip-types', resolve(import.meta.dirname, '../../modules/runtime/testing/mock-acp-worker.ts')], cwd: runtimeRoot },
    permissionDecision: async () => 'allow_once', prepareSkillInstallation: (manifest, signal) => service.prepare(manifest, signal),
  })
  const auth = new PostgresAuthorizationService(database.client)
  const operations = new PostgresOperationsService(database.client)
  const tools = new PostgresToolConnectorService(database.client, runtime, operations)
  conversations = new PostgresConversationRepository(database.client)
  runs = new PostgresRunRepository(database.client)
  orchestration = new RunOrchestrationService(runs, conversations, new ModelGovernanceService(new PostgresModelGovernanceRepository(database.client)), runtime, undefined, operations, undefined, undefined, auth)
  service = new AdminSkillInstallationService(database.client, orchestration, auth, tools, real ? acquireSkillSource : async source => ({ bytes: source.repository === 'fixture/multiple' ? zipSync({ 'repo/wanted/SKILL.md': strToU8(body.replace('installation-test', 'wanted')), 'repo/wanted/references/value.txt': strToU8('selected-marker'), 'repo/other/SKILL.md': strToU8(body.replace('installation-test', 'other').replace('description:', 'allowed-tools: [Bash]\ndescription:')) }) : bytes, resolvedUrl: source.url, resolvedRef: null }))
})
after(async () => { await orchestration?.close(); await database?.dispose(); if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true }) })
const source = real ? 'https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/web-design-guidelines/SKILL.md' : 'https://example.org/skill.zip'
async function send(message = source) {
  const sessionId = `admin-session-${randomUUID()}`, requestId = randomUUID()
  const detail = await service.send(actor, { sessionId, requestId, message })
  return { sessionId, requestId, runId: detail.runs[0]!.id }
}
async function wait(sessionId: string) {
  for (let index = 0; index < (real ? 180 : 150); index++) {
    const detail = await service.detail(actor, sessionId)
    if (detail.runs.every(run => ['succeeded', 'failed', 'cancelled'].includes(run.status))) return detail
    await delay(real ? 1000 : 100)
  }
  throw new Error('Installation run did not finish')
}
test('DSH tool preview, explicit confirmation, atomic idempotent install and durable history', { timeout: 210000 }, async () => {
  const { sessionId, requestId, runId } = await send()
  const detail = await wait(sessionId)
  assert.equal(detail.runs[0]?.status, 'succeeded', JSON.stringify(detail.runs))
  assert.ok(detail.installations[0]?.package, JSON.stringify(detail.messages))
  const pkg = detail.installations[0]!.package!
  assert.equal(detail.installations[0]?.status, 'pending')
  const [beforeCount] = await database.client<{ count: number }[]>`select count(*)::int as count from skills`
  await assert.rejects(service.confirm(actor, runId, 'wrong-digest'), /预览/)
  const results = await Promise.all([service.confirm(actor, runId, pkg.sha256), service.confirm(actor, runId, pkg.sha256)])
  assert.equal(results[0]!.installations[0]?.skillId, results[1]!.installations[0]?.skillId)
  assert.equal(results[0]!.installations[0]?.status, 'installed')
  const [afterCount] = await database.client<{ count: number }[]>`select count(*)::int as count from skills`
  assert.equal(afterCount!.count, beforeCount!.count + 1)
  const [version] = await database.client<{ status: string; manifest: { package: { files: unknown[] } } }[]>`select status, manifest from skill_versions where skill_id = ${results[0]!.installations[0]!.skillId!}`
  assert.equal(version?.status, 'draft')
  assert.ok(version!.manifest.package.files.length)
  if (!real) {
    const skills = new PostgresSkillService(database.client)
    const skillId = results[0]!.installations[0]!.skillId!
    await assert.rejects(skills.testSkill({ skillId, actor }), /试运行不可用/)
    await assert.rejects(skills.setStatus({ skillId, actor, status: 'published' }), /测试/)
    skills.setPackageTester(async () => ({ passed: false, summary: 'Runtime failed', runId: 'failed-test' }))
    assert.equal((await skills.testSkill({ skillId, actor })).status, 'failed')
    await assert.rejects(skills.setStatus({ skillId, actor, status: 'published' }), /测试/)
    skills.setPackageTester((userId, skill, prompt) => service.testPackage(userId, skill, prompt))
    assert.equal((await skills.testSkill({ skillId, actor })).status, 'passed')
    await skills.setStatus({ skillId, actor, status: 'published' })
    const resolved = await skills.resolveRuntimeSkills([`${skillId}@0.1.0`])
    assert.equal(resolved[0]?.files?.find(file => file.path === 'references/value.txt')?.content, 'SKILL_RESOURCE_MARKER_7F31')
  }
  const duplicate = await service.send(actor, { sessionId, requestId, message: source })
  assert.equal(duplicate.runs.length, 1)
  assert.ok((await service.list(actor)).some(item => item.id === sessionId))
  await assert.rejects(service.detail('U00001', sessionId), /不存在或不可访问/)
  await assert.rejects(conversations.requireSession(sessionId, actor), /不存在或不可访问/)
  assert.equal(await conversations.getTask(runId, actor), null)
  await assert.rejects(orchestration.cancel(runId, actor), /不存在或不可访问/)
  const events = await runs.readEventsAfterEvent(tenant, runId)
  assert.ok(events.some(event => event.eventType === 'run.completed'))
  if (real) {
    const completion = events.find(event => event.eventType === 'run.completed')!
    assert.ok(Number(completion.safeMetadata['tool_call_count']) > 0, 'Real DSH tool call evidence required')
    console.log(JSON.stringify({ realDsh: true, package: pkg.name, digest: pkg.sha256, toolCalls: completion.safeMetadata['tool_call_count'], installed: true }))
  }
})
test('cancellation blocks confirmation, retries keep Run identity, and permission is rechecked', { skip: real }, async () => {
  const cancelled = await send('[hang] https://example.org/skill.zip')
  await service.cancel(actor, cancelled.runId)
  await wait(cancelled.sessionId)
  await service.retry(actor, cancelled.runId)
  await service.cancel(actor, cancelled.runId)
  await wait(cancelled.sessionId)
  const [attemptCount] = await database.client<{ count: number }[]>`select count(*)::int as count from run_attempts where run_id = ${cancelled.runId}`
  assert.equal(attemptCount!.count, 2)
  await assert.rejects(service.confirm(actor, cancelled.runId, 'x'), /预览|取消/)
  const ready = await send()
  const detail = await wait(ready.sessionId)
  const digest = detail.installations[0]!.package!.sha256
  await service.cancel(actor, ready.runId)
  await assert.rejects(service.confirm(actor, ready.runId, digest), /取消/)
  const permission = await send()
  const permitted = await wait(permission.sessionId)
  await database.client`update users set status = 'disabled' where id = ${actor}`
  await assert.rejects(service.confirm(actor, permission.runId, permitted.installations[0]!.package!.sha256), /停用|权限/)
  await database.client`update users set status = 'active' where id = ${actor}`
})

test('real DSH reads the exact immutable Skill resource through the governed read tool', { skip: !real, timeout: 210000 }, async () => {
  const { parseSkillPackage } = await import('../../modules/skill/skill-package.ts')
  const pkg = parseSkillPackage(bytes)
  const result = await service.testPackage(actor, { id: 'skill-resource-probe', version: '0.1.0', instructions: pkg.instructions, tools: pkg.toolIds, files: pkg.files }, '请实际读取此 Skill 的 references/value.txt，逐字返回文件值；不要猜测。')
  if (!result.passed) console.log(JSON.stringify({ resourceFailure: (await runs.readEventsAfterEvent(tenant, result.runId)).slice(-5) }))
  assert.equal(result.passed, true, result.summary)
  assert.match(result.summary, /SKILL_RESOURCE_MARKER_7F31/)
  const events = await runs.readEventsAfterEvent(tenant, result.runId)
  const completion = events.find(event => event.eventType === 'run.completed')!
  assert.ok(Number(completion.safeMetadata['tool_call_count']) > 0)
  console.log(JSON.stringify({ realDshResourceRead: true, toolCalls: completion.safeMetadata['tool_call_count'] }))
})

test('admin HTTP routes enforce write permission, conversation ownership and unavailable mode', { skip: real }, async () => {
  const saved = await send(); await wait(saved.sessionId)
  let userId = actor
  const router = new Router({ authenticateApi: async (request, audience) => ({ ...(await prototypeApiAuthenticator(request, audience)), userId, permissions: ['admin:read'] }) })
  registerAssistantRoutes(router, service)
  const server = createServer((request, response) => { void router.handle(request, response) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}/api/admin/v1/assistant`
  try {
    assert.equal((await fetch(`${base}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
    assert.equal((await fetch(`${base}/sessions/${saved.sessionId}`)).status, 200)
    userId = 'U00001'
    assert.equal((await fetch(`${base}/sessions/${saved.sessionId}`)).status, 403)
    const history = await fetch(`${base}/sessions`).then(response => response.json()) as { data: unknown[] }
    assert.deepEqual(history.data, [])
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('a later message selects the previous repository and snapshots only its own conversation', { skip: real }, async () => {
  const first = await send('https://github.com/fixture/multiple')
  const before = await wait(first.sessionId)
  assert.equal(before.installations.length, 0)
  const requestId = randomUUID()
  const second = await service.send(actor, { sessionId: first.sessionId, requestId, message: '选上一个仓库中的 wanted' })
  const completed = await wait(first.sessionId)
  assert.equal(completed.installations[0]?.package?.name, 'wanted')
  const run = second.runs.find(run => run.id !== first.runId)!
  const [attempt] = await database.client<{ manifest: import('../../modules/runtime/runtime-types.ts').RuntimeManifest }[]>`
    select manifest from run_attempts where run_id = ${run.id} order by created_at desc limit 1
  `
  assert.equal(JSON.parse(attempt!.manifest.installation_source!).repository, 'fixture/multiple')
  assert.equal(JSON.parse(attempt!.manifest.installation_source!).selected, 'wanted')
  assert.ok(attempt!.manifest.input.conversation_history?.some(message => message.content === 'https://github.com/fixture/multiple'))
  assert.ok(attempt!.manifest.input.conversation_history!.every(message => before.messages.some(previous => previous.text === message.content)))
  assert.equal((await service.send(actor, { sessionId: first.sessionId, requestId, message: '选上一个仓库中的 wanted' })).runs.length, 2)
  const other = await send('选择 wanted')
  const unrelated = await wait(other.sessionId)
  assert.equal(unrelated.installations.length, 0)
  const [otherAttempt] = await database.client<{ manifest: import('../../modules/runtime/runtime-types.ts').RuntimeManifest }[]>`select manifest from run_attempts where run_id = ${other.runId}`
  assert.equal(otherAttempt!.manifest.installation_source, '')
  assert.equal(otherAttempt!.manifest.input.conversation_history, undefined)
})
