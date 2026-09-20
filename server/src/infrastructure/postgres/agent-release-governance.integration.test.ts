import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { AgentSpec } from '../../modules/agent/agent-spec.ts'
import { PostgresAgentReleaseService } from '../../modules/agent/postgres-agent-release-service.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const ADMIN = 'user-release-admin'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let packagesDir: string
let agents: PostgresAgentService
let release: PostgresAgentReleaseService
let orchestration: RunOrchestrationService
let trialRuntime: TrialStubRuntime
let tools: PostgresToolConnectorService

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_agent_release_test', maxConnections: 8 })
  database = throwaway.client
  packagesDir = await mkdtemp(join(tmpdir(), 'dsh-agent-packages-'))
  tools = new PostgresToolConnectorService(database)
  const skills = new PostgresSkillService(database, undefined, tools)
  agents = new PostgresAgentService(database, undefined, skills, tools)
  trialRuntime = new TrialStubRuntime()
  orchestration = new RunOrchestrationService(
    new PostgresRunRepository(database),
    new PostgresConversationRepository(database),
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    trialRuntime,
    undefined,
    undefined,
    agents,
    undefined,
    // 发布试运行目的在执行时复核平台管理权限，测试环境接真实授权服务
    new PostgresAuthorizationService(database),
    // B-03/I-04：试运行 Attempt 固定的绑定修订在执行前复核真实绑定服务。
    { toolBindings: tools },
  )
  release = new PostgresAgentReleaseService(database, agents, skills, tools, packagesDir, orchestration)
  await createAdminUser(ADMIN)
})

after(async () => {
  await orchestration.close()
  await throwaway.dispose()
  await rm(packagesDir, { recursive: true, force: true })
})

async function createAdminUser(id: string) {
  await database`
    insert into users (id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user)
    values (${id}, ${tenantId}, ${`directory:${id}`}, '发布管理员', null, 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-platform-admin', 'local')
    on conflict do nothing
  `
}

async function createDraftAgent(id: string) {
  return agents.createAgent({
    id,
    name: '退款预测助手',
    description: '基于历史退款记录预测高风险订单并给出处理建议。',
    owner: '发布管理员',
    department: '平台治理',
    visibility: '指定角色',
    roleIds: ['role-employee'],
    dataScopes: ['workspace:authorized'],
    welcomeMessage: '',
    examplePrompts: ['评估本周退款风险订单'],
    systemPrompt: '你是退款预测助手。基于已授权的历史退款与订单数据评估风险，只输出风险等级与依据。',
    maxOutputBytes: 65536, maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: ['skill-document@1.0.0'],
    tools: ['read@1.0.0'],
    changeSummary: '创建初始草稿版本',
    actor: ADMIN,
  })
}

function buildAgentYaml(overrides: { id?: string; name?: string; version?: string; description?: string; instructions?: string; tools?: string; specLines?: string[]; topLines?: string[] } = {}) {
  // tools 为逗号分隔的 id@x.y.z 精确引用；specLines 追加在 spec 内，topLines 追加在顶层。
  const tools = (overrides.tools ?? 'read@1.0.0').split(',').map(item => item.trim()).filter(Boolean)
  return [
    'apiVersion: dsh-work.ai/v1',
    'kind: AgentPackage',
    'metadata:',
    `  id: ${overrides.id ?? 'zip-agent'}`,
    `  name: ${overrides.name ?? '退款预测助手'}`,
    `  version: ${overrides.version ?? '0.1.0'}`,
    `  description: ${overrides.description ?? '基于历史退款记录预测高风险订单。'}`,
    'spec:',
    `  instructions: ${overrides.instructions ?? 'prompts/system.md'}`,
    '  capabilities:',
    '    tools:',
    ...tools.map(reference => {
      const separator = reference.lastIndexOf('@')
      return `      - id: ${reference.slice(0, separator)}\n        version: ${reference.slice(separator + 1)}`
    }),
    ...(overrides.specLines ?? []),
    ...(overrides.topLines ?? []),
    '',
  ].join('\n')
}

const PROMPT = '你是退款预测助手。基于已授权的历史退款与订单数据评估风险，只输出风险等级与依据。'

const PACKAGE_CASES = `cases:
  - name: 正常预测
    kind: success
    input: 评估本周退款风险
    expect: 输出高风险订单清单与依据
  - name: 缺少周期
    kind: invalid_input
    input: 评估退款风险
    expect: 提示需要统计周期
  - name: 越权数据
    kind: permission_denied
    input: 读取薪酬数据
    expect: 拒绝并说明权限边界
`

function createZip(entries: Record<string, string>, options: { checksums?: boolean } = {}) {
  const withChecksums = { ...entries }
  if (options.checksums !== false && !withChecksums['checksums.json']) {
    const table = Object.fromEntries(
      Object.entries(withChecksums).map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')]),
    )
    withChecksums['checksums.json'] = JSON.stringify({ files: table })
  }
  const localParts: Buffer[] = []
  const directoryParts: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(withChecksums)) {
    const nameBytes = Buffer.from(name)
    const content = Buffer.from(text)
    const checksum = crc32(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    localParts.push(local, nameBytes, content)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(content.length, 20)
    directory.writeUInt32LE(content.length, 24)
    directory.writeUInt16LE(nameBytes.length, 28)
    directory.writeUInt32LE(offset, 42)
    directoryParts.push(directory, nameBytes)
    offset += local.length + nameBytes.length + content.length
  }
  const directory = Buffer.concat(directoryParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(withChecksums).length, 8)
  end.writeUInt16LE(Object.keys(withChecksums).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, directory, end])
}

