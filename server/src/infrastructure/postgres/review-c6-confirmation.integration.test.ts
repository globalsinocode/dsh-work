import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { after, before, test } from 'node:test'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { publishDraftWithSealedTrial } from './test-release-fixture.ts'
import { AdminAssistantService } from '../../modules/admin/application/admin-assistant-service.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { AdminSkillInstallationService } from '../../modules/skill/admin-skill-installation-service.ts'
import type { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import type { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import type { RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import { UnavailableRuntime } from '../../modules/runtime/execution-capabilities.ts'
import { canonicalJson, sha256 } from '../../modules/runtime/canonical-json.ts'
import { prototypeApiAuthenticator } from '../../modules/identity/prototype-authenticator.ts'
import { Router } from '../../http/router.ts'
import { registerAssistantRoutes } from '../../http/admin/assistant-routes.ts'

const tenant = 'tenant-dsh-work', actor = 'U00008', signal = new AbortController().signal
let db: ThrowawayDatabase, service: AdminAssistantService, agents: PostgresAgentService
let delegatedCalls = 0
before(async () => {
  db = await createThrowawayDatabase({ namePrefix: 'dsh_review_c6' })
  const auth = new PostgresAuthorizationService(db.client)
  agents = new PostgresAgentService(db.client)
  // SYNTHETIC platform-tool fixture: no DSH/model/production execution is claimed.
  const orchestration = { startAdminRun: async (input: { purpose: RuntimeManifest['purpose']; sessionId: string }) => {
    delegatedCalls++
    const manifest = await seedRun(input.purpose!, input.sessionId)
    return { id: manifest.run_id }
  } } as unknown as RunOrchestrationService
  const operations = new PostgresOperationsService(db.client, new UnavailableRuntime('runtime-local-01'), auth)
  const installation = new AdminSkillInstallationService(db.client, orchestration, auth, {} as PostgresToolConnectorService)
  service = new AdminAssistantService(db.client, orchestration, auth, installation, new PostgresSkillService(db.client), agents, operations)
})
after(async () => { await db?.dispose() })
async function draft() {
  const id = `agent-c6-${randomUUID().slice(0, 8)}`
  return (await agents.createAgent({ id, name: '待确认草稿', description: '合成的草稿文案验证，不连接模型和生产系统。', owner: actor, department: 'platform',
    visibility: '试点员工', roleIds: ['role-employee'], dataScopes: ['enterprise:authorized'],
    welcomeMessage: '欢迎使用', examplePrompts: ['介绍自己的能力'],
    systemPrompt: '你是合成测试助手，仅用于校验管理操作事务，不执行实际模型调用。',
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300, skills: ['skill-document@1.0.0'], tools: ['tool-runtime-file-read@1.0.0'], changeSummary: '合成测试初稿', actor,
  })).agent
}
async function seedRun(purpose: NonNullable<RuntimeManifest['purpose']>, sessionId = `admin-session-${randomUUID()}`) {
  const runId = `run-${randomUUID()}`, attemptId = `attempt-${randomUUID()}`
  await db.client`insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
    values (${sessionId}, ${tenant}, ${actor}, 'C6 synthetic tool session', 'active', 'admin', null, null) on conflict do nothing`
  await db.client`insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
    values (${runId}, ${tenant}, ${sessionId}, ${actor}, ${randomUUID()}, 'queued')`
  const manifest = { manifest_version: '1.0', purpose, run_id: runId, attempt_id: attemptId, session_id: sessionId,
    workspace_id: '', agent_version_id: null, agent_configuration: { system_prompt: 'Synthetic fixture', skill_instructions: [] },
    user_context: { user_id: actor, tenant_id: tenant, role_ids: [] }, input: { message: '准备合成管理计划', file_mounts: [] },
    tools: [{ id: 'prepare_admin_action', version: '1.0.0' }], skills: [], data_scopes: [], knowledge_context: [],
  } as unknown as RuntimeManifest
  await db.client`insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status)
    values (${attemptId}, ${tenant}, ${runId}, 1, ${db.client.json(JSON.parse(JSON.stringify(manifest)))}, ${sha256(canonicalJson(manifest))}, '{}', 'running')`
  await db.client`update runs set current_attempt_id = ${attemptId}, status = 'running' where id = ${runId}`
  return manifest
}
async function finish(manifest: RuntimeManifest) {
  await db.client`update run_attempts set status = 'succeeded' where id = ${manifest.attempt_id}`
  await db.client`update runs set status = 'succeeded' where id = ${manifest.run_id}`
}
async function prepare(manifest: RuntimeManifest, target: string, changes: Record<string, unknown>, actionType = 'agent-update-draft') {
  return service.prepareAction({ actionType, target, summary: '确认本次草稿修改', changes }, manifest, signal)
}
async function delegated(purpose: 'admin-agent-manage' | 'admin-platform-operations' = 'admin-agent-manage') {
  const origin = await seedRun('admin-assistant')
  const proposal = await service.proposeTask({ kind: purpose === 'admin-agent-manage' ? 'agent-management' : 'platform-operations', summary: '准备专用管理计划', impact: '读取对象并生成变更，仍需最终确认。' }, origin, signal)
  await finish(origin)
  await service.confirmProposal(actor, proposal.id, proposal.proposalSha256)
  const [row] = await db.client<{ manifest: RuntimeManifest }[]>`select ra.manifest from admin_assistant_task_proposals p
    join runs r on r.id = p.delegated_run_id join run_attempts ra on ra.id = r.current_attempt_id where p.id = ${proposal.id}`
  return row!.manifest
}

test('C6 RED: one general run prepares a display-only draft plan; only final confirmation writes once', async () => {
  const agent = await draft(), manifest = await seedRun('admin-assistant'), calls = delegatedCalls
  const plan = await prepare(manifest, agent.id, { name: '新草稿标题', welcomeMessage: '新的欢迎文案' })
  assert.equal((await agents.getMutationSnapshot(agent.id)).agent.name, agent.name)
  assert.equal(delegatedCalls, calls)
  assert.equal((await service.detail(actor, manifest.session_id)).proposals.length, 0)
  await assert.rejects(service.confirmAction(actor, plan.id, plan.planSha256))
  await finish(manifest)
  await service.confirmAction(actor, plan.id, plan.planSha256)
  const revision = (await agents.getMutationSnapshot(agent.id)).revision
  await service.confirmAction(actor, plan.id, plan.planSha256)
  assert.equal((await agents.getMutationSnapshot(agent.id)).revision, revision)
  assert.equal((await agents.getMutationSnapshot(agent.id)).agent.name, '新草稿标题')
  assert.equal((await agents.getMutationSnapshot(agent.id)).agent.status, 'draft')
  const [audit] = await db.client<{ n: number }[]>`select count(*)::int as n from audit_events where action = 'admin.assistant.action.confirm' and object_id = ${plan.id}`
  assert.equal(audit?.n, 1)
})

test('all privilege, execution, status, Runtime and unknown fields are refused by the single-confirmation path', async () => {
  const agent = await draft()
  for (const [key, value] of Object.entries({ systemPrompt: '不得通过通用助手直接改变模型行为指令。',
    roleIds: ['role-admin'], dataScopes: ['all'], skills: [], tools: [], maxOutputBytes: 131072, maxToolCalls: 20, timeoutSeconds: 20,
    visibility: '所有员工', owner: actor, department: 'test', allowWorkspaceJoin: true, status: 'published', confirmationMode: 'single', changeSummary: '不能由调用方覆盖安全字段', unknown: 1 })) {
    await assert.rejects(prepare(await seedRun('admin-assistant'), agent.id, { name: '合法字段混入', [key]: value }))
  }
  await assert.rejects(prepare(await seedRun('admin-assistant'), agent.id, { status: 'published' }, 'agent-set-status'))
  await assert.rejects(prepare(await seedRun('admin-assistant'), 'runtime-local-01', { maxConcurrentWorkers: 4 }, 'runtime-update-configuration'))
})

test('published-only targets, no-op edits and read-only actors cannot use the shortcut', async () => {
  const agent = await draft()
  await assert.rejects(prepare(await seedRun('admin-assistant'), agent.id, { name: agent.name }))
  await publishDraftWithSealedTrial(db.client, agents, agent.id, actor)
  await assert.rejects(prepare(await seedRun('admin-assistant'), agent.id, { name: '不自动创建草稿' }))
  const other = await draft(), manifest = await seedRun('admin-assistant')
  manifest.user_context.user_id = 'U00001'
  await assert.rejects(prepare(manifest, other.id, { name: '无权限的修改' }))
})

test('C6 RED: an unconfirmed specialist cannot bypass the first confirmation even with a successful run', async () => {
  const agent = await draft(), manifest = await seedRun('admin-agent-manage')
  const plan = await prepare(manifest, agent.id, { roleIds: ['role-employee'], systemPrompt: '这是合成测试中需要双重确认的执行指令变更。' })
  await finish(manifest)
  await assert.rejects(service.confirmAction(actor, plan.id, plan.planSha256), /确认|授权/)
  assert.equal((await agents.getMutationSnapshot(agent.id)).agent.systemPrompt, agent.systemPrompt)
})

test('delegated high-risk Agent and Runtime actions still require both confirmations', async () => {
  const agent = await draft(), manifest = await delegated()
  const plan = await prepare(manifest, agent.id, { systemPrompt: '这是一份经两次明确确认后才允许保存的草稿执行指令。' })
  assert.equal((await agents.getMutationSnapshot(agent.id)).agent.systemPrompt, agent.systemPrompt)
  await finish(manifest); await service.confirmAction(actor, plan.id, plan.planSha256)
  assert.notEqual((await agents.getMutationSnapshot(agent.id)).agent.systemPrompt, agent.systemPrompt)
  const runtimeManifest = await delegated('admin-platform-operations')
  const runtimePlan = await prepare(runtimeManifest, 'runtime-local-01', { maxConcurrentWorkers: 3, schedulingStatus: 'draining' }, 'runtime-update-configuration')
  await finish(runtimeManifest); await service.confirmAction(actor, runtimePlan.id, runtimePlan.planSha256)
  const [runtime] = await db.client<{ n: number }[]>`select concurrency_limit as n from runtime_configurations order by revision desc limit 1`
  assert.equal(runtime?.n, 3)
})

test('cancelled plans, stale state, digest tampering, new attempts and other users never write', async () => {
  const agent = await draft(), manifest = await seedRun('admin-assistant')
  const plan = await prepare(manifest, agent.id, { description: '待确认的合成说明文案，未被确认前不能写入。' })
  await finish(manifest)
  await assert.rejects(service.confirmAction(actor, plan.id, 'b'.repeat(64)))
  await assert.rejects(service.confirmAction('U00001', plan.id, plan.planSha256))
  await service.cancelAction(actor, plan.id)
  await assert.rejects(service.confirmAction(actor, plan.id, plan.planSha256))
  assert.equal((await agents.getMutationSnapshot(agent.id)).agent.description, agent.description)
  const next = await seedRun('admin-assistant'), stale = await prepare(next, agent.id, { name: '过期计划' })
  await finish(next)
  await db.client`update agents set updated_at = now() where id = ${agent.id}`
  // Configuration changes, not the wall clock, invalidate the optimistic snapshot.
  await db.client`update agent_versions set name = '另一个管理员已修改' where id = (select draft_version_id from agents where id = ${agent.id})`
  await assert.rejects(service.confirmAction(actor, stale.id, stale.planSha256), /变化|失效/)
  const rerun = await seedRun('admin-assistant'), old = await prepare(rerun, agent.id, { name: '旧 Attempt 不可确认' })
  await finish(rerun)
  const newId = `attempt-${randomUUID()}`
  await db.client`insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status)
    values (${newId}, ${tenant}, ${rerun.run_id}, 2, ${db.client.json(JSON.parse(JSON.stringify({ ...rerun, attempt_id: newId })))}, ${'a'.repeat(64)}, '{}', 'succeeded')`
  await db.client`update runs set current_attempt_id = ${newId} where id = ${rerun.run_id}`
  await assert.rejects(service.confirmAction(actor, old.id, old.planSha256), /Attempt|变化/)
})

test('HTTP confirmation checks role and owner; double clicks do not duplicate the draft write', async () => {
  const agent = await draft(), manifest = await seedRun('admin-assistant')
  const plan = await prepare(manifest, agent.id, { name: 'HTTP 一次确认' }); await finish(manifest)
  const router = new Router({ authenticateApi: prototypeApiAuthenticator })
  registerAssistantRoutes(router, service)
  const server = createServer((req, res) => void router.handle(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}/api/admin/v1/assistant/action-plans/${plan.id}/confirm`
    const responses = await Promise.all([1, 2].map(() => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planSha256: plan.planSha256 }) })))
    assert.ok(responses.some(response => response.status === 200))
    assert.ok(responses.every(response => [200, 409].includes(response.status)))
    assert.equal((await agents.getMutationSnapshot(agent.id)).agent.name, 'HTTP 一次确认')
    const [audit] = await db.client<{ n: number }[]>`select count(*)::int as n from audit_events where action = 'admin.assistant.action.confirm' and object_id = ${plan.id}`
    assert.equal(audit?.n, 1)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('a draft-copy change never alters its existing published version or published catalog metadata', async () => {
  const agent = await draft()
  await publishDraftWithSealedTrial(db.client, agents, agent.id, actor)
  await agents.updateAgent({ ...agent, agentId: agent.id, name: '后续待发布草稿', changeSummary: '创建新草稿', actor })
  const [before] = await db.client`select name, description, active_version_id from agents where id = ${agent.id}`
  const [published] = await db.client`select to_jsonb(v) as snapshot from agent_versions v where id = ${before!.active_version_id}`
  const manifest = await seedRun('admin-assistant')
  const plan = await prepare(manifest, agent.id, { name: '只修改草稿版本文案' })
  await finish(manifest); await service.confirmAction(actor, plan.id, plan.planSha256)
  const [after] = await db.client`select name, description, active_version_id from agents where id = ${agent.id}`
  const [unchanged] = await db.client`select to_jsonb(v) as snapshot from agent_versions v where id = ${before!.active_version_id}`
  assert.deepEqual(after, before); assert.deepEqual(unchanged, published)
  assert.equal((await agents.getMutationSnapshot(agent.id)).agent.name, '只修改草稿版本文案')
})

test('revoking the confirming administrator and cancelling a running tool both deny without writes', async () => {
  const agent = await draft(), manifest = await seedRun('admin-assistant')
  const plan = await prepare(manifest, agent.id, { name: '撤权后不能保存' }); await finish(manifest)
  try {
    await db.client`update users set status = 'disabled' where id = ${actor}`
    await assert.rejects(service.confirmAction(actor, plan.id, plan.planSha256), /停用|权限|管理员/)
  } finally { await db.client`update users set status = 'active' where id = ${actor}` }
  assert.equal((await agents.getMutationSnapshot(agent.id)).agent.name, agent.name)
  const cancelled = await seedRun('admin-assistant')
  await db.client`update runs set status = 'cancelled' where id = ${cancelled.run_id}`
  await assert.rejects(prepare(cancelled, agent.id, { name: '迟到的工具结果' }), /Attempt/)
  const [count] = await db.client<{ n: number }[]>`select count(*)::int as n from admin_assistant_action_plans where run_id = ${cancelled.run_id}`
  assert.equal(count?.n, 0)
})

test('restart does not execute pending plans and fails interrupted plans with unchanged target', async () => {
  const agent = await draft(), manifest = await seedRun('admin-assistant')
  const plan = await prepare(manifest, agent.id, { name: '未确认或中断的操作' }); await finish(manifest)
  await service.recoverInterruptedActions()
  assert.equal((await agents.getMutationSnapshot(agent.id)).agent.name, agent.name)
  await db.client`update admin_assistant_action_plans set status = 'executing' where id = ${plan.id}`
  const recovered = await service.recoverInterruptedActions()
  assert.ok(recovered.failed >= 1)
  assert.equal((await agents.getMutationSnapshot(agent.id)).agent.name, agent.name)
  await assert.rejects(service.confirmAction(actor, plan.id, plan.planSha256))
})
