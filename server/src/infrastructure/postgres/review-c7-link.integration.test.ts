import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { AdminSkillInstallationService } from '../../modules/skill/admin-skill-installation-service.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { FileSystemSkillArtifactStore } from '../../modules/skill/file-system-skill-artifact-store.ts'
import type { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { UnavailableRuntime, ExecutionCapabilityUnavailableError } from '../../modules/runtime/execution-capabilities.ts'
import type { SkillSource } from '../../modules/skill/skill-source.ts'
import { Router } from '../../http/router.ts'
import { prototypeApiAuthenticator } from '../../modules/identity/prototype-authenticator.ts'
import { registerSkillInstallationRoutes } from '../../http/admin/skill-installation-routes.ts'

const tenant = 'tenant-dsh-work', actor = 'U00008'
let db: ThrowawayDatabase, store: FileSystemSkillArtifactStore, root: string
let tools: PostgresToolConnectorService, auth: PostgresAuthorizationService
const fixtures = new Map<string, Uint8Array>()
let acquireCount = 0, dshAvailable = false, pythonAvailable = false
const checkRuntime = async (references: string[]) => {
  if (!dshAvailable) throw new ExecutionCapabilityUnavailableError('dsh')
  if (references.includes('python_execute@1.0.0') && !pythonAvailable) throw new ExecutionCapabilityUnavailableError('python')
}
const orchestration = new Proxy({}, { get: () => { throw new Error('C7 must not construct an Agent run') } }) as RunOrchestrationService
const acquire = async (source: SkillSource, signal: AbortSignal) => {
  signal.throwIfAborted(); acquireCount++
  const bytes = fixtures.get(source.url)
  if (!bytes) throw new Error('synthetic link fixture missing')
  return { bytes, resolvedUrl: source.url, resolvedRef: 'a'.repeat(40) }
}
function service(download = acquire) {
  return new AdminSkillInstallationService(db.client, orchestration, auth, tools, download, false, [], store, checkRuntime)
}
function source(files: Record<string, string> = {}, instruction = 'Return a deterministic text answer from the provided input.') {
  const name = `link-${randomUUID().slice(0, 8)}`, url = `https://github.com/fixture/${name}`
  fixtures.set(`${url}`, zipSync({ 'SKILL.md': strToU8(`---\nname: ${name}\ndescription: Synthetic deterministic link import fixture.\n---\n${instruction}\n`), ...Object.fromEntries(Object.entries(files).map(([p, s]) => [p, strToU8(s)])) }))
  return { url }
}
before(async () => {
  db = await createThrowawayDatabase({ namePrefix: 'dsh_review_c7' })
  root = await mkdtemp(join(tmpdir(), 'dsh-review-c7-'))
  store = new FileSystemSkillArtifactStore(join(root, 'skills'))
  auth = new PostgresAuthorizationService(db.client)
  tools = new PostgresToolConnectorService(db.client, new UnavailableRuntime('runtime-local-01'))
})
after(async () => { await db?.dispose(); if (root) await rm(root, { recursive: true, force: true }) })

test('C7 RED: unavailable DSH can prepare and confirm a deterministic link draft without a Run', async () => {
  const svc = service(), before = await db.client`select id from runs`
  const beforeSessions = await db.client`select id from sessions`
  const plan = await svc.prepareLink(actor, source())
  assert.equal(plan.channel, 'link'); assert.equal(plan.runId, null)
  assert.equal(plan.canSaveDraft, true); assert.equal(plan.canPublish, false)
  assert.ok(plan.publicationBlockers?.some(b => b.code === 'RUNTIME_UNAVAILABLE'))
  const downloads = acquireCount
  const installed = await svc.confirmDirect(actor, plan.id, plan.planSha256!)
  assert.equal(installed.status, 'installed'); assert.equal(installed.canPublish, false)
  assert.equal(acquireCount, downloads, 'confirmation must use fixed bytes, never download again')
  const [row] = await db.client`select s.status, s.active_version_id, sv.status as version_status, sv.manifest->>'installationChannel' as channel from skills s join skill_versions sv on sv.id = s.draft_version_id where s.id = ${installed.skillId!}`
  assert.equal(row!.status, 'draft'); assert.equal(row!.active_version_id, null)
  assert.equal(row!.version_status, 'draft'); assert.equal(row!.channel, 'link')
  assert.equal((await db.client`select id from runs`).length, before.length)
  assert.equal((await db.client`select id from sessions`).length, beforeSessions.length)
  await svc.confirmDirect(actor, plan.id, plan.planSha256!)
  const [versions] = await db.client`select count(*)::int as n from skill_versions where skill_id = ${installed.skillId!}`
  assert.equal(versions!.n, 1)
})

test('C7 RED: missing Python capability defers execution, but never pretends the dependency is resolved', async () => {
  const svc = service(), plan = await svc.prepareLink(actor, source({ 'scripts/check.py': 'print("ok")\n' }))
  assert.equal(plan.canSaveDraft, true)
  assert.equal(plan.compatibilityStatus, 'needs_review')
  assert.ok(plan.plan!.packages.some(p => p.requirements.some(r => r.type === 'python' && r.status === 'needs_review')))
  assert.equal((await svc.confirmDirect(actor, plan.id, plan.planSha256!)).canPublish, false)
})

test('C7 RED: HTTP link endpoint returns an authenticated deterministic installation, not an assistant run', async () => {
  const router = new Router({ authenticateApi: prototypeApiAuthenticator })
  registerSkillInstallationRoutes(router, service())
  const server = createServer((request, response) => void router.handle(request, response))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}/api/admin/v1/skill-installations`
    const response = await fetch(`${base}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(source()) })
    assert.equal(response.status, 201)
    const { data } = await response.json() as { data: { id: string; planSha256: string; channel: string } }
    assert.equal(data.channel, 'link')
    const confirmed = await fetch(`${base}/${data.id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planSha256: data.planSha256 }) })
    assert.equal(confirmed.status, 200)
    assert.equal((await fetch(`${base}/${data.id}`)).status, 200)
  } finally { server.close(); await once(server, 'close') }
})

test('illegal sources and non-admin identities never trigger acquisition or save an installation', async () => {
  const svc = service(), count = acquireCount
  for (const url of ['https://127.0.0.1/skill.zip', 'https://unapproved.example/skill.zip', 'curl https://github.com/fixture/repo', 'https://user:secret@github.com/fixture/repo']) {
    await assert.rejects(svc.prepareLink(actor, { url }), { code: 'skill_source_invalid' })
  }
  await assert.rejects(svc.prepareLink('U00001', source()), { status: 403 })
  assert.equal(acquireCount, count)
})

test('cancelled or revoked in-flight acquisitions cannot save plans; service rechecks identity inside the write transaction', async () => {
  const link = source(), controller = new AbortController()
  const svc = service(async (s, signal) => { const result = await acquire(s, signal); controller.abort(); return result })
  const [before] = await db.client`select count(*)::int as n from skill_installations`
  await assert.rejects(svc.prepareLink(actor, link, controller.signal))
  const revoked = service(async (s, signal) => { const result = await acquire(s, signal); await db.client`update users set status = 'disabled' where id = ${actor}`; return result })
  try { await assert.rejects(revoked.prepareLink(actor, link), { status: 403 }) }
  finally { await db.client`update users set status = 'active' where id = ${actor}` }
  const [after] = await db.client`select count(*)::int as n from skill_installations`
  assert.equal(after!.n, before!.n)
})

test('preview cancellation, digest validation, ownership and concurrent confirmation are enforced server-side', async () => {
  const svc = service(), first = await svc.prepareLink(actor, source())
  await assert.rejects(svc.confirmDirect(actor, first.id, 'f'.repeat(64)), /计划/)
  await assert.rejects(svc.getDirectInstallation('U00001', first.id), { status: 403 })
  await assert.rejects(svc.confirmZip(actor, first.id, first.planSha256!), { status: 403 }, 'ZIP-only service wrapper cannot consume link records')
  await svc.cancelDirect(actor, first.id)
  await assert.rejects(svc.confirmDirect(actor, first.id, first.planSha256!), /取消/)
  const second = await svc.prepareLink(actor, source())
  const [a, b] = await Promise.all([svc.confirmDirect(actor, second.id, second.planSha256!), svc.confirmDirect(actor, second.id, second.planSha256!)])
  assert.equal(a.skillId, b.skillId)
  const [versions] = await db.client`select count(*)::int as n from skill_versions where skill_id = ${a.skillId!}`
  assert.equal(versions!.n, 1)
  await assert.rejects(svc.cancelDirect(actor, second.id), { status: 409 })
})

test('structural incompatibilities cannot be installed even while runtime requirements are deferred', async () => {
  const svc = service(), link = source({}, 'Call the Skill tool with "missing-child" and follow its instructions.')
  const plan = await svc.prepareLink(actor, link)
  assert.equal(plan.canSaveDraft, false); assert.equal(plan.compatibilityStatus, 'incompatible')
  await assert.rejects(svc.confirmDirect(actor, plan.id, plan.planSha256!), /不兼容/)
  const unsafe = source({ 'scripts/install.sh': 'echo unsafe' })
  await assert.rejects(svc.prepareLink(actor, unsafe), /Skill 包校验/)
})

test('unhealthy registered connectors allow draft storage but cannot satisfy execution/publication readiness', async () => {
  const svc = service(), link = source({ 'references/data.txt': 'marker' }, 'Use the read tool to read references/data.txt and report exactly the value.')
  const [connector] = await db.client`select connector_id from tools where id = 'read' and tenant_id = ${tenant}`
  assert.ok(connector)
  await db.client`update connectors set status = 'offline' where id = ${connector.connector_id}`
  try {
    const plan = await svc.prepareLink(actor, link)
    assert.equal(plan.canSaveDraft, true)
    assert.ok(plan.publicationBlockers?.some(b => b.code === 'TOOLS_UNAVAILABLE'))
    assert.equal((await svc.confirmDirect(actor, plan.id, plan.planSha256!)).status, 'installed')
    await assert.rejects(tools.assertAvailableReferences(['read@1.0.0']))
  } finally { await db.client`update connectors set status = 'healthy' where id = ${connector.connector_id}` }
})

test('link drafts cannot publish while Runtime is unavailable even if prior valid evidence exists; duplicate import preserves active versions', async () => {
  const svc = service(), input = source(), plan = await svc.prepareLink(actor, input)
  const installed = await svc.confirmDirect(actor, plan.id, plan.planSha256!), skillId = installed.skillId!
  const skills = new PostgresSkillService(db.client, undefined, tools, store)
  skills.setPublicationAvailabilityChecker(checkRuntime)
  // Explicit SYNTHETIC evidence for domain persistence and publication checks, not a real DSH invocation.
  const { PostgresRunRepository } = await import('../../modules/run/postgres-run-repository.ts')
  const runs = new PostgresRunRepository(db.client)
  skills.setPackageTestLifecycle({
    start: async (_user, skill, prompt) => {
      const sessionId = `admin-session-${randomUUID()}`, runId = `run-${randomUUID()}`, attemptId = `attempt-${randomUUID()}`
      await db.client`insert into sessions(id,tenant_id,created_by,title,status,audience,workspace_id,agent_version_id) values (${sessionId},${tenant},${actor},'C7 synthetic trial','active','admin',null,null)`
      await db.client`insert into runs(id,tenant_id,session_id,requested_by,idempotency_key,status) values (${runId},${tenant},${sessionId},${actor},${randomUUID()},'queued')`
      const manifest = { purpose: 'admin-skill-test', run_id: runId, session_id: sessionId, attempt_id: attemptId,
        skills: [{ id: skill.id, version: skill.version }], input: { message: prompt, file_mounts: [] },
        agent_configuration: { system_prompt: 'Synthetic validation only', skill_instructions: [skill] } }
      await db.client`insert into run_attempts(id,tenant_id,run_id,attempt_no,manifest,manifest_sha256,model_route_snapshot,status) values (${attemptId},${tenant},${runId},1,${db.client.json(JSON.parse(JSON.stringify(manifest)))},${'a'.repeat(64)},'{}','succeeded')`
      await db.client`update runs set current_attempt_id = ${attemptId},status = 'succeeded' where id = ${runId}`
      await db.client`insert into skill_runtime_activations(id,tenant_id,run_id,attempt_id,skill_id,skill_version,content_sha256) values (${randomUUID()},${tenant},${runId},${attemptId},${skill.id},${skill.version},${skill.artifact!.sha256})`
      await runs.appendEvent({ id: randomUUID(),tenantId: tenant,runId,attemptId,sequence: 1,eventType: 'assistant.completed',displayMessage: 'Synthetic passed answer',safeMetadata: { synthetic: true },traceId: `trace-${runId}`,occurredAt: new Date().toISOString() })
      return svc.packageTestProgress(actor,skill,runId)
    },
    progress: (user, skill, runId) => svc.packageTestProgress(user, skill, runId),
  })
  try {
    dshAvailable = true
    await assert.rejects(skills.setStatus({ skillId, actor, status: 'published' }), /测试|覆盖/)
    assert.equal((await skills.startSkillTest({ skillId, actor })).status, 'passed')
    dshAvailable = false
    await assert.rejects(skills.setStatus({ skillId, actor, status: 'published' }), { code: 'RUNTIME_UNAVAILABLE' })
    const unknown = new PostgresSkillService(db.client, undefined, tools, store)
    await assert.rejects(unknown.setStatus({ skillId, actor, status: 'published' }), { code: 'RUNTIME_UNAVAILABLE' })
    dshAvailable = true
    await skills.setStatus({ skillId, actor, status: 'published' })
    const duplicate = await svc.prepareLink(actor, input)
    const reused = await svc.confirmDirect(actor, duplicate.id, duplicate.planSha256!)
    assert.equal(reused.resultType, 'duplicate')
    const [row] = await db.client`select status, draft_version_id from skills where id = ${skillId}`
    assert.equal(row!.status, 'published'); assert.equal(row!.draft_version_id, null)
    const changed = fixtures.get(input.url)!
    fixtures.set(input.url, zipSync({ 'SKILL.md': strToU8(`---\nname: ${installed.package!.name}\ndescription: Synthetic deterministic link import fixture.\n---\nChanged instructions for a new immutable version, not a live overwrite.\n`) }))
    const update = await svc.prepareLink(actor, input)
    const updated = await svc.confirmDirect(actor, update.id, update.planSha256!)
    assert.equal(updated.resultType, 'updated'); assert.equal(updated.installedVersion, '0.2.0')
    const [active] = await db.client`select sv.version from skills s join skill_versions sv on sv.id = s.active_version_id where s.id = ${skillId}`
    assert.equal(active!.version, '0.1.0')
    fixtures.set(input.url, changed)
  } finally { dshAvailable = false; pythonAvailable = false }
})

test('publication closure checks link-origin dependencies even when the root came from ZIP (synthetic graph)', async () => {
  const svc = service(), childPlan = await svc.prepareLink(actor, source())
  const child = await svc.confirmDirect(actor, childPlan.id, childPlan.planSha256!)
  const input = source()
  const zip = await svc.prepareZip(actor, { fileName: 'parent.zip', bytes: fixtures.get(input.url)! })
  const parent = await svc.confirmZip(actor, zip.id, zip.planSha256!)
  // Isolated domain graph fixture: no real Agent or unpublished production content.
  await db.client`insert into skill_version_dependencies (tenant_id, skill_version_id, dependency_skill_version_id, dependency_type, evidence)
    select ${tenant}, p.draft_version_id, c.draft_version_id, 'skill', 'synthetic closure test' from skills p, skills c
    where p.id = ${parent.skillId!} and c.id = ${child.skillId!}`
  const skills = new PostgresSkillService(db.client, undefined, tools, store)
  skills.setPublicationAvailabilityChecker(checkRuntime)
  await assert.rejects(skills.setStatus({ skillId: parent.skillId!, actor, status: 'published' }), { code: 'RUNTIME_UNAVAILABLE' })
})

test('confirmed source metadata cannot be forged through HTTP and read-only callers cannot acquire or confirm', async () => {
  const router = new Router({ authenticateApi: async (request, audience) => {
    const identity = await prototypeApiAuthenticator(request, audience)
    return request.headers['x-test-reader'] ? { ...identity, userId: 'U00001', permissions: ['admin:read'] } : identity
  } })
  registerSkillInstallationRoutes(router, service())
  const server = createServer((request, response) => void router.handle(request, response))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/admin/v1/skill-installations`
    const post = (path: string, body: unknown, reader = false) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(reader ? { 'x-test-reader': 'true' } : {}) }, body: JSON.stringify(body) })
    const input = source(), count = acquireCount
    assert.equal((await post('/link', { ...input, channel: 'assistant' })).status, 422)
    assert.equal((await post('/link', input, true)).status, 403)
    assert.equal(acquireCount, count)
    const response = await post('/link', input), { data } = await response.json() as { data: { id: string; planSha256: string } }
    assert.equal((await post(`/${data.id}/confirm`, { planSha256: data.planSha256 }, true)).status, 403)
    assert.equal((await post(`/${data.id}/confirm`, { planSha256: 'f'.repeat(64) })).status, 409)
    assert.equal((await fetch(`${base}/${data.id}`, { headers: { 'x-test-reader': 'true' } })).status, 403)
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close') }
})