function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 试运行执行完毕停在 asserting：抓取案例执行记录并逐项登记确认结论。 */
async function confirmLatestTrial(agentId: string, verdict: 'passed' | 'failed' = 'passed') {
  const state = await release.getReleaseState(agentId)
  const trial = state.trialRuns[0]
  assert.equal(trial?.status, 'asserting', '试运行应停在待逐项确认状态')
  const caseRuns = trial.steps.flatMap(step => step.caseRuns ?? [])
  assert.ok(caseRuns.length > 0, '试运行缺少案例执行记录')
  return release.confirmTrial(agentId, trial.id, caseRuns.map(run => ({ caseId: run.caseId, verdict })), ADMIN)
}

// ---------------------------------------------------------------------------
// 配置创建主线：候选懒建 → 检查 → 封存试运行 → 逐项确认 → 审核发布 → 版本证据
// ---------------------------------------------------------------------------

test('配置创建的草稿走完检查、试运行与发布，版本证据落库', async () => {
  const agentId = 'agent-release-config'
  await createDraftAgent(agentId)

  // GET 只读：不创建候选
  const initial = await release.getReleaseState(agentId)
  assert.equal(initial.candidate, undefined)

  const state = await release.ensureCandidate(agentId, ADMIN)
  assert.ok(state.candidate)
  assert.equal(state.candidate.revision, 1)
  assert.equal(state.candidate.status, 'draft')
  assert.equal(state.candidate.cases.length, 3)
  assert.deepEqual(
    state.candidate.cases.map(item => item.kind).sort(),
    ['invalid_input', 'permission_denied', 'success'],
  )

  const checked = await release.runChecks(agentId, ADMIN)
  assert.ok(checked.candidate?.checks.length)
  assert.ok(checked.candidate.checks.every(item => item.status === 'passed'), checked.candidate.checks.map(item => item.detail).join(' | '))

  const trialed = await release.startTrial(agentId, ADMIN)
  // 执行完毕停在 asserting：发布门禁不接受未经逐项确认的试运行
  assert.equal(trialed.trialRuns[0]?.status, 'asserting')
  assert.equal(trialed.trialRuns[0]?.submissionRevision, 1)
  assert.equal(trialed.candidate?.sealedRevision, 1)
  // 试运行必须经 Run/Attempt → Runtime Adapter → DSH 真实执行：每个案例留有 runId/attemptId
  const dshStep = trialed.trialRuns[0]?.steps.find(step => step.id === 'dsh')
  assert.equal(dshStep?.caseRuns?.length, 3)
  assert.ok(dshStep?.caseRuns?.every(item => item.runId && item.attemptId && item.status === 'succeeded'))
  const trialRunsInDb = await database<{ count: number }[]>`
    select count(*)::integer as count from runs
     where tenant_id = ${tenantId} and session_id in (
       select id from sessions where tenant_id = ${tenantId} and title like '发布试运行%'
     )
  `
  assert.equal(trialRunsInDb[0]?.count, 3)

  // 未逐项确认：既不能提交审核也不能发布
  await assert.rejects(release.submitForReview(agentId, ADMIN), /通过试运行/)
  await assert.rejects(release.publish(agentId, '', ADMIN), /尚未提交审核/)

  const confirmed = await confirmLatestTrial(agentId)
  assert.equal(confirmed.trialRuns[0]?.status, 'passed')
  assert.ok(confirmed.trialRuns[0]?.steps.flatMap(step => step.caseRuns ?? []).every(item => item.verdict === 'passed'))

  const submitted = await release.submitForReview(agentId, ADMIN)
  assert.equal(submitted.candidate?.status, 'submitted')

  const published = await release.publish(agentId, '业务效果已确认', ADMIN)
  // 发布后提交进入终态不再是进行中候选，证据随版本落库：
  // 1 条配置检查 + 1 条绑定修订固定 + 每案例 1 条 runtime_verified（真实 runId）+ 1 条业务确认 = 6 条。
  assert.equal(published.candidate, undefined)
  assert.equal(published.evidence['0.1.0']?.length, 6)
  const runtimeEvidence = published.evidence['0.1.0']?.filter(item => item.kind === 'runtime_verified') ?? []
  assert.equal(runtimeEvidence.length, 3)
  assert.ok(runtimeEvidence.every(item => item.runId?.startsWith('run-')))
  assert.ok(published.evidence['0.1.0']?.some(item => item.kind === 'business_accepted'))
  // B-03/I-04：发布版本携带真实封存绑定依据（tool-binding-* 修订 + 摘要），非占位文本。
  const bindingEvidence = published.evidence['0.1.0']?.find(item => item.summary.includes('平台绑定修订固定'))
  assert.ok(bindingEvidence, '发布证据缺少绑定修订固定项')
  assert.match(bindingEvidence.summary, /read@1\.0\.0 rev\d+（摘要 [a-f0-9]{12}）/)

  const agentRows = await agents.getAgents()
  const agent = agentRows.find(item => item.id === agentId)
  assert.equal(agent?.status, 'published')

  const after = await release.getReleaseState(agentId)
  assert.equal(after.candidate, undefined)
  assert.equal(after.evidence['0.1.0']?.length, 6)

  const records = await agents.getReleaseRecords()
  assert.ok(records.some(item => item.agentId === agentId && item.action === 'published'))
})

