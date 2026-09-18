import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Router } from '../../http/router.ts'
import { registerSkillRoutes } from '../../http/admin/skill-routes.ts'
import { prototypeApiAuthenticator } from '../../modules/identity/prototype-authenticator.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { AdminSkillInstallationService } from '../../modules/skill/admin-skill-installation-service.ts'
import { PostgresSkillService, type RuntimeSkillConfiguration } from '../../modules/skill/postgres-skill-service.ts'
import { FileSystemSkillArtifactStore } from '../../modules/skill/file-system-skill-artifact-store.ts'
import { parseSkillPackage } from '../../modules/skill/skill-package.ts'
import type { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import type { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import type { SkillTestScenario } from '../../domain/skill-test-scenario.ts'

const tenant = 'tenant-dsh-work', actor = 'U00008'
let db: ThrowawayDatabase, store: FileSystemSkillArtifactStore, directory: string
let service: AdminSkillInstallationService, runs: PostgresRunRepository
before(async () => {
  db = await createThrowawayDatabase({ namePrefix: 'dsh_work_review_8b', maxConnections: 5 })
  directory = await mkdtemp(join(tmpdir(), 'dsh-work-review-8b-'))
  store = new FileSystemSkillArtifactStore(directory)
  runs = new PostgresRunRepository(db.client)
  service = new AdminSkillInstallationService(db.client, {} as RunOrchestrationService,
    new PostgresAuthorizationService(db.client), {} as PostgresToolConnectorService)
})
after(async () => { await db?.dispose(); if (directory) await rm(directory, { recursive: true, force: true }) })

async function seedSkill(name: string, python = false, dependencies: string[] = []) {
  const id = `skill-${name}`, versionId = `sv-${randomUUID()}`
  const files = { 'SKILL.md': strToU8(`---\nname: ${name}\ndescription: A synthetic scenario fixture with no external business data.\n---\nReturn the deterministic fixture total and never access external services.\n`),
    ...(python ? { 'scripts/calc.py': strToU8('print(12)\n'), 'scripts/other.py': strToU8('print(99)\n') } : {}) }
  const artifact = await store.put(parseSkillPackage(zipSync(files)))
  await db.client`insert into skills (id, tenant_id, key, name, owner_user_id, created_by, status)
    values (${id}, ${tenant}, ${id}, ${name}, ${actor}, ${actor}, 'draft')`
  await db.client`insert into skill_versions (id, tenant_id, skill_id, version, name, category, description,
    instructions, manifest, artifact_ref, package_sha256, tool_refs, test_prompt, status, created_by)
    values (${versionId}, ${tenant}, ${id}, '0.1.0', ${name}, '测试', ${artifact.description}, '',
    ${db.client.json(JSON.parse(JSON.stringify({ artifact, dependencies, installationId: 'synthetic-fixture' })))},
    ${artifact.artifactRef}, ${artifact.sha256}, ${db.client.json(artifact.toolIds)}, '计算固定样例', 'draft', ${actor})`
  await db.client`update skills set draft_version_id = ${versionId} where id = ${id}`
  for (const reference of dependencies) {
    const depId = reference.slice(0, reference.lastIndexOf('@'))
    await db.client`insert into skill_version_dependencies (tenant_id, skill_version_id, dependency_skill_version_id, dependency_type, evidence)
      select ${tenant}, ${versionId}, id, 'skill', 'synthetic fixture' from skill_versions
      where tenant_id = ${tenant} and skill_id = ${depId}`
  }
  return { id, versionId, reference: `${id}@0.1.0` }
}

async function fixture() {
  const name = randomUUID().slice(0, 8)
  const child = await seedSkill(`calc-${name}`, true)
  const root = await seedSkill(`root-${name}`, false, [child.reference])
  // The callback below creates explicit SYNTHETIC evidence to test persistence and
  // publication. It never claims to run a real DSH model or Python container.
  const skills = new PostgresSkillService(db.client, undefined, undefined, store)
  let reply = '{"total":12}', wrongEntry = false
  skills.setPackageTestLifecycle({
    start: async (_user, skill, prompt) => seedTrial(skill, prompt, reply, wrongEntry),
    progress: (user, skill, runId) => service.packageTestProgress(user, skill, runId),
  })
  const scenario = (id: string, withPython = false): SkillTestScenario => ({ id,
    requiredSkills: [root.reference],
    requiredPythonEntries: withPython ? [{ skill: child.reference, entry: 'scripts/calc.py' }] : [],
    assertions: [{ kind: 'reply_json_equals', path: ['total'], expected: 12 }],
  })
  return { root, child, skills, scenario,
    reply: (value: string) => { reply = value }, wrongEntry: () => { wrongEntry = true },
    trial: (id: string, withPython = false) => skills.startSkillTest({ skillId: root.id, actor, scenario: scenario(id, withPython) }),
    publish: () => skills.setStatus({ skillId: root.id, actor, status: 'published' }),
  }
}

async function seedTrial(skill: RuntimeSkillConfiguration, prompt: string, reply: string, wrongEntry: boolean) {
  const sessionId = `admin-session-${randomUUID()}`, runId = `run-${randomUUID()}`, attemptId = `attempt-${randomUUID()}`
  const catalog = [skill, ...(skill.dependencySkills ?? [])]
  const scenario = skill.testScenario!
  await db.client`insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
    values (${sessionId}, ${tenant}, ${actor}, 'Synthetic scenario trial', 'active', 'admin', null, null)`
  await db.client`insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
    values (${runId}, ${tenant}, ${sessionId}, ${actor}, ${randomUUID()}, 'queued')`
  const manifest = { purpose: 'admin-skill-test', run_id: runId, session_id: sessionId, attempt_id: attemptId,
    skills: catalog.map(item => ({ id: item.id, version: item.version })), test_scenario: scenario,
    input: { message: prompt, file_mounts: [] },
    agent_configuration: { system_prompt: 'Synthetic persisted evidence; not a model run', skill_instructions: catalog } }
  await db.client`insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status)
    values (${attemptId}, ${tenant}, ${runId}, 1, ${db.client.json(JSON.parse(JSON.stringify(manifest)))}, ${'a'.repeat(64)}, '{}'::jsonb, 'succeeded')`
  await db.client`update runs set current_attempt_id = ${attemptId}, status = 'succeeded' where id = ${runId}`
  for (const entry of catalog.filter(item => scenario.requiredSkills.includes(`${item.id}@${item.version}`))) {
    await db.client`insert into skill_runtime_activations (id, tenant_id, run_id, attempt_id, skill_id, skill_version, content_sha256)
      values (${randomUUID()}, ${tenant}, ${runId}, ${attemptId}, ${entry.id}, ${entry.version}, ${'a'.repeat(64)})`
  }
  for (const entry of scenario.requiredPythonEntries) {
    await db.client`insert into skill_python_executions (id, tenant_id, run_id, attempt_id, skill_id, entry_path, succeeded)
      values (${randomUUID()}, ${tenant}, ${runId}, ${attemptId}, ${entry.skill.slice(0, entry.skill.lastIndexOf('@'))},
        ${wrongEntry ? 'scripts/other.py' : entry.entry}, true)`
  }
  await runs.appendEvent({ id: randomUUID(), tenantId: tenant, runId, attemptId, sequence: 1,
    eventType: 'assistant.completed', displayMessage: reply, safeMetadata: { synthetic: true },
    traceId: `trace-${runId}`, occurredAt: new Date().toISOString() })
  return service.packageTestProgress(actor, skill, runId)
}

test('scenario-specific success cannot publish untested dependencies; complementary coverage can', async () => {
  const item = await fixture()
  const first = await item.trial('text')
  assert.equal(first.status, 'passed')
  assert.equal(first.steps.some(step => step.id.startsWith('python:')), false)
  await assert.rejects(item.publish(), /覆盖不完整/)
  const second = await item.trial('numbers', true)
  assert.equal(second.status, 'passed')
  const records = await db.client<{ policy: string; attempt: string }[]>`select evidence_policy as policy, runtime_attempt_id as attempt
    from skill_test_runs where skill_id = ${item.root.id}`
  assert.ok(records.every(row => row.policy === 'scenario-v1' && row.attempt))
  await item.publish()
  const [child] = await db.client<{ status: string }[]>`select status from skill_versions where id = ${item.child.versionId}`
  assert.equal(child?.status, 'published')
})
test('nonempty but incorrect results block publication despite complete execution evidence', async () => {
  const item = await fixture()
  item.reply('{"total":13}')
  assert.equal((await item.trial('numbers', true)).status, 'failed')
  await assert.rejects(item.publish(), /覆盖不完整/)
})
test('the latest failed evaluation of a scenario cannot borrow an earlier pass', async () => {
  const item = await fixture()
  assert.equal((await item.trial('numbers', true)).status, 'passed')
  item.reply('{"total":0}')
  assert.equal((await item.trial('numbers', true)).status, 'failed')
  await assert.rejects(item.publish(), /覆盖不完整/)
})
test('evidence from a changed dependency graph cannot authorize publishing current drafts', async () => {
  const item = await fixture()
  assert.equal((await item.trial('numbers', true)).status, 'passed')
  await db.client`update skill_versions set tool_refs = '["different@1.0.0"]'::jsonb where id = ${item.child.versionId}`
  await assert.rejects(item.publish(), /覆盖不完整|配置.*变化/)
})
test('executing another declared Python script does not satisfy the selected entry', async () => {
  const item = await fixture()
  item.wrongEntry()
  const result = await item.trial('numbers', true)
  assert.equal(result.status, 'failed')
  assert.ok(result.steps.filter(step => step.id.startsWith('python:')).every(step => step.status === 'failed'))
  await assert.rejects(item.publish(), /覆盖不完整/)
})
test('scenario evidence cannot be written without a concrete Run and Attempt', async () => {
  const item = await fixture()
  await assert.rejects(db.client`insert into skill_test_runs (id, tenant_id, skill_id, skill_version_id,
    configuration_fingerprint, test_prompt, status, result_summary, tested_by, evidence_policy)
    values (${randomUUID()}, ${tenant}, ${item.root.id}, ${item.root.versionId}, 'f', 'fixture', 'passed', 'not evidence', ${actor}, 'scenario-v1')`, /check constraint/)
})

// Real HTTP/SQL and authorization plumbing, with explicit synthetic identity and trial evidence.
test('admin trial API forwards immutable scenarios and rejects malformed or unauthorized input', async () => {
  const item = await fixture()
  const router = new Router({ authenticateApi: async (request, audience) => {
    const identity = await prototypeApiAuthenticator(request, audience)
    return request.headers['x-test-employee'] === 'true' ? { ...identity, userId: 'U00001', permissions: [] } : identity
  } })
  registerSkillRoutes(router, item.skills)
  const server = createServer((request, response) => { void router.handle(request, response) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/api/admin/v1/skills/test-runs`
  try {
    const request = (scenario: unknown, token = 'admin') => fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-employee': String(token === 'employee') },
      body: JSON.stringify({ skillId: item.root.id, scenario }),
    })
    const result = await request(item.scenario('api'))
    assert.equal(result.status, 202, await result.clone().text())
    const body = await result.json() as { data: { runId: string; status: string } }
    assert.equal(body.data.status, 'passed')
    const [attempt] = await db.client<{ scenario: SkillTestScenario }[]>`select manifest->'test_scenario' as scenario
      from run_attempts where run_id = ${body.data.runId}`
    assert.equal(attempt?.scenario.id, 'api')
    assert.equal((await request({ ...item.scenario('bad'), evaluator: 'forbidden' })).status, 422)
    assert.equal((await request(item.scenario('employee'), 'employee')).status, 403)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
