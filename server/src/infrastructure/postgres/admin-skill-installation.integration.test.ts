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
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { AdminAssistantService, type StoredActionPlan } from '../../modules/admin/application/admin-assistant-service.ts'
import { acquireSkillSource, type SkillSource } from '../../modules/skill/skill-source.ts'
import { FileSystemSkillArtifactStore } from '../../modules/skill/file-system-skill-artifact-store.ts'
import { migrateSkillFilesToFileSystem } from '../../modules/skill/skill-file-storage-migration.ts'
import { parseSkillPackage } from '../../modules/skill/skill-package.ts'
import { compileRuntimeManifest } from '../../modules/runtime/manifest-compiler.ts'
import type { RuntimeManifest } from '../../modules/runtime/runtime-types.ts'

const tenant = 'tenant-dsh-work', actor = 'U00008'
const real = process.env.DSH_WORK_SKILL_REAL_DSH === '1'
let database: ThrowawayDatabase, orchestration: RunOrchestrationService, service: AdminSkillInstallationService
let assistant: AdminAssistantService
let operations: PostgresOperationsService
let agents: PostgresAgentService
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
    inspectAdminState: (input, manifest, signal) => assistant.inspectState(input, manifest, signal),
    proposeAdminTask: (input, manifest, signal) => assistant.proposeTask(input, manifest, signal),
    prepareAdminAction: (input, manifest, signal) => assistant.prepareAction(input, manifest, signal),
    loadSkillArtifact: skill => artifactStore.readRuntimeArtifact(skill.artifact_ref!, skill.files ?? [], skill.instructions_sha256!),
    recordSkillActivation: (manifest, skill, digest) => service.recordActivation(manifest, skill, digest),
  })
  const auth = new PostgresAuthorizationService(database.client)
  operations = new PostgresOperationsService(database.client, runtime, auth)
  const tools = new PostgresToolConnectorService(database.client, runtime, operations)
  const skills = new PostgresSkillService(database.client, operations, tools, artifactStore)
  agents = new PostgresAgentService(database.client, operations, skills, tools)
  conversations = new PostgresConversationRepository(database.client)
  runs = new PostgresRunRepository(database.client)
  orchestration = new RunOrchestrationService(runs, conversations, new ModelGovernanceService(new PostgresModelGovernanceRepository(database.client)), runtime, undefined, operations, agents, undefined, auth)
  service = new AdminSkillInstallationService(database.client, orchestration, auth, tools, real ? acquireSkillSource : fixtureAcquire, false, [], artifactStore)
  assistant = new AdminAssistantService(database.client, orchestration, auth, service, skills, agents, operations)
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
async function waitForAssistant(sessionId: string) {
  for (let index = 0; index < 150; index++) {
    const detail = await assistant.detail(actor, sessionId)
    if (detail.runs.every(run => ['succeeded', 'failed', 'cancelled'].includes(run.status))) return detail
    await delay(100)
  }
  throw new Error('Admin assistant run did not finish')
}