test('定义修改推进修订并作废检查与封存，发布要求最新封存试运行通过', async () => {
  const agentId = 'agent-release-revision'
  await createDraftAgent(agentId)
  await release.ensureCandidate(agentId, ADMIN)
  await release.runChecks(agentId, ADMIN)
  await release.startTrial(agentId, ADMIN)
  const trialed = await confirmLatestTrial(agentId)
  assert.equal(trialed.trialRuns[0]?.status, 'passed')

  // 修改定义 → 修订推进、封存与检查作废。
  await agents.updateAgent({
    agentId,
    name: '退款预测助手',
    description: '基于历史退款记录预测高风险订单并给出处理建议（修订版）。',
    owner: '发布管理员',
    department: '平台治理',
    visibility: '指定角色',
    roleIds: ['role-employee'],
    dataScopes: ['workspace:authorized'],
    welcomeMessage: '',
    examplePrompts: ['评估本周退款风险订单'],
    systemPrompt: '你是退款预测助手。基于已授权的历史退款与订单数据评估风险，只输出风险等级与依据。',
    maxOutputBytes: 65536, maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: ['skill-document@1.0.0'],
    tools: ['read@1.0.0'],
    changeSummary: '更新说明',
    actor: ADMIN,
  })
  // GET 只读：只标记漂移，不推进修订
  const stale = await release.getReleaseState(agentId)
  assert.equal(stale.candidate?.revision, 1)
  assert.equal(stale.definitionChanged, true)

  const refreshed = await release.ensureCandidate(agentId, ADMIN)
  assert.equal(refreshed.candidate?.revision, 2)
  assert.equal(refreshed.candidate?.checks.length, 0)
  assert.equal(refreshed.candidate?.sealedRevision, undefined)

  await assert.rejects(release.publish(agentId, '', ADMIN), /尚未提交审核/)

  await release.runChecks(agentId, ADMIN)
  await release.startTrial(agentId, ADMIN)
  const retrialed = await confirmLatestTrial(agentId)
  assert.equal(retrialed.trialRuns[0]?.status, 'passed')
  assert.equal(retrialed.trialRuns[0]?.submissionRevision, 2)
  await release.submitForReview(agentId, ADMIN)
  const published = await release.publish(agentId, '', ADMIN)
  assert.equal(published.candidate, undefined)
  assert.equal(published.evidence['0.1.0']?.length, 6)
})

test('审核人判定任一案例不符合预期时试运行记为失败并阻塞发布', async () => {
  const agentId = 'agent-release-reject'
  await createDraftAgent(agentId)
  await release.ensureCandidate(agentId, ADMIN)
  await release.runChecks(agentId, ADMIN)
  await release.startTrial(agentId, ADMIN)

  const rejected = await confirmLatestTrial(agentId, 'failed')
  assert.equal(rejected.trialRuns[0]?.status, 'failed')
  assert.equal(rejected.trialRuns[0]?.failureStage, '案例终态断言')
  await assert.rejects(release.submitForReview(agentId, ADMIN), /通过试运行/)
  await assert.rejects(release.publish(agentId, '', ADMIN), /尚未提交审核/)
})

test('案例编辑的 origin 由服务端维护：既有生成案例保留标记，调用方不能伪造或清除', async () => {
  const agentId = 'agent-release-origin'
  await createDraftAgent(agentId)
  const state = await release.ensureCandidate(agentId, ADMIN)
  const generated = state.candidate!.cases
  assert.ok(generated.length > 0)
  assert.ok(generated.every(item => item.origin === 'generated'))

  const updated = await release.updateCases(agentId, [
    // 调用方剥离 origin 原样回写：服务端按既有案例 id 恢复标记
    ...generated.map(item => ({ id: item.id, name: item.name, kind: item.kind, input: item.input, expect: item.expect })),
    // 调用方伪造 origin：服务端忽略
    { id: '', name: '伪造来源案例', kind: 'success' as const, input: '评估退款风险', expect: '输出依据', origin: 'generated' as const },
  ], ADMIN)
  const kept = updated.candidate!.cases.filter(item => generated.some(g => g.id === item.id))
  assert.ok(kept.every(item => item.origin === 'generated'))
  const forged = updated.candidate!.cases.find(item => item.name === '伪造来源案例')
  assert.ok(forged)
  assert.equal(forged.origin, undefined)
})

test('提交审核后候选封存：退回解锁修订推进，发布必须经 submitted', async () => {
  const agentId = 'agent-release-submit'
  await createDraftAgent(agentId)
  await release.ensureCandidate(agentId, ADMIN)
  await release.runChecks(agentId, ADMIN)
  await release.startTrial(agentId, ADMIN)
  await confirmLatestTrial(agentId)

  // 未提交不能发布
  await assert.rejects(release.publish(agentId, '', ADMIN), /尚未提交审核/)

  const submitted = await release.submitForReview(agentId, ADMIN)
  assert.equal(submitted.candidate?.status, 'submitted')

  // 封存：候选内容修改、重新检查、试运行与 ZIP 重导全部拒绝
  await assert.rejects(release.updateCases(agentId, [], ADMIN), /封存/)
  await assert.rejects(release.runChecks(agentId, ADMIN), /封存/)
  await assert.rejects(release.startTrial(agentId, ADMIN), /不能发起试运行/)
  const zip = createZip({
    'agent.yaml': buildAgentYaml({ id: agentId, version: '0.2.0' }),
    'prompts/system.md': PROMPT,
    'evals/cases.yaml': PACKAGE_CASES,
  })
  await assert.rejects(release.importPackage(ADMIN, 'submitted.zip', zip), /提交审核/)

  // 草稿漂移不推进已提交候选的修订；发布按封存指纹复核，漂移内容不能放行
  await agents.updateAgent({
    agentId,
    name: '退款预测助手',
    description: '基于历史退款记录预测高风险订单并给出处理建议（审核期间修改）。',
    owner: '发布管理员',
    department: '平台治理',
    visibility: '指定角色',
    roleIds: ['role-employee'],
    dataScopes: ['workspace:authorized'],
    welcomeMessage: '',
    examplePrompts: ['评估本周退款风险订单'],
    systemPrompt: '你是退款预测助手。基于已授权的历史退款与订单数据评估风险，只输出风险等级与依据。',
    maxOutputBytes: 65536, maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: ['skill-document@1.0.0'],
    tools: ['read@1.0.0'],
    changeSummary: '审核期间修改说明',
    actor: ADMIN,
  })
  const drifted = await release.ensureCandidate(agentId, ADMIN)
  assert.equal(drifted.candidate?.status, 'submitted')
  assert.equal(drifted.candidate?.revision, 1)
  assert.equal(drifted.definitionChanged, true)
  await assert.rejects(release.publish(agentId, '', ADMIN), /封存试运行/)

  // 退回解锁：必须带审核意见；同步后修订推进并回到 draft 重新走流程
  await assert.rejects(release.requestChanges(agentId, '  ', ADMIN), /审核意见/)
  const returned = await release.requestChanges(agentId, '说明文案需完善', ADMIN)
  assert.equal(returned.candidate?.status, 'changes_requested')
  assert.equal(returned.candidate?.reviewNote, '说明文案需完善')
  const resynced = await release.ensureCandidate(agentId, ADMIN)
  assert.equal(resynced.candidate?.status, 'draft')
  assert.equal(resynced.candidate?.revision, 2)
  assert.equal(resynced.candidate?.sealedRevision, undefined)

  await release.runChecks(agentId, ADMIN)
  await release.startTrial(agentId, ADMIN)
  await confirmLatestTrial(agentId)
  await release.submitForReview(agentId, ADMIN)
  const published = await release.publish(agentId, '', ADMIN)
  assert.equal(published.candidate, undefined)
})