test('write permission and tool policy are rechecked after preview; an installed plan cannot be changed into a Run', async () => {
  const svc = service(), plan = await svc.prepareLink(actor, source())
  await db.client`update users set status = 'disabled' where id = ${actor}`
  try { await assert.rejects(svc.confirmDirect(actor, plan.id, plan.planSha256!), { status: 403 }) }
  finally { await db.client`update users set status = 'active' where id = ${actor}` }
  const [pending] = await db.client`select status from skill_installations where id = ${plan.id}`
  assert.equal(pending!.status, 'pending')
  await assert.rejects(db.client`update skill_installations set channel = 'assistant' where id = ${plan.id}`, /check constraint/)
  const readPlan = await svc.prepareLink(actor, source({ 'references/data.txt': 'example' }, 'Use read to read references/data.txt exactly.'))
  await db.client`update tools set status = 'disabled' where id = 'read'`
  try { await assert.rejects(svc.confirmDirect(actor, readPlan.id, readPlan.planSha256!), /工具/) }
  finally { await db.client`update tools set status = 'available' where id = 'read'` }
})

test('a duplicate link import cannot evade the publication gate by reusing an older ZIP draft without a link manifest flag', async () => {
  const svc = service(), input = source()
  const zipPlan = await svc.prepareZip(actor, { fileName: 'existing-draft.zip', bytes: fixtures.get(input.url)! })
  const zip = await svc.confirmZip(actor, zipPlan.id, zipPlan.planSha256!)
  const linkPlan = await svc.prepareLink(actor, input)
  const reused = await svc.confirmDirect(actor, linkPlan.id, linkPlan.planSha256!)
  assert.equal(reused.resultType, 'duplicate'); assert.equal(reused.skillId, zip.skillId)
  const [version] = await db.client`select manifest from skill_versions where skill_id = ${zip.skillId!}`
  assert.equal(version!.manifest.installationChannel, undefined, 'do not mutate prior version metadata')
  const skills = new PostgresSkillService(db.client, undefined, tools, store)
  skills.setPublicationAvailabilityChecker(checkRuntime)
  await assert.rejects(skills.setStatus({ skillId: reused.skillId!, actor, status: 'published' }), { code: 'RUNTIME_UNAVAILABLE' })
})

test('publication verifies declared Python packages through the current capability checker, not the old install-time label', async () => {
  const svc = service(), plan = await svc.prepareLink(actor, source({ 'scripts/check.py': 'print("ok")', 'requirements.txt': 'missing-fixture-package==1.0.0\n' }))
  const installed = await svc.confirmDirect(actor, plan.id, plan.planSha256!)
  const skills = new PostgresSkillService(db.client, undefined, tools, store)
  skills.setPublicationAvailabilityChecker(async (references, requiredPackages) => {
    assert.ok(references.includes('python_execute@1.0.0'))
    assert.deepEqual(requiredPackages, ['missing-fixture-package'])
    throw Object.assign(new Error('synthetic missing Python package'), { status: 503, code: 'SKILL_DEPENDENCIES_UNAVAILABLE' })
  })
  await assert.rejects(skills.setStatus({ skillId: installed.skillId!, actor, status: 'published' }), { code: 'SKILL_DEPENDENCIES_UNAVAILABLE' })
})