test('general admin chat proposes delegation and executes a specialist plan only after both confirmations', { skip: real, timeout: 60000 }, async () => {
  const sessionId = `admin-session-${randomUUID()}`
  const ordinary = await assistant.send(actor, { sessionId, requestId: randomUUID(), message: '当前平台概况如何？' })
  assert.equal(ordinary.proposals.length, 0)
  const ordinaryDone = await waitForAssistant(sessionId)
  assert.equal(ordinaryDone.proposals.length, 0)
  assert.equal(ordinaryDone.runs[0]?.status, 'succeeded')
  const [ordinaryAttempt] = await database.client<{ purpose: string; tools: Array<{ id: string }>; systemPrompt: string }[]>`
    select manifest->>'purpose' as purpose,
           manifest->'tools' as tools,
           manifest->'agent_configuration'->>'system_prompt' as "systemPrompt"
      from run_attempts where run_id = ${ordinaryDone.runs[0]!.id}
  `
  assert.equal(ordinaryAttempt?.purpose, 'admin-assistant')
  assert.deepEqual(ordinaryAttempt?.tools.map(tool => tool.id), ['inspect_admin_state', 'propose_admin_task'])
  assert.match(ordinaryAttempt?.systemPrompt ?? '', /通用管理助手，不是 Skill 安装助手/)
  assert.match(ordinaryAttempt?.systemPrompt ?? '', /Skill 安装只是你的能力之一/)
  assert.match(ordinaryAttempt?.systemPrompt ?? '', /不要主动索取 Skill 来源/)
  assert.match(ordinaryAttempt?.systemPrompt ?? '', /只有 totalCount 为 0/)

  await assistant.send(actor, { sessionId, requestId: randomUUID(), message: '把当前 Runtime 的 Attempt 超时时间调整一分钟' })
  const proposed = await waitForAssistant(sessionId)
  const proposal = proposed.proposals.at(-1)!
  assert.equal(proposal.kind, 'platform-operations')
  assert.equal(proposal.status, 'pending')
  assert.equal(proposal.delegatedRunId, null)
  const runtimeBefore = (await database.client<{ timeoutMinutes: number }[]>`
    select ceil(timeout_seconds / 60.0)::integer as "timeoutMinutes" from runtime_configurations
     where runtime_id = 'runtime-local-01' order by revision desc limit 1
  `)[0]!.timeoutMinutes
  await assert.rejects(assistant.confirmProposal(actor, proposal.id, 'wrong-digest'), /变化/)
  const delegated = await assistant.confirmProposal(actor, proposal.id, proposal.proposalSha256)
  assert.equal(delegated.proposals.at(-1)?.status, 'confirmed')
  assert.ok(delegated.proposals.at(-1)?.delegatedRunId)
  assert.equal((await database.client<{ timeoutMinutes: number }[]>`select ceil(timeout_seconds / 60.0)::integer as "timeoutMinutes" from runtime_configurations where runtime_id = 'runtime-local-01' order by revision desc limit 1`)[0]!.timeoutMinutes, runtimeBefore)

  const planned = await waitForAssistant(sessionId)
  const action = planned.actions.at(-1)!
  assert.equal(action.actionType, 'runtime-update-configuration')
  assert.equal(action.status, 'pending')
  assert.equal(action.before.attemptTimeoutMinutes, runtimeBefore)
  await assert.rejects(assistant.confirmAction(actor, action.id, 'wrong-digest'), /变化/)
  const executed = await assistant.confirmAction(actor, action.id, action.planSha256)
  assert.equal(executed.actions.at(-1)?.status, 'executed')
  assert.notEqual((await database.client<{ timeoutMinutes: number }[]>`select ceil(timeout_seconds / 60.0)::integer as "timeoutMinutes" from runtime_configurations where runtime_id = 'runtime-local-01' order by revision desc limit 1`)[0]!.timeoutMinutes, runtimeBefore)
  assert.match(executed.messages.at(-1)?.text ?? '', /管理员确认的计划执行/)

  await assistant.send(actor, { sessionId, requestId: randomUUID(), message: '调整 Agent 的说明，保存为待发布草稿' })
  const agentProposed = await waitForAssistant(sessionId)
  const agentProposal = agentProposed.proposals.at(-1)!
  assert.equal(agentProposal.kind, 'agent-management')
  await assistant.confirmProposal(actor, agentProposal.id, agentProposal.proposalSha256)
  const agentPlanned = await waitForAssistant(sessionId)
  const agentAction = agentPlanned.actions.at(-1)!
  assert.equal(agentAction.actionType, 'agent-update-draft')
  const agentId = String(agentAction.after.agentId)
  const desiredDescription = String(agentAction.after.description)
  const [beforeAgent] = await database.client<{ description: string }[]>`
    select av.description from agents a
    join agent_versions av on av.tenant_id = a.tenant_id and av.id = coalesce(a.draft_version_id, a.active_version_id)
    where a.tenant_id = ${tenant} and a.id = ${agentId}
  `
  assert.equal(beforeAgent?.description, agentAction.before.description)
  const agentExecuted = await assistant.confirmAction(actor, agentAction.id, agentAction.planSha256)
  assert.equal(agentExecuted.actions.at(-1)?.status, 'executed')
  const [afterAgent] = await database.client<{ description: string }[]>`
    select av.description from agents a join agent_versions av on av.tenant_id = a.tenant_id and av.id = a.draft_version_id
    where a.tenant_id = ${tenant} and a.id = ${agentId}
  `
  assert.equal(afterAgent?.description, desiredDescription)

  await assistant.send(actor, { sessionId, requestId: randomUUID(), message: '再次调整当前 Runtime 的 Attempt 超时时间' })
  const staleProposed = await waitForAssistant(sessionId)
  const staleProposal = staleProposed.proposals.at(-1)!
  await assistant.confirmProposal(actor, staleProposal.id, staleProposal.proposalSha256)
  const stalePlanned = await waitForAssistant(sessionId)
  const staleAction = stalePlanned.actions.at(-1)!
  await database.client`
    insert into runtime_configurations (tenant_id, runtime_id, revision, concurrency_limit, timeout_seconds, sandbox_policy, updated_by)
    select tenant_id, runtime_id, max(revision) + 1, ${Number(staleAction.before.maxConcurrentWorkers)}, ${(Number(staleAction.before.attemptTimeoutMinutes) + 2) * 60}, '{}', ${actor}
      from runtime_configurations where tenant_id = ${tenant} and runtime_id = 'runtime-local-01' group by tenant_id, runtime_id
  `
  await assert.rejects(assistant.confirmAction(actor, staleAction.id, staleAction.planSha256), /状态已变化/)
  const staleRejected = await assistant.detail(actor, sessionId)
  assert.equal(staleRejected.actions.at(-1)?.status, 'failed')
  assert.match(staleRejected.messages.at(-1)?.text ?? '', /本次未执行平台写入/)
  await database.client`
    insert into runtime_configurations (tenant_id, runtime_id, revision, concurrency_limit, timeout_seconds, sandbox_policy, updated_by)
    select tenant_id, runtime_id, max(revision) + 1, ${Number(staleAction.before.maxConcurrentWorkers)}, ${Number(staleAction.before.attemptTimeoutMinutes) * 60}, '{}', ${actor}
      from runtime_configurations where tenant_id = ${tenant} and runtime_id = 'runtime-local-01' group by tenant_id, runtime_id
  `

  const prepareInterruptedRuntimeAction = async (message: string) => {
    await assistant.send(actor, { sessionId, requestId: randomUUID(), message })
    const nextProposal = (await waitForAssistant(sessionId)).proposals.at(-1)!
    await assistant.confirmProposal(actor, nextProposal.id, nextProposal.proposalSha256)
    return (await waitForAssistant(sessionId)).actions.at(-1)!
  }

  const notStarted = await prepareInterruptedRuntimeAction('再次调整 Runtime 超时时间，用于重启前未写入场景')
  await database.client`update admin_assistant_action_plans set status = 'executing' where tenant_id = ${tenant} and id = ${notStarted.id}`
  const notStartedRecovery = await assistant.recoverInterruptedActions()
  assert.deepEqual(notStartedRecovery, { inspected: 1, recoveredExecuted: 0, failed: 1 })
  assert.equal((await assistant.detail(actor, sessionId)).actions.at(-1)?.status, 'failed')

  const alreadyApplied = await prepareInterruptedRuntimeAction('再次调整 Runtime 超时时间，用于重启后核对已写入场景')
  const [stored] = await database.client<{ plan: StoredActionPlan }[]>`
    select plan from admin_assistant_action_plans where tenant_id = ${tenant} and id = ${alreadyApplied.id}
  `
  if (!stored || stored.plan.actionType !== 'runtime-update-configuration') throw new Error('Runtime 恢复测试计划缺失')
  await database.client`update admin_assistant_action_plans set status = 'executing' where tenant_id = ${tenant} and id = ${alreadyApplied.id}`
  await operations.updateRuntimeConfiguration({
    runtimeId: stored.plan.after.runtimeId,
    maxConcurrentWorkers: stored.plan.after.maxConcurrentWorkers,
    attemptTimeoutMinutes: stored.plan.after.attemptTimeoutMinutes,
    schedulingStatus: stored.plan.after.schedulingStatus,
    actor,
  }, stored.plan.before)
  const appliedRecovery = await assistant.recoverInterruptedActions()
  assert.deepEqual(appliedRecovery, { inspected: 1, recoveredExecuted: 1, failed: 0 })
  const recoveredDetail = await assistant.detail(actor, sessionId)
  assert.equal(recoveredDetail.actions.at(-1)?.status, 'executed')
  assert.match(recoveredDetail.messages.at(-1)?.text ?? '', /服务重启后已核对目标最终状态/)
})