test('撤回使候选进入终态并保留历史，再次同步创建新候选', async () => {
  const agentId = 'agent-release-withdraw'
  await createDraftAgent(agentId)
  await release.ensureCandidate(agentId, ADMIN)

  // 未完成试运行不能提交；草稿态候选也不能退回（仅 submitted 可退回）
  await assert.rejects(release.submitForReview(agentId, ADMIN), /通过试运行/)
  await assert.rejects(release.requestChanges(agentId, '草稿阶段退回', ADMIN), /仅待审核状态/)

  const withdrawn = await release.withdrawSubmission(agentId, ADMIN)
  assert.equal(withdrawn.candidate, undefined)
  await assert.rejects(release.publish(agentId, '', ADMIN), /没有进行中的发布候选/)
  await assert.rejects(release.withdrawSubmission(agentId, ADMIN), /没有可撤回/)

  const recreated = await release.ensureCandidate(agentId, ADMIN)
  assert.equal(recreated.candidate?.status, 'draft')
  assert.equal(recreated.candidate?.revision, 1)
})

// ---------------------------------------------------------------------------
// ZIP 导入主线：包内案例权威、缺省案例兜底、缺失依赖与包内候选阻塞
// ---------------------------------------------------------------------------

test('ZIP 发布包导入落草稿与候选，包内案例作为试运行案例', async () => {
  const zip = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-zip' }),
    'prompts/system.md': PROMPT,
    'evals/cases.yaml': PACKAGE_CASES,
  })
  const state = await release.importPackage(ADMIN, 'refund-agent.zip', zip)
  const candidate = state.candidate
  assert.ok(candidate)
  assert.equal(candidate.source, 'zip')
  assert.equal(candidate.version, '0.1.0')
  assert.deepEqual(candidate.cases.map(item => item.name), ['正常预测', '缺少周期', '越权数据'])
  assert.deepEqual(candidate.missingDeps.tools, [])
  assert.ok(state.packageWarnings.length >= 0)

  const checked = await release.runChecks('agent-release-zip', ADMIN)
  assert.ok(checked.candidate?.checks.every(item => item.status === 'passed'), checked.candidate?.checks.map(item => item.detail).join(' | '))
  await release.startTrial('agent-release-zip', ADMIN)
  const trialed = await confirmLatestTrial('agent-release-zip')
  assert.equal(trialed.trialRuns[0]?.status, 'passed')
  await release.submitForReview('agent-release-zip', ADMIN)
  const published = await release.publish('agent-release-zip', '', ADMIN)
  assert.equal(published.candidate, undefined)
  assert.equal(published.evidence['0.1.0']?.length, 6)
  const publishedAgents = await agents.getAgents()
  assert.equal(publishedAgents.find(item => item.id === 'agent-release-zip')?.status, 'published')
})

async function publishReviewedDraft(agentId: string) {
  await release.ensureCandidate(agentId, ADMIN)
  const checked = await release.runChecks(agentId, ADMIN)
  assert.ok(checked.candidate?.checks.every(item => item.status === 'passed'), checked.candidate?.checks.map(item => item.detail).join(' | '))
  await release.startTrial(agentId, ADMIN)
  await confirmLatestTrial(agentId)
  await release.submitForReview(agentId, ADMIN)
  await release.publish(agentId, '回归测试逐项确认', ADMIN)
}

test('导入定义经配置保存及发布后分叉保留未编辑字段，已发布定义不变', async () => {
  const agentId = 'agent-release-preserve-spec'
  const imported = await release.importPackage(ADMIN, 'preserve-spec.zip', createZip({
    'agent.yaml': buildAgentYaml({
      id: agentId,
      instructions: 'prompts/custom.md',
      specLines: [
        '    skills: [{ id: skill-document, version: 1.0.0 }]',
        '  catalog:',
        '    welcomeMessage: 欢迎使用退款预测助手',
        '    examplePrompts: [评估本周退款风险]',
        '  model:',
        '    requirements: [long-context, structured-output]',
        '  evaluation:',
        '    cases: evals/custom.yaml',
      ],
    }),
    'prompts/custom.md': PROMPT,
    'evals/custom.yaml': PACKAGE_CASES,
  }))
  assert.ok(imported.candidate)
  const readSpec = async (version: string) => {
    const [row] = await database<{ spec: AgentSpec }[]>`
      select agent_spec as spec from agent_versions
       where tenant_id = ${tenantId} and agent_id = ${agentId} and version = ${version}
    `
    assert.ok(row)
    return row.spec
  }
  const original = await readSpec('0.1.0')
  const { agent } = await agents.getMutationSnapshot(agentId)
  const description = `${agent.description}更新说明。`
  const saved = await agents.updateAgent({ ...agent, agentId, description, actor: ADMIN, changeSummary: '只更新说明' })
  const savedSpec = await readSpec('0.1.0')
  assert.deepEqual(savedSpec, { ...original, metadata: { ...original.metadata, description } })

  await publishReviewedDraft(agentId)
  const systemPrompt = `${PROMPT}请标注每项结论的数据来源。`
  const forked = await agents.updateAgent({ ...saved.agent, agentId, systemPrompt, actor: ADMIN, changeSummary: '新版本调整指令' })
  assert.equal(forked.version.version, '0.2.0')
  assert.deepEqual(await readSpec('0.2.0'), {
    ...savedSpec,
    metadata: { ...savedSpec.metadata, version: '0.2.0' },
    instructions: { ...savedSpec.instructions, body: systemPrompt },
  })
  assert.deepEqual(await readSpec('0.1.0'), savedSpec, '分叉不能改写已发布定义')
})

