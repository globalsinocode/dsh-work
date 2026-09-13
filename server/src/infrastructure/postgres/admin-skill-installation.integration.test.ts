import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Router } from '../../http/router.ts'
import { registerAssistantRoutes } from '../../http/admin/assistant-routes.ts'
import { registerSkillInstallationRoutes } from '../../http/admin/skill-installation-routes.ts'
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
import { acquireSkillSource, type SkillSource } from '../../modules/skill/skill-source.ts'
import { FileSystemSkillArtifactStore } from '../../modules/skill/file-system-skill-artifact-store.ts'
import { migrateSkillFilesToFileSystem } from '../../modules/skill/skill-file-storage-migration.ts'
import { parseSkillPackage } from '../../modules/skill/skill-package.ts'
import { compileRuntimeManifest } from '../../modules/runtime/manifest-compiler.ts'
import type { RuntimeManifest } from '../../modules/runtime/runtime-types.ts'

const tenant = 'tenant-dsh-work', actor = 'U00008'
const real = process.env.DSH_WORK_SKILL_REAL_DSH === '1'
let database: ThrowawayDatabase, orchestration: RunOrchestrationService, service: AdminSkillInstallationService
let runtimeRoot: string, conversations: PostgresConversationRepository, runs: PostgresRunRepository
let artifactStore: FileSystemSkillArtifactStore
const body = '---\nname: installation-test\ndescription: Read a reference file and return its exact contents.\n---\nUse the read tool to read references/value.txt and report exactly the value, never infer or fabricate it.\n'
const bytes = zipSync({ 'SKILL.md': strToU8(body), 'references/value.txt': strToU8('SKILL_RESOURCE_MARKER_7F31') })
const changedBytes = zipSync({ 'SKILL.md': strToU8(`${body}\nReturn the result as one concise line.\n`), 'references/value.txt': strToU8('SKILL_RESOURCE_MARKER_7F31') })
const conflictingBytes = zipSync({ 'SKILL.md': strToU8(`${body}\nReturn the result as JSON.\n`), 'references/value.txt': strToU8('SKILL_RESOURCE_MARKER_7F31') })
async function fixtureAcquire(source: SkillSource) {
  const fixture = source.repository === 'fixture/multiple'
    ? zipSync({ 'repo/wanted/SKILL.md': strToU8(body.replace('installation-test', 'wanted')), 'repo/wanted/references/value.txt': strToU8('selected-marker'), 'repo/other/SKILL.md': strToU8(body.replace('installation-test', 'other').replace('description:', 'allowed-tools: [Bash]\ndescription:')) })
    : source.repository === 'fixture/delegated' || source.repository === 'fixture/delegated-updated'
      ? zipSync({ 'repo/grill-me/SKILL.md': strToU8(`---\nname: grill-me\ndescription: Delegate to the complete grilling workflow.\n---\nCall the Skill tool with "grilling" and follow its instructions exactly.${source.repository.endsWith('updated') ? '\nReturn a concise final answer.' : ''}\n`), 'repo/grilling/SKILL.md': strToU8(body.replace('installation-test', 'grilling')), 'repo/grilling/references/value.txt': strToU8('dependency-marker') })
      : source.repository === 'fixture/changed' ? changedBytes
        : source.repository === 'fixture/conflicting' ? conflictingBytes : bytes
  return { bytes: fixture, resolvedUrl: source.url, resolvedRef: null }
}
before(async () => {
  database = await createThrowawayDatabase({ namePrefix: 'dsh_skill_installation_test' })
  runtimeRoot = await mkdtemp(join(tmpdir(), 'dsh-install-test-'))
  artifactStore = new FileSystemSkillArtifactStore(join(runtimeRoot, 'skills'))
  const projectRoot = resolve(import.meta.dirname, '../../../..')
  const installation = real ? await resolveDshRuntimeInstallation({ projectRoot }) : null
  const runtime = new DshAcpRuntimeAdapter({ runtimeId: 'runtime-local-01', runtimeRoot, dshRepository: installation?.home ?? runtimeRoot,
    process: installation?.process ?? { command: process.execPath, args: ['--experimental-strip-types', resolve(import.meta.dirname, '../../modules/runtime/testing/mock-acp-worker.ts')], cwd: runtimeRoot },
    permissionDecision: async () => 'allow_once', prepareSkillInstallation: (manifest, signal) => service.prepare(manifest, signal),
    loadSkillArtifact: skill => artifactStore.readRuntimeArtifact(skill.artifact_ref!, skill.files ?? [], skill.instructions_sha256!),
    recordSkillActivation: (manifest, skill, digest) => service.recordActivation(manifest, skill, digest),
  })
  const auth = new PostgresAuthorizationService(database.client)
  const operations = new PostgresOperationsService(database.client)
  const tools = new PostgresToolConnectorService(database.client, runtime, operations)
  conversations = new PostgresConversationRepository(database.client)
  runs = new PostgresRunRepository(database.client)
  orchestration = new RunOrchestrationService(runs, conversations, new ModelGovernanceService(new PostgresModelGovernanceRepository(database.client)), runtime, undefined, operations, undefined, undefined, auth)
  service = new AdminSkillInstallationService(database.client, orchestration, auth, tools, real ? acquireSkillSource : fixtureAcquire, false, [], artifactStore)
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
  await assert.rejects(service.confirm(actor, runId, 'wrong-digest'), /计划/)
  const planSha256 = detail.installations[0]!.planSha256!
  const results = await Promise.all([service.confirm(actor, runId, planSha256), service.confirm(actor, runId, planSha256)])
  assert.equal(results[0]!.installations[0]?.skillId, results[1]!.installations[0]?.skillId)
  assert.equal(results[0]!.installations[0]?.status, 'installed')
  assert.equal(results[0]!.messages.filter(message => message.text.includes('已安装完成，并保存为 v0.1.0 待验证草稿')).length, 1)
  assert.match(results[0]!.messages.find(message => message.text.includes('已安装完成'))?.text ?? '', /Skill 标识：skill-/)
  const [afterCount] = await database.client<{ count: number }[]>`select count(*)::int as count from skills`
  assert.equal(afterCount!.count, beforeCount!.count + 1)
  const [version] = await database.client<{ status: string; instructions: string; manifest: { artifact: import('../../modules/skill/skill-package.ts').SkillPackageArtifact } }[]>`select status, instructions, manifest from skill_versions where skill_id = ${results[0]!.installations[0]!.skillId!}`
  assert.equal(version?.status, 'draft')
  assert.equal(version?.instructions, '')
  assert.ok(version!.manifest.artifact.files.length)
  assert.equal(JSON.stringify(version!.manifest).includes('SKILL_RESOURCE_MARKER_7F31'), false)
  assert.equal((await artifactStore.read(version!.manifest.artifact)).files.find(file => file.path === 'references/value.txt')?.content, 'SKILL_RESOURCE_MARKER_7F31')
  if (!real) {
    const skills = new PostgresSkillService(database.client, undefined, undefined, artifactStore)
    const skillId = results[0]!.installations[0]!.skillId!
    await assert.rejects(skills.testSkill({ skillId, actor }), /试运行不可用/)
    await assert.rejects(skills.setStatus({ skillId, actor, status: 'published' }), /测试/)
    skills.setPackageTester(async () => ({ passed: false, summary: 'Runtime failed', runId: 'failed-test' }))
    assert.equal((await skills.testSkill({ skillId, actor })).status, 'failed')
    await assert.rejects(skills.setStatus({ skillId, actor, status: 'published' }), /测试/)
    skills.setPackageTestLifecycle({
      start: (userId, skill, prompt) => service.startPackageTest(userId, skill, prompt),
      progress: (userId, skill, testRunId) => service.packageTestProgress(userId, skill, testRunId),
    })
    const startedTest = await skills.startSkillTest({ skillId, actor })
    assert.ok(['queued', 'running', 'passed'].includes(startedTest.status))
    assert.equal(startedTest.steps[0]?.title, '创建严格试运行')
    let testProgress = startedTest
    for (let index = 0; index < 150 && ['queued', 'running', 'cancel_requested'].includes(testProgress.status); index++) {
      await delay(100)
      testProgress = await skills.getSkillTestProgress({ skillId, runId: startedTest.runId, actor })
    }
    assert.equal(testProgress.status, 'passed', testProgress.resultSummary)
    assert.ok(testProgress.steps.some(step => step.id.startsWith('activation:') && step.status === 'completed'))
    await skills.setStatus({ skillId, actor, status: 'published' })
    const resolved = await skills.resolveRuntimeSkills([`${skillId}@0.1.0`])
    assert.equal((await artifactStore.read(resolved[0]!.artifact!)).files.find(file => file.path === 'references/value.txt')?.content, 'SKILL_RESOURCE_MARKER_7F31')
    const [storedBodies] = await database.client<{ versions: number; installations: number; attempts: number }[]>`
      select
        (select count(*)::int from skill_versions where manifest::text like '%SKILL_RESOURCE_MARKER_7F31%' or instructions like '%SKILL_RESOURCE_MARKER_7F31%') as versions,
        (select count(*)::int from skill_installations where package::text like '%SKILL_RESOURCE_MARKER_7F31%' or plan::text like '%SKILL_RESOURCE_MARKER_7F31%') as installations,
        (select count(*)::int from run_attempts where manifest::text like '%SKILL_RESOURCE_MARKER_7F31%') as attempts
    `
    assert.deepEqual(storedBodies, { versions: 0, installations: 0, attempts: 0 })

    const [beforeDuplicate] = await database.client<{ skills: number; versions: number }[]>`
      select (select count(*)::int from skills) as skills, (select count(*)::int from skill_versions) as versions
    `
    const repeated = await send()
    const repeatedPlan = await wait(repeated.sessionId)
    const repeatedResult = await service.confirm(actor, repeated.runId, repeatedPlan.installations[0]!.planSha256!)
    assert.equal(repeatedResult.installations[0]!.resultType, 'duplicate')
    assert.equal(repeatedResult.installations[0]!.installedVersion, '0.1.0')
    assert.match(repeatedResult.messages.find(message => message.text.includes('无需重复安装'))?.text ?? '', /未创建重复 Skill/)
    const [afterDuplicate] = await database.client<{ skills: number; versions: number }[]>`
      select (select count(*)::int from skills) as skills, (select count(*)::int from skill_versions) as versions
    `
    assert.deepEqual(afterDuplicate, beforeDuplicate)

    const updateRequest = await send('npx skills@latest add fixture/changed --skill=installation-test')
    const updatePlan = await wait(updateRequest.sessionId)
    const updateResult = await service.confirm(actor, updateRequest.runId, updatePlan.installations[0]!.planSha256!)
    assert.equal(updateResult.installations[0]!.skillId, skillId)
    assert.equal(updateResult.installations[0]!.resultType, 'updated')
    assert.equal(updateResult.installations[0]!.installedVersion, '0.2.0')
    assert.match(updateResult.messages.find(message => message.text.includes('新版本 v0.2.0'))?.text ?? '', /严格试运行/)

    const conflictRequest = await send('npx skills@latest add fixture/conflicting --skill=installation-test')
    const conflictPlan = await wait(conflictRequest.sessionId)
    await assert.rejects(service.confirm(actor, conflictRequest.runId, conflictPlan.installations[0]!.planSha256!), /已有内容不同的待验证草稿/)
    const conflictResult = await service.detail(actor, conflictRequest.sessionId)
    assert.match(conflictResult.messages.find(message => message.text.includes('安装失败'))?.text ?? '', /本次未创建或覆盖 Skill/)
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
test('ZIP upload reuses package parsing, compatibility planning, folder storage and atomic confirmation', { skip: real }, async () => {
  const preview = await service.prepareZip(actor, { fileName: 'installation-test.zip', bytes })
  assert.equal(preview.runId, null)
  assert.equal(preview.source, 'installation-test.zip')
  assert.equal(preview.status, 'pending')
  assert.equal(preview.package?.name, 'installation-test')
  assert.equal(preview.plan?.rootName, 'installation-test')
  assert.equal(preview.planSha256, preview.plan?.sha256)
  assert.equal(preview.package?.files.some(file => file.path === 'references/value.txt'), true)
  const [stored] = await database.client<{ runId: string | null; channel: string; containsBody: boolean }[]>`
    select run_id as "runId", channel, (package::text like '%SKILL_RESOURCE_MARKER_7F31%' or plan::text like '%SKILL_RESOURCE_MARKER_7F31%') as "containsBody"
    from skill_installations where id = ${preview.id}
  `
  assert.deepEqual(stored, { runId: null, channel: 'zip', containsBody: false })
  await assert.rejects(service.confirmZip(actor, preview.id, 'wrong-digest'), /计划/)
  const [first, second] = await Promise.all([
    service.confirmZip(actor, preview.id, preview.planSha256!),
    service.confirmZip(actor, preview.id, preview.planSha256!),
  ])
  assert.equal(first.status, 'installed')
  assert.equal(first.skillId, second.skillId)
  assert.equal(first.resultType, 'duplicate')
  assert.equal(first.installedVersion, '0.1.0')
  const [version] = await database.client<{ status: string; manifest: { artifact: import('../../modules/skill/skill-package.ts').SkillPackageArtifact } }[]>`
    select status, manifest from skill_versions where skill_id = ${first.skillId!} and version = ${first.installedVersion!}
  `
  assert.equal(version?.status, 'published')
  assert.equal((await artifactStore.read(version!.manifest.artifact)).files.find(file => file.path === 'references/value.txt')?.content, 'SKILL_RESOURCE_MARKER_7F31')
})
test('one confirmed plan atomically installs, tests and publishes same-source Skill dependencies', { skip: real, timeout: 30000 }, async () => {
  const { sessionId, runId } = await send('npx skills@latest add fixture/delegated --skill=grill-me')
  const detail = await wait(sessionId)
  const installation = detail.installations[0]!
  assert.equal(installation.plan?.rootName, 'grill-me')
  assert.deepEqual(installation.plan?.packages.map(item => item.name), ['grill-me', 'grilling'])
  assert.deepEqual(installation.plan?.edges, [{ from: 'grill-me', to: 'grilling', type: 'skill' }])
  assert.equal(installation.compatibilityStatus, 'compatible')
  const [before] = await database.client<{ count: number }[]>`select count(*)::int as count from skills`
  const installed = await service.confirm(actor, runId, installation.planSha256!)
  const rootId = installed.installations[0]!.skillId!
  const [after] = await database.client<{ count: number }[]>`select count(*)::int as count from skills`
  assert.equal(after!.count, before!.count + 2)
  const [dependencyCount] = await database.client<{ count: number }[]>`select count(*)::int as count from skill_version_dependencies`
  assert.ok(dependencyCount!.count >= 1)
  const skills = new PostgresSkillService(database.client, undefined, undefined, artifactStore)
  skills.setPackageTester((userId, skill, prompt) => service.testPackage(userId, skill, prompt))
  assert.equal((await skills.testSkill({ skillId: rootId, actor })).status, 'passed')
  await skills.setStatus({ skillId: rootId, actor, status: 'published' })
  const resolved = await skills.resolveRuntimeSkills([`${rootId}@0.1.0`])
  assert.deepEqual(resolved.map(item => item.name).sort(), ['grill-me', 'grilling'])

  const updatedRequest = await send('npx skills@latest add fixture/delegated-updated --skill=grill-me')
  const updatedDetail = await wait(updatedRequest.sessionId)
  const updatedInstallation = updatedDetail.installations[0]!
  const updated = await service.confirm(actor, updatedRequest.runId, updatedInstallation.planSha256!)
  assert.equal(updated.installations[0]!.skillId, rootId)
  assert.equal(updated.installations[0]!.resultType, 'updated')
  const [lockedDependency] = await database.client<{ status: string }[]>`
    select sv.status from skill_versions root
    join skill_version_dependencies d on d.tenant_id = root.tenant_id and d.skill_version_id = root.id
    join skill_versions sv on sv.tenant_id = d.tenant_id and sv.id = d.dependency_skill_version_id
    where root.skill_id = ${rootId} and root.status = 'draft'`
  assert.equal(lockedDependency?.status, 'published')
  assert.equal((await skills.testSkill({ skillId: rootId, actor })).status, 'passed')
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
  await assert.rejects(service.confirm(actor, cancelled.runId, 'x'), /计划|取消/)
  const ready = await send()
  const detail = await wait(ready.sessionId)
  const digest = detail.installations[0]!.planSha256!
  await service.cancel(actor, ready.runId)
  await assert.rejects(service.confirm(actor, ready.runId, digest), /取消/)
  const permission = await send()
  const permitted = await wait(permission.sessionId)
  await database.client`update users set status = 'disabled' where id = ${actor}`
  await assert.rejects(service.confirm(actor, permission.runId, permitted.installations[0]!.planSha256!), /停用|权限/)
  await database.client`update users set status = 'active' where id = ${actor}`
})

test('real DSH reads the exact immutable Skill resource through the governed read tool', { skip: !real, timeout: 210000 }, async () => {
  const { parseSkillPackage } = await import('../../modules/skill/skill-package.ts')
  const pkg = parseSkillPackage(bytes)
  const result = await service.testPackage(actor, { id: 'skill-resource-probe', name: pkg.name, description: pkg.description, version: '0.1.0', instructions: pkg.instructions, tools: pkg.toolIds, files: pkg.files }, '请实际读取此 Skill 的 references/value.txt，逐字返回文件值；不要猜测。')
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
  let permissions = ['admin:read']
  const router = new Router({ authenticateApi: async (request, audience) => ({ ...(await prototypeApiAuthenticator(request, audience)), userId, permissions }) })
  registerAssistantRoutes(router, service)
  registerSkillInstallationRoutes(router, service)
  const server = createServer((request, response) => { void router.handle(request, response) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}/api/admin/v1/assistant`
  try {
    assert.equal((await fetch(`${base}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/admin/v1/skill-installations`, { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-File-Name': 'test.zip' }, body: bytes })).status, 403)
    assert.equal((await fetch(`${base}/sessions/${saved.sessionId}`)).status, 200)
    userId = 'U00001'
    assert.equal((await fetch(`${base}/sessions/${saved.sessionId}`)).status, 403)
    const history = await fetch(`${base}/sessions`).then(response => response.json()) as { data: unknown[] }
    assert.deepEqual(history.data, [])
    userId = actor
    permissions = ['admin:write']
    const uploaded = await fetch(`http://127.0.0.1:${address.port}/api/admin/v1/skill-installations`, { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-File-Name': encodeURIComponent('接口安装.zip') }, body: bytes })
    assert.equal(uploaded.status, 201)
    const prepared = await uploaded.json() as { data: { id: string; planSha256: string; package: { name: string }; status: string } }
    assert.equal(prepared.data.package.name, 'installation-test')
    assert.equal(prepared.data.status, 'pending')
    const confirmed = await fetch(`http://127.0.0.1:${address.port}/api/admin/v1/skill-installations/${prepared.data.id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planSha256: prepared.data.planSha256 }) })
    assert.equal(confirmed.status, 200)
    assert.equal(((await confirmed.json()) as { data: { status: string } }).data.status, 'installed')
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

test('legacy packaged versions migrate to folders without weakening published-version immutability', { skip: real }, async () => {
  const legacy = parseSkillPackage(bytes)
  const skillId = `skill-${randomUUID().slice(0, 12)}`
  const versionId = `skill-version-${randomUUID()}`
  const sessionId = `admin-session-${randomUUID()}`
  const runId = `run-${randomUUID()}`
  const attemptId = `attempt-${randomUUID()}`
  const oldManifest: RuntimeManifest = {
    manifest_version: '1.0', run_id: runId, attempt_id: attemptId, session_id: sessionId, workspace_id: '', agent_version_id: null,
    agent_configuration: { system_prompt: '这是旧版 Skill 文件内联迁移测试，只验证存储迁移行为。', skill_instructions: [{ id: skillId, name: legacy.name, description: legacy.description, version: '0.1.0', instructions: legacy.instructions, files: legacy.files }] },
    user_context: { user_id: actor, tenant_id: tenant, role_ids: [] }, permission_policy: { approval_mode: 'always', network_policy: 'deny', write_policy: 'deny' },
    skills: [{ id: skillId, version: '0.1.0' }], tools: [{ id: 'read', version: '1.0.0' }], data_scopes: [], knowledge_context: [],
    input: { message: '迁移测试', file_mounts: [] }, limits: { timeout_seconds: 30, max_output_bytes: 65536, max_tool_calls: 3 }, created_at: new Date().toISOString(),
  }
  const oldCompiled = compileRuntimeManifest(oldManifest)
  await database.client.begin(async transaction => {
    await transaction`insert into skills (id, tenant_id, key, name, category, description, owner_user_id, created_by, status)
      values (${skillId}, ${tenant}, ${skillId}, ${legacy.name}, '迁移测试', ${legacy.description}, ${actor}, ${actor}, 'published')`
    await transaction`insert into skill_versions (id, tenant_id, skill_id, version, name, category, description, instructions, manifest, tool_refs, test_prompt, status, created_by, published_by, published_at, change_summary)
      values (${versionId}, ${tenant}, ${skillId}, '0.1.0', ${legacy.name}, '迁移测试', ${legacy.description}, ${legacy.instructions}, ${transaction.json(JSON.parse(JSON.stringify({ package: legacy })))}, ${transaction.json(legacy.toolIds)}, '迁移测试', 'published', ${actor}, ${actor}, now(), '旧存储格式')`
    await transaction`update skills set active_version_id = ${versionId} where id = ${skillId}`
    await transaction`insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id) values (${sessionId}, ${tenant}, ${actor}, '旧 Attempt', 'active', 'admin', null, null)`
    await transaction`insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status) values (${runId}, ${tenant}, ${sessionId}, ${actor}, ${randomUUID()}, 'succeeded')`
    await transaction`insert into run_attempts (id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256, model_route_snapshot, status) values (${attemptId}, ${tenant}, ${runId}, 1, 'runtime-local-01', ${transaction.json(JSON.parse(oldCompiled.canonicalJson))}, ${oldCompiled.sha256}, '{}', 'succeeded')`
    await transaction`update runs set current_attempt_id = ${attemptId} where id = ${runId}`
  })
  await migrateSkillFilesToFileSystem(database.client, artifactStore)
  const [migrated] = await database.client<{ instructions: string; artifactRef: string; manifest: { artifact: import('../../modules/skill/skill-package.ts').SkillPackageArtifact } }[]>`
    select instructions, artifact_ref as "artifactRef", manifest from skill_versions where id = ${versionId}
  `
  assert.equal(migrated?.instructions, '')
  assert.equal(JSON.stringify(migrated?.manifest).includes('SKILL_RESOURCE_MARKER_7F31'), false)
  assert.equal((await artifactStore.read(migrated!.manifest.artifact)).files[1]?.content, 'SKILL_RESOURCE_MARKER_7F31')
  const [migratedAttempt] = await database.client<{ manifest: RuntimeManifest; manifestSha256: string; legacyManifestSha256: string }[]>`select manifest, manifest_sha256 as "manifestSha256", legacy_manifest_sha256 as "legacyManifestSha256" from run_attempts where id = ${attemptId}`
  assert.equal(JSON.stringify(migratedAttempt?.manifest).includes('SKILL_RESOURCE_MARKER_7F31'), false)
  assert.equal(migratedAttempt?.legacyManifestSha256, oldCompiled.sha256)
  assert.equal(migratedAttempt?.manifestSha256, compileRuntimeManifest(migratedAttempt!.manifest).sha256)
  await assert.rejects(database.client`update skill_versions set description = '不能修改' where id = ${versionId}`, /immutable/)
})