test('guarded Runtime and Agent mutations reject a stale plan revision inside the write lock', async () => {
  const runtimeBefore = await operations.getRuntimeMutationSnapshot('runtime-local-01')
  await operations.updateRuntimeConfiguration({
    runtimeId: runtimeBefore.runtimeId,
    maxConcurrentWorkers: runtimeBefore.maxConcurrentWorkers,
    attemptTimeoutMinutes: runtimeBefore.attemptTimeoutMinutes === 60 ? 59 : runtimeBefore.attemptTimeoutMinutes + 1,
    schedulingStatus: runtimeBefore.schedulingStatus,
    actor,
  })
  await assert.rejects(operations.updateRuntimeConfiguration({
    runtimeId: runtimeBefore.runtimeId,
    maxConcurrentWorkers: runtimeBefore.maxConcurrentWorkers,
    attemptTimeoutMinutes: runtimeBefore.attemptTimeoutMinutes,
    schedulingStatus: runtimeBefore.schedulingStatus,
    actor,
  }, runtimeBefore), /Runtime 状态已变化/)

  const agent = (await agents.getAgents())[0]
  if (!agent) throw new Error('Agent 竞态测试数据缺失')
  const agentBefore = await agents.getMutationSnapshot(agent.id)
  const input = {
    agentId: agentBefore.agent.id,
    name: agentBefore.agent.name,
    description: `${agentBefore.agent.description.slice(0, 170)}（并发更新）`,
    owner: agentBefore.agent.owner,
    department: agentBefore.agent.department,
    visibility: agentBefore.agent.visibility,
    roleIds: agentBefore.agent.roleIds,
    dataScopes: agentBefore.agent.dataScopes,
    welcomeMessage: agentBefore.agent.welcomeMessage,
    examplePrompts: agentBefore.agent.examplePrompts,
    systemPrompt: agentBefore.agent.systemPrompt,
    maxTokens: agentBefore.agent.maxTokens,
    timeoutSeconds: agentBefore.agent.timeoutSeconds,
    skills: agentBefore.agent.skills,
    tools: agentBefore.agent.tools,
    changeSummary: '并发更新测试',
    actor,
  }
  await agents.updateAgent(input)
  await assert.rejects(agents.updateAgent({ ...input, description: `${input.description.slice(0, 170)}（旧计划）` }, agentBefore.revision), /Agent 配置已变化/)
})

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
    const querySessionId = `admin-session-${randomUUID()}`
    await assistant.send(actor, { sessionId: querySessionId, requestId: randomUUID(), message: '平台上有哪些skill?' })
    const queried = await waitForAssistant(querySessionId)
    const queryReply = queried.messages.find(message => message.role === 'assistant')?.text ?? ''
    const querySnapshot = JSON.parse(queryReply) as { totalCount: number; matchedCount: number; returnedCount: number; filterWarning?: string; items: Array<{ id: string; name: string }> }
    assert.equal(querySnapshot.totalCount, afterCount!.count)
    assert.equal(querySnapshot.matchedCount, 0)
    assert.equal(querySnapshot.returnedCount, querySnapshot.totalCount)
    assert.ok(querySnapshot.items.some(item => item.id === skillId && item.name === 'installation-test'))
    assert.match(querySnapshot.filterWarning ?? '', /只有 totalCount 为 0/)
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
  // Resource-only changes in a draft dependency must invalidate the root's
  // publication evidence without changing the root's own configuration.
  const [dependency] = await database.client<{ id: string; manifest: { artifact: import('../../modules/skill/skill-package.ts').SkillPackageArtifact } }[]>`
    select sv.id, sv.manifest from skill_version_dependencies d
    join skill_versions sv on sv.tenant_id = d.tenant_id and sv.id = d.dependency_skill_version_id
    join skills root on root.tenant_id = d.tenant_id and root.draft_version_id = d.skill_version_id
    where root.tenant_id = ${tenant} and root.id = ${rootId} limit 1`
  assert.ok(dependency)
  const changedDependency = await artifactStore.put(parseSkillPackage(zipSync({
    'SKILL.md': strToU8(body.replace('installation-test', 'grilling')), 'references/value.txt': strToU8('CHANGED_DEPENDENCY'),
  })))
  try {
    await database.client`update skill_versions set manifest = ${database.client.json(JSON.parse(JSON.stringify({ ...dependency.manifest, artifact: changedDependency })))},
      artifact_ref = ${changedDependency.artifactRef}, package_sha256 = ${changedDependency.sha256} where id = ${dependency.id}`
    await assert.rejects(skills.setStatus({ skillId: rootId, actor, status: 'published' }), { code: 'skill_test_snapshot_changed' })
  } finally {
    await database.client`update skill_versions set manifest = ${database.client.json(JSON.parse(JSON.stringify(dependency.manifest)))},
      artifact_ref = ${dependency.manifest.artifact.artifactRef}, package_sha256 = ${dependency.manifest.artifact.sha256} where id = ${dependency.id}`
  }
  await skills.setStatus({ skillId: rootId, actor, status: 'published' })
  const resolved = await skills.resolveRuntimeSkills([`${rootId}@0.1.0`])
  assert.deepEqual(resolved.map(item => item.name).sort(), ['grill-me', 'grilling'])
  const grouped = await skills.getSkills()
  const rootDefinition = grouped.find(item => item.id === rootId)
  const dependencyDefinition = grouped.find(item => item.name === 'grilling')
  assert.equal(rootDefinition?.installationRole, 'root')
  assert.deepEqual(rootDefinition?.dependencies?.map(item => item.name), ['grilling'])
  assert.equal(dependencyDefinition?.installationRole, 'dependency')
  assert.deepEqual((await skills.listWorkbenchSkills()).filter(item => ['grill-me', 'grilling'].includes(item.name)).map(item => item.name), ['grill-me'])
  await assert.rejects(skills.resolveWorkbenchSkillVersion(dependencyDefinition!.id), /不存在、未发布或已停用/)

  const directDependencyRequest = await send('npx skills@latest add fixture/delegated --skill=grilling')
  const directDependencyDetail = await wait(directDependencyRequest.sessionId)
  await service.confirm(actor, directDependencyRequest.runId, directDependencyDetail.installations[0]!.planSha256!)
  assert.equal((await skills.getSkills()).find(item => item.id === dependencyDefinition!.id)?.installationRole, 'root')
  assert.deepEqual((await skills.listWorkbenchSkills()).filter(item => ['grill-me', 'grilling'].includes(item.name)).map(item => item.name).sort(), ['grill-me', 'grilling'])

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