test('回滚后导入继承当前活动版本的角色与数据范围，重复导入保留草稿配置', async () => {
  const agentId = 'agent-release-import-rollback'
  const created = await createDraftAgent(agentId)
  const restricted = await agents.updateAgent({
    ...created.agent, agentId, roleIds: ['role-platform-admin'], dataScopes: ['workspace:authorized'],
    actor: ADMIN, changeSummary: '限制初始版本授权',
  })
  await publishReviewedDraft(agentId)
  await agents.updateAgent({
    ...restricted.agent, agentId, roleIds: ['role-employee'], dataScopes: ['enterprise:authorized', 'workspace:authorized'],
    actor: ADMIN, changeSummary: '新版本调整授权',
  })
  await publishReviewedDraft(agentId)
  await agents.rollback({ agentId, version: '0.1.0', actor: ADMIN })

  const importVersion = (version: string) => release.importPackage(ADMIN, `${version}.zip`, createZip({
    'agent.yaml': buildAgentYaml({ id: agentId, version }),
    'prompts/system.md': PROMPT,
    'evals/cases.yaml': PACKAGE_CASES,
  }))
  await importVersion('0.3.0')
  const firstDraft = (await agents.getMutationSnapshot(agentId)).agent
  assert.deepEqual(firstDraft.roleIds, ['role-platform-admin'])
  assert.deepEqual(firstDraft.dataScopes, ['workspace:authorized'])
  const [active] = await database<{ version: string }[]>`
    select av.version from agents a
      join agent_versions av on av.tenant_id = a.tenant_id and av.id = a.active_version_id
     where a.tenant_id = ${tenantId} and a.id = ${agentId}
  `
  assert.equal(active?.version, '0.1.0', '导入不能切换活动版本')

  await agents.updateAgent({
    ...firstDraft, agentId, roleIds: ['role-employee'], dataScopes: ['enterprise:authorized', 'workspace:authorized'],
    skills: ['skill-document@1.0.0'], examplePrompts: ['评估本周退款风险'],
    actor: ADMIN, changeSummary: '管理员调整草稿授权',
  })
  await importVersion('0.4.0')
  const reimported = (await agents.getMutationSnapshot(agentId)).agent
  assert.deepEqual(reimported.roleIds, ['role-employee'])
  assert.deepEqual(reimported.dataScopes, ['enterprise:authorized', 'workspace:authorized'])
})

test('ZIP 缺少 evals/cases.yaml 时自动生成三类默认案例，不因缺文件失败', async () => {
  const zip = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-nocases' }),
    'prompts/system.md': PROMPT,
  }, { checksums: false })
  const state = await release.importPackage(ADMIN, 'no-cases.zip', zip)
  assert.equal(state.candidate?.cases.length, 3)
  assert.deepEqual(
    state.candidate?.cases.map(item => item.kind).sort(),
    ['invalid_input', 'permission_denied', 'success'],
  )

  // 缺少 checksums.json 的包允许导入（留有警告），但「文件与摘要完整性」检查不得放行。
  const checked = await release.runChecks('agent-release-nocases', ADMIN)
  const filesCheck = checked.candidate?.checks.find(item => item.id === 'files')
  assert.equal(filesCheck?.status, 'failed')
  assert.match(filesCheck?.detail ?? '', /checksums\.json/)
})

test('checksums.json 必须精确覆盖包内文件集合，版本号拒绝预发布后缀', async () => {
  const base = {
    'agent.yaml': buildAgentYaml({ id: 'agent-checksums' }),
    'prompts/system.md': PROMPT,
    'evals/cases.yaml': PACKAGE_CASES,
  }
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  const manifestFor = (table: Record<string, string>) => JSON.stringify({ files: table })
  const fullTable = Object.fromEntries(Object.entries(base).map(([path, text]) => [path, digest(text)]))

  // 缺条目：清单未覆盖全部文件
  const missingEntry = { ...fullTable }
  delete missingEntry['evals/cases.yaml']
  await assert.rejects(
    release.inspectPackage('missing-entry.zip', createZip({ ...base, 'checksums.json': manifestFor(missingEntry) })),
    /checksums\.json 未覆盖全部文件/,
  )
  // 多条目：清单列出包内不存在的文件
  await assert.rejects(
    release.inspectPackage('extra-entry.zip', createZip({ ...base, 'checksums.json': manifestFor({ ...fullTable, 'ghost.md': digest('x') }) })),
    /checksums\.json 列出的 ghost\.md 在包内不存在/,
  )
  // 摘要错误
  await assert.rejects(
    release.inspectPackage('wrong-digest.zip', createZip({ ...base, 'checksums.json': manifestFor({ ...fullTable, 'prompts/system.md': digest('tampered') }) })),
    /摘要与 checksums\.json 不一致/,
  )
  // 版本号预发布/构建后缀：排序 SQL 会把第 3 段转整数，必须拒绝
  await assert.rejects(
    release.inspectPackage('prerelease.zip', createZip({ ...base, 'agent.yaml': buildAgentYaml({ id: 'agent-checksums', version: '1.0.0-rc.1' }) })),
    /metadata\.version must match pattern/,
  )
})