test('admin HTTP routes allow read-only chat but protect management writes and conversation ownership', { skip: real }, async () => {
  const saved = await send(); await wait(saved.sessionId)
  let userId = actor
  let permissions = ['admin:read']
  const router = new Router({ authenticateApi: async (request, audience) => ({ ...(await prototypeApiAuthenticator(request, audience)), userId, permissions }) })
  registerAssistantRoutes(router, assistant)
  registerSkillInstallationRoutes(router, service)
  const server = createServer((request, response) => { void router.handle(request, response) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}/api/admin/v1/assistant`
  try {
    assert.equal((await fetch(`${base}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 422)
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/admin/v1/skill-installations`, { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-File-Name': 'test.zip' }, body: bytes })).status, 403)
    assert.equal((await fetch(`${base}/sessions/${saved.sessionId}`)).status, 200)
    userId = 'U00001'
    assert.equal((await fetch(`${base}/sessions/${saved.sessionId}`)).status, 403)
    assert.equal((await fetch(`${base}/sessions`)).status, 403)
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

test('review 8a: same-version resource change cannot relabel a completed trial or publish it', { skip: real, timeout: 30000 }, async () => {
  const name = `binding-${randomUUID().slice(0, 8)}`
  const originalBytes = zipSync({ 'SKILL.md': strToU8(body.replace('installation-test', name)), 'references/value.txt': strToU8('ORIGINAL') })
  const preview = await service.prepareZip(actor, { fileName: 'binding.zip', bytes: originalBytes })
  const installed = await service.confirmZip(actor, preview.id, preview.planSha256!)
  const skillId = installed.skillId!
  const skills = new PostgresSkillService(database.client, undefined, undefined, artifactStore)
  skills.setPackageTestLifecycle({
    start: (userId, skill, prompt) => service.startPackageTest(userId, skill, prompt),
    progress: (userId, skill, runId) => service.packageTestProgress(userId, skill, runId),
  })
  const started = await skills.startSkillTest({ skillId, actor })
  const session = await runs.getRun(tenant, started.runId)
  await wait(session!.sessionId)
  const finished = await skills.getSkillTestProgress({ skillId, runId: started.runId, actor })
  assert.equal(finished.status, 'passed')
  const [original] = await database.client<{ versionId: string; manifest: { artifact: import('../../modules/skill/skill-package.ts').SkillPackageArtifact } }[]>`
    select id as "versionId", manifest from skill_versions where tenant_id = ${tenant} and skill_id = ${skillId} and status = 'draft'`
  assert.ok(original)
  const changed = await artifactStore.put(parseSkillPackage(zipSync({
    'SKILL.md': strToU8(body.replace('installation-test', name)), 'references/value.txt': strToU8('CHANGED'),
  })))
  try {
    await database.client`update skill_versions set manifest = ${database.client.json(JSON.parse(JSON.stringify({ ...original.manifest, artifact: changed })))},
      artifact_ref = ${changed.artifactRef}, package_sha256 = ${changed.sha256}
      where tenant_id = ${tenant} and id = ${original.versionId}`
    await assert.rejects(skills.getSkillTestProgress({ skillId, runId: started.runId, actor }), { code: 'skill_test_snapshot_changed' })
    await assert.rejects(skills.setStatus({ skillId, actor, status: 'published' }), /测试/)
  } finally {
    await database.client`update skill_versions set manifest = ${database.client.json(JSON.parse(JSON.stringify(original.manifest)))},
      artifact_ref = ${original.manifest.artifact.artifactRef}, package_sha256 = ${original.manifest.artifact.sha256}
      where tenant_id = ${tenant} and id = ${original.versionId}`
  }
  await skills.setStatus({ skillId, actor, status: 'published' })
})

test('review 8a: retry preserves every pinned Skill and original model route', { skip: real, timeout: 30000 }, async () => {
  const child = { id: 'retry-child', version: '1.0.0', instructions: 'Follow this exact child instruction in the controlled test.', tools: [] }
  const root = { id: 'retry-root', version: '1.0.0', instructions: 'Follow this exact root instruction in the controlled test.', tools: [],
    dependencies: ['retry-child@1.0.0'], dependencySkills: [child] }
  const started = await service.startPackageTest(actor, root, '[hang] 保留固定依赖图')
  const run = await runs.getRun(tenant, started.runId)
  const oldAttempt = await runs.getAttempt(tenant, run!.currentAttemptId!)
  assert.ok(oldAttempt)
  await waitForAttemptStart(oldAttempt.id)
  await orchestration.cancelAdminRun(started.runId, actor)
  await wait(run!.sessionId)
  await orchestration.retryAdminRun(started.runId, actor)
  const retried = await runs.getRun(tenant, started.runId)
  const newAttempt = await runs.getAttempt(tenant, retried!.currentAttemptId!)
  try {
    assert.ok(newAttempt)
    assert.notEqual(newAttempt.id, oldAttempt.id)
    assert.deepEqual(newAttempt.manifest.agent_configuration, oldAttempt.manifest.agent_configuration)
    assert.deepEqual(newAttempt.manifest.skills, oldAttempt.manifest.skills)
    assert.deepEqual(newAttempt.manifest.tools, oldAttempt.manifest.tools)
    assert.deepEqual(newAttempt.manifest.input, oldAttempt.manifest.input)
    assert.deepEqual(newAttempt.modelRouteSnapshot, oldAttempt.modelRouteSnapshot)
  } finally {
    if (newAttempt) await waitForAttemptStart(newAttempt.id)
    await orchestration.cancelAdminRun(started.runId, actor)
    await wait(run!.sessionId)
  }
})

async function waitForAttemptStart(attemptId: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const [started] = await database.client`select id from run_events where tenant_id = ${tenant}
      and attempt_id = ${attemptId} and event_type = 'run.started'`
    if (started) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('受控 Worker 未进入运行态')
}