test('声明依赖未接入时标记缺失并阻塞检查与发布，移除引用后放行', async () => {
  const zip = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-missing', tools: 'read@1.0.0, knowledge.search@1.0.0' }),
    'prompts/system.md': PROMPT,
    'evals/cases.yaml': PACKAGE_CASES,
  })
  const state = await release.importPackage(ADMIN, 'missing.zip', zip)
  assert.deepEqual(state.candidate?.missingDeps.tools, ['knowledge.search@1.0.0'])

  const checked = await release.runChecks('agent-release-missing', ADMIN)
  const deps = checked.candidate?.checks.find(item => item.id === 'deps')
  assert.equal(deps?.status, 'failed')
  assert.match(deps?.detail ?? '', /knowledge\.search/)
  await assert.rejects(
    release.startTrial('agent-release-missing', ADMIN),
    /试运行被阻塞/,
  )

  const updated = await release.removeMissingDependency('agent-release-missing', 'tools', 'knowledge.search@1.0.0', ADMIN)
  assert.equal(updated.candidate?.revision, 2)
  assert.deepEqual(updated.candidate?.missingDeps.tools, [])

  const rechecked = await release.runChecks('agent-release-missing', ADMIN)
  assert.ok(rechecked.candidate?.checks.every(item => item.status === 'passed'))
})

test('声明工具版本与平台可用版本不一致标记缺失，不静默改写为平台版本', async () => {
  const zip = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-toolver', tools: 'read@9.9.9' }),
    'prompts/system.md': PROMPT,
  })
  const info = await release.inspectPackage('toolver.zip', zip)
  assert.deepEqual(info.missing.tools, ['read@9.9.9'])
  assert.deepEqual(info.resolved.tools, [])

  const state = await release.importPackage(ADMIN, 'toolver.zip', zip)
  assert.deepEqual(state.candidate?.missingDeps.tools, ['read@9.9.9'])
  const checked = await release.runChecks('agent-release-toolver', ADMIN)
  const deps = checked.candidate?.checks.find(item => item.id === 'deps')
  assert.equal(deps?.status, 'failed')
  assert.match(deps?.detail ?? '', /read@9\.9\.9/)
})

test('包内 Tool 候选阻塞测试授权检查与发布放行', async () => {
  const zip = createZip({
    'agent.yaml': buildAgentYaml({
      id: 'agent-release-pkgtool',
      tools: 'read@1.0.0, refund-risk-score@0.1.0',
    }),
    'prompts/system.md': PROMPT,
    'evals/cases.yaml': PACKAGE_CASES,
    'tools/refund-risk-score/tool.yaml': 'id: refund-risk-score\nversion: 0.1.0\nname: 退款风险评分\n',
  })
  const state = await release.importPackage(ADMIN, 'pkg-tool.zip', zip)
  assert.equal(state.candidate?.packageRefs.tools[0]?.id, 'refund-risk-score')
  assert.deepEqual(state.candidate?.missingDeps.tools, [])

  const checked = await release.runChecks('agent-release-pkgtool', ADMIN)
  const admission = checked.candidate?.checks.find(item => item.id === 'admission')
  assert.equal(admission?.status, 'failed')
  assert.match(admission?.detail ?? '', /refund-risk-score/)
  await assert.rejects(
    release.publish('agent-release-pkgtool', '', ADMIN),
    /包内 Tool 候选尚未完成平台内准入/,
  )
})

test('ZIP 重复导入同内容幂等返回，同版本不同内容明确版本冲突', async () => {
  const zip = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-idem' }),
    'prompts/system.md': PROMPT,
    'evals/cases.yaml': PACKAGE_CASES,
  })
  const first = await release.importPackage(ADMIN, 'idem.zip', zip)
  assert.equal(first.candidate?.revision, 1)
  const packageCount = async () => (await database<{ count: number }[]>`
    select count(*)::integer as count from agent_packages where tenant_id = ${tenantId} and agent_id = 'agent-release-idem'
  `)[0]?.count
  assert.equal(await packageCount(), 1)

  // 同包重导：不新建包、不推进修订，返回既有治理状态
  const again = await release.importPackage(ADMIN, 'idem.zip', zip)
  assert.equal(again.candidate?.revision, 1)
  assert.equal(await packageCount(), 1)

  // 同版本不同内容：明确 409 冲突，不自动改写声明版本
  const altered = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-idem' }),
    'prompts/system.md': `${PROMPT}（改）`,
    'evals/cases.yaml': PACKAGE_CASES,
  })
  await assert.rejects(
    release.importPackage(ADMIN, 'idem.zip', altered),
    /已导入过内容不同的发布包|version_conflict/,
  )
  assert.equal(await packageCount(), 1)

  // 同版本但配置路径创建的 Agent（无包记录）：同样明确冲突而非自动升版本
  await createDraftAgent('agent-release-cfgver')
  const cfgZip = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-cfgver', version: '9.9.9' }),
    'prompts/system.md': PROMPT,
  })
  // 先以 9.9.9 导入占据版本，再以同号不同内容重导 → 冲突
  await release.importPackage(ADMIN, 'cfg.zip', cfgZip)
  const cfgAltered = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-cfgver', version: '9.9.9' }),
    'prompts/system.md': `${PROMPT}（内容已变更的另一套提示词）`,
  })
  await assert.rejects(release.importPackage(ADMIN, 'cfg.zip', cfgAltered), /不同内容|version_conflict/)
})

test('inspectPackage 只解析不落库', async () => {
  const zip = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-inspect', tools: 'read@1.0.0, ghost.tool@1.0.0' }),
    'prompts/system.md': PROMPT,
  })
  const info = await release.inspectPackage('inspect.zip', zip)
  assert.equal(info.manifest.id, 'agent-release-inspect')
  assert.deepEqual(info.missing.tools, ['ghost.tool@1.0.0'])

  const agentsList = await agents.getAgents()
  assert.ok(!agentsList.some(item => item.id === 'agent-release-inspect'))
  const submissions = await release.listSubmissions()
  assert.ok(!submissions.some(item => item.agentId === 'agent-release-inspect'))
})

// ---------------------------------------------------------------------------
// I-02 包字段规则：受管字段/结构化清单拒绝、别名冲突拒绝、声明与包内版本冲突
// 拒绝、未识别字段警告留痕（不静默忽略）
// ---------------------------------------------------------------------------

test('平台受管字段与旧扁平清单在解析期拒绝', async () => {
  const reserved = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-denied', topLines: ['api_key: sk-test'] }),
    'prompts/system.md': PROMPT,
  })
  await assert.rejects(release.inspectPackage('denied.zip', reserved), /平台受管字段：api_key/)

  const legacy = createZip({
    'agent.yaml': ['id: agent-release-denied', 'name: 退款预测助手', 'version: 0.1.0', 'description: 基于历史退款记录预测高风险订单。', 'system_prompt_file: prompts/system.md', ''].join('\n'),
    'prompts/system.md': PROMPT,
  })
  await assert.rejects(release.inspectPackage('legacy.zip', legacy), /旧扁平清单字段|apiVersion/)

  await assert.rejects(release.importPackage(ADMIN, 'denied.zip', reserved), /平台受管字段：api_key/)
  const agentsList = await agents.getAgents()
  assert.ok(!agentsList.some(item => item.id === 'agent-release-denied'))
})

test('声明版本与包内候选版本冲突拒绝导入', async () => {
  const zip = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-depconflict', tools: 'refund-risk-score@0.2.0' }),
    'prompts/system.md': PROMPT,
    'tools/refund-risk-score/tool.yaml': 'id: refund-risk-score\nversion: 0.1.0\nname: 退款风险评分\n',
  })
  await assert.rejects(
    release.importPackage(ADMIN, 'dep-conflict.zip', zip),
    /声明的 Tool refund-risk-score@0\.2\.0 与包内 tools\/refund-risk-score 候选版本 0\.1\.0 冲突/,
  )
  const agentsList = await agents.getAgents()
  assert.ok(!agentsList.some(item => item.id === 'agent-release-depconflict'))
})

test('旧别名与未识别字段在严格 Schema 下直接拒绝导入', async () => {
  const conflict = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-alias', topLines: ['display_name: 另一个名称'] }),
    'prompts/system.md': PROMPT,
  })
  await assert.rejects(release.inspectPackage('alias.zip', conflict), /未定义字段 display_name|结构校验未通过/)

  const unknown = createZip({
    'agent.yaml': buildAgentYaml({ id: 'agent-release-unknown', topLines: ['author: ops-team'] }),
    'prompts/system.md': PROMPT,
    'evals/cases.yaml': PACKAGE_CASES,
  })
  await assert.rejects(release.importPackage(ADMIN, 'unknown.zip', unknown), /未定义字段 author|结构校验未通过/)
  const agentsList = await agents.getAgents()
  assert.ok(!agentsList.some(item => item.id === 'agent-release-alias'))
  assert.ok(!agentsList.some(item => item.id === 'agent-release-unknown'))
})

// 试运行桩 Runtime：模拟 DSH 终态事件流，验证试运行走的是真实 Run/Attempt 编排链路。
interface TrialExecution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
  resolve: (snapshot: RuntimeExecutionSnapshot) => void
}

class TrialStubRuntime implements AgentRuntimePort {
  private readonly executions = new Map<string, TrialExecution>()
  /** 测试可让指定输入失败（断言负路径）。 */
  failOnMessage = ''

  /** 已派发 Attempt 的固化 Manifest：用于断言 tool_bindings 等执行期固定引用。 */
  manifest(runId: string) {
    return this.executions.get(runId)?.manifest
  }

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => { resolveDone = resolve })
    const now = new Date().toISOString()
    const execution: TrialExecution = {
      manifest, events: [], listeners: new Set(),
      snapshot: {
        runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'queued', acceptedAt: now,
        startedAt: null, endedAt: null, manifestSha256: 'test', attemptDirectory: '/tmp/test',
        errorCode: null, errorMessage: null,
      },
      resolve: resolveDone,
    }
    this.executions.set(manifest.run_id, execution)
    this.emit(execution, 'run.queued', '已排队')
    setTimeout(() => {
      execution.snapshot.status = 'running'
      execution.snapshot.startedAt = new Date().toISOString()
      this.emit(execution, 'run.started', '已启动')
      if (this.failOnMessage && manifest.input.message === this.failOnMessage) {
        this.emit(execution, 'assistant.delta', '失败前的部分输出')
        this.emit(execution, 'assistant.completed', '失败前的部分输出')
        execution.snapshot.status = 'failed'
        execution.snapshot.errorCode = 'TRIAL_FAILED'
        this.emit(execution, 'run.failed', '试运行案例执行失败', { error_code: 'TRIAL_FAILED' })
        this.finish(execution)
        return
      }
      this.emit(execution, 'assistant.delta', `试运行回答：${manifest.input.message}`)
      this.emit(execution, 'assistant.completed', `试运行回答：${manifest.input.message}`)
      execution.snapshot.status = 'completed'
      this.emit(execution, 'run.completed', '已完成')
      this.finish(execution)
    }, 10)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener) {
    const execution = this.executions.get(runId)
    if (!execution) throw new Error('Run not found')
    execution.events.forEach(listener)
    execution.listeners.add(listener)
    return () => execution.listeners.delete(listener)
  }

  async cancel(runId: string) {
    const execution = this.executions.get(runId)
    if (!execution || ['completed', 'cancelled', 'failed'].includes(execution.snapshot.status)) return { accepted: false }
    this.emit(execution, 'run.cancel_requested', '正在取消')
    execution.snapshot.status = 'cancelled'
    this.emit(execution, 'run.cancelled', '已取消')
    this.finish(execution)
    return { accepted: true }
  }

  status(runId: string) { return this.executions.get(runId)?.snapshot }
  async health() {
    return { status: 'healthy' as const, runtimeId: 'runtime-local-01', activeExecutions: 0, acceptingRuns: true, dshRepository: '/tmp', transport: 'acp-stdio' as const, message: 'test' }
  }
  async close() { return undefined }

  private emit(execution: TrialExecution, eventType: RuntimeEvent['event_type'], display: string, safeMetadata: Record<string, unknown> = {}) {
    const event: RuntimeEvent = {
      event_id: randomUUID(), run_id: execution.manifest.run_id, attempt_id: execution.manifest.attempt_id,
      sequence: execution.events.length + 1, event_type: eventType, occurred_at: new Date().toISOString(),
      display_message: display, safe_metadata: safeMetadata, trace_id: `trace-${execution.manifest.run_id}`,
      parent_event_id: execution.events.at(-1)?.event_id ?? null,
    }
    execution.events.push(event)
    execution.listeners.forEach(listener => listener(event))
  }

  private finish(execution: TrialExecution) {
    execution.snapshot.endedAt = new Date().toISOString()
    execution.resolve(structuredClone(execution.snapshot))
  }
}

// ---------------------------------------------------------------------------
// B-03/I-04：真实绑定修订——封存依据、Attempt 固定、漂移拒绝与发布追溯
// ---------------------------------------------------------------------------

test('平台工具绑定经真实修订封存：Attempt 固定 pin，漂移后发布被拒绝', async () => {
  const agentId = 'agent-release-binding'
  await createDraftAgent(agentId)
  await release.ensureCandidate(agentId, ADMIN)

  // 检查与计划含真实绑定修订：不再是固定占位文本。
  const checked = await release.runChecks(agentId, ADMIN)
  const bindingCheck = checked.candidate?.checks.find(item => item.id === 'binding')
  assert.equal(bindingCheck?.status, 'passed')
  assert.match(bindingCheck?.detail ?? '', /read@1\.0\.0 rev1/)
  const bindingPlan = checked.candidate?.plan.find(item => item.kind === 'binding' && item.name === 'read@1.0.0')
  assert.ok(bindingPlan, '发布计划缺少真实绑定项')
  assert.equal(bindingPlan.action, 'create')
  assert.equal(bindingPlan.version, 'rev1')
  assert.match(bindingPlan.detail, /摘要 [a-f0-9]{12}/)

  // 封存：候选携带真实 pin（binding_id + revision + 摘要）。
  const trialed = await release.startTrial(agentId, ADMIN)
  const pins = trialed.candidate?.bindingRefs ?? []
  assert.equal(pins.length, 1)
  assert.equal(pins[0]?.tool, 'read@1.0.0')
  assert.equal(pins[0]?.revision, 1)
  assert.match(pins[0]?.binding_id ?? '', /^tool-binding-/)
  assert.match(pins[0]?.digest ?? '', /^[a-f0-9]{64}$/)

  // Attempt Manifest 固定的正是封存 pin：执行证据与封存依据同源。
  const caseRun = trialed.trialRuns[0]?.steps.flatMap(step => step.caseRuns ?? [])[0]
  assert.ok(caseRun?.runId)
  const manifest = trialRuntime.manifest(caseRun.runId!)
  assert.deepEqual(manifest?.tool_bindings, pins)

  const confirmed = await confirmLatestTrial(agentId)
  assert.equal(confirmed.trialRuns[0]?.status, 'passed')
  await release.submitForReview(agentId, ADMIN)

  // 封存后绑定语义漂移（授权范围收窄）：当前修订被取代，发布拒绝旧证据。
  await tools.updateToolPermissions({
    toolId: 'read',
    allowedRoles: ['role-platform-admin'],
    dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none',
    actor: ADMIN,
  })
  await assert.rejects(release.publish(agentId, '', ADMIN), /绑定修订已失效|重新封存/)

  // 漂移后退回并重新走封存-试运行-发布：先恢复兼容的授权范围（又一次修订
  // 轮换），新修订集成为依据并成功发布。
  await release.requestChanges(agentId, '绑定修订已漂移，退回重新封存', ADMIN)
  await tools.updateToolPermissions({
    toolId: 'read',
    allowedRoles: ['role-employee'],
    dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none',
    actor: ADMIN,
  })
  const rechecked = await release.runChecks(agentId, ADMIN)
  assert.equal(rechecked.candidate?.checks.find(item => item.id === 'binding')?.status, 'passed')
  await release.startTrial(agentId, ADMIN)
  const repins = (await release.getReleaseState(agentId)).candidate?.bindingRefs ?? []
  assert.equal(repins.length, 1)
  assert.equal(repins[0]?.revision, 3)
  await confirmLatestTrial(agentId)
  await release.submitForReview(agentId, ADMIN)
  const published = await release.publish(agentId, '绑定修订复核通过', ADMIN)
  assert.equal(published.candidate, undefined)

  // 已发布版本记录携带真实绑定依据，前端与追溯不再需要占位值。
  const versions = await agents.getAgentVersions()
  const record = versions.find(item => item.agentId === agentId && item.version === '0.1.0')
  assert.deepEqual(record?.bindingRefs, repins)
})
