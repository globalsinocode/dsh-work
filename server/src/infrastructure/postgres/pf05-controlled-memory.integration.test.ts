import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresControlledMemoryService } from '../../modules/memory/postgres-controlled-memory-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { PostgresTaskRepository, platformToolOperationKey, taskOperationParameterDigest } from '../../modules/task/postgres-task-repository.ts'
import { compileRuntimeManifest } from '../../modules/runtime/manifest-compiler.ts'
import type { JsonObject } from '../../modules/run/run-types.ts'
import type { RuntimeManifest } from '../../modules/runtime/runtime-types.ts'

const tenantId = 'tenant-dsh-work'
let database: DatabaseClient
let throwaway: ThrowawayDatabase
let runs: PostgresRunRepository
let tasks: PostgresTaskRepository
let memory: PostgresControlledMemoryService
let authorization: PostgresAuthorizationService

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_pf05_memory', maxConnections: 6 })
  database = throwaway.client
  runs = new PostgresRunRepository(database)
  tasks = new PostgresTaskRepository(database)
  authorization = new PostgresAuthorizationService(database)
  memory = new PostgresControlledMemoryService(database, authorization)
})

after(async () => { await throwaway.dispose() })

test('PF-05 requires explicit consent and review, then fixes a retrievable version with provenance', async () => {
  const source = await succeededFixture('private-memory')
  const submissionKey = `memory-submit-${randomUUID()}`
  const candidate = await memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey,
    kind: 'preference', title: '分析报告展示偏好',
    content: '生成分析报告时，优先使用简洁表格，并在结论后明确列出仍待确认的数据。',
    visibility: 'private', retentionDays: 30,
  })
  assert.equal(candidate.status, 'pending')
  assert.deepEqual(await memory.resolveContext({
    query: '生成分析报告', userId: 'U00001', workspaceId: source.manifest.workspace_id,
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
  }), [], 'unreviewed content must not enter Runtime context')

  const replay = await memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey,
    kind: 'preference', title: '分析报告展示偏好',
    content: '生成分析报告时，优先使用简洁表格，并在结论后明确列出仍待确认的数据。',
    visibility: 'private', retentionDays: 30,
  })
  assert.equal(replay.id, candidate.id)
  await assert.rejects(
    memory.submitCandidate({
      userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey,
      kind: 'preference', title: '分析报告展示偏好',
      content: '生成分析报告时，优先使用简洁表格，并在结论后明确列出仍待确认的数据。',
      visibility: 'private', retentionDays: 31,
    }),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error
      && error.code === 'MEMORY_SUBMISSION_CONFLICT',
    'changing a consent parameter must not be accepted as an idempotent replay',
  )

  const approved = await memory.reviewCandidate({
    candidateId: candidate.id, decision: 'approved', actor: 'U00001',
    resolutionKey: `review-${randomUUID()}`, comment: '内容是稳定偏好，不是业务事实。',
  })
  assert.ok(approved.approvedVersionId)
  const resolved = await memory.resolveContext({
    query: '请生成分析报告并列出待确认数据', userId: 'U00001', workspaceId: source.manifest.workspace_id,
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
  })
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0]?.memoryVersionId, approved.approvedVersionId)
  assert.equal(resolved[0]?.visibility, 'private')
  await memory.assertCurrentReferences({
    memory_context: resolved,
    user_context: source.manifest.user_context,
    workspace_id: source.manifest.workspace_id,
    agent_version_id: source.manifest.agent_version_id,
  })

  const revision = await memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey: `memory-submit-${randomUUID()}`,
    kind: 'preference', title: '分析报告展示偏好',
    content: '生成分析报告时，先给简洁结论表格，再单独列出数据日期、限制和所有待确认项。',
    visibility: 'private', retentionDays: 30,
  })
  const revised = await memory.reviewCandidate({
    candidateId: revision.id, decision: 'approved', actor: 'U00001',
    resolutionKey: `review-${randomUUID()}`, comment: '发布同一逻辑记忆的新版本。',
  })
  assert.notEqual(revised.approvedVersionId, approved.approvedVersionId)
  const latest = await memory.resolveContext({
    query: '请生成分析报告并列出待确认数据', userId: 'U00001', workspaceId: source.manifest.workspace_id,
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
  })
  assert.ok(latest.some(item => item.memoryVersionId === revised.approvedVersionId), 'new Attempts use the current version')
  assert.equal(latest.some(item => item.memoryVersionId === approved.approvedVersionId), false)
  await memory.assertCurrentReferences({
    memory_context: resolved,
    user_context: source.manifest.user_context,
    workspace_id: source.manifest.workspace_id,
    agent_version_id: source.manifest.agent_version_id,
  })

  await database`
    insert into run_memory_sources (id, tenant_id, run_id, attempt_id, memory_version_id, relevance_score, excerpt)
    values (${`run-memory-${randomUUID()}`}, ${tenantId}, ${source.runId}, ${source.manifest.attempt_id},
            ${approved.approvedVersionId}, 10, ${resolved[0]!.excerpt})
  `
  const answer = await memory.addCitationFooter(source.manifest.attempt_id, '报告已生成。')
  assert.match(answer, /受控记忆参考（非权威业务事实）/)
  assert.match(answer, /分析报告展示偏好/)
})

test('PF-05 serializes concurrent submissions with the same idempotency key', async () => {
  const source = await succeededFixture('concurrent-submission')
  const submissionKey = `memory-submit-${randomUUID()}`
  const request = {
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey,
    kind: 'experience' as const, title: '并发提交复用经验',
    content: '相同请求即使同时到达，也只能创建一份来源同意和一份待审核的受控记忆候选。',
    visibility: 'private' as const, retentionDays: 30,
  }
  const [first, second] = await Promise.all([
    memory.submitCandidate(request),
    memory.submitCandidate(request),
  ])
  assert.equal(second.id, first.id)
  const [counts] = await database<{ candidateCount: number; consentCount: number }[]>`
    select
      (select count(*)::integer from memory_candidates
        where tenant_id = ${tenantId} and submitted_by = 'U00001' and submission_key = ${submissionKey}) as "candidateCount",
      (select count(*)::integer from memory_consents
        where tenant_id = ${tenantId} and source_attempt_id = ${source.manifest.attempt_id}) as "consentCount"
  `
  assert.deepEqual(counts, { candidateCount: 1, consentCount: 1 })
})

test('AE-04 stages an Agent proposal but requires requester consent and admin review before use', async () => {
  const source = await succeededFixture('agent-proposal', 'ws-personal-U00001', 'agent-version-dsh-work-assistant-1', 'running')
  const proposalInput = {
    kind: 'experience' as const, title: '核对资料的顺序',
    content: '整理资料时，先核对来源和日期，再区分已经验证的事实与尚待确认的假设。',
  }
  await assert.rejects(memory.proposeFromAttempt(proposalInput, { ...source.manifest, tools: [] }, new AbortController().signal),
    'an Agent version without the intrinsic tool cannot stage memory')
  await database`
    update execution_principals set status = 'disabled'
     where tenant_id = ${tenantId} and id = ${source.manifest.principal_context!.executed_as}
  `
  try {
    await assert.rejects(memory.proposeFromAttempt(proposalInput, source.manifest, new AbortController().signal),
      'a disabled Agent identity cannot stage memory')
  } finally {
    await database`
      update execution_principals set status = 'active'
       where tenant_id = ${tenantId} and id = ${source.manifest.principal_context!.executed_as}
    `
  }
  const first = await memory.proposeFromAttempt(proposalInput, source.manifest, new AbortController().signal)
  const trial = await memory.proposeFromAttempt(proposalInput, {
    ...source.manifest, purpose: 'agent-release-trial', workspace_id: '',
  }, new AbortController().signal)
  assert.equal(trial.status, 'trial_only', 'release trials cannot persist personal proposals')
  const replay = await memory.proposeFromAttempt(proposalInput, source.manifest, new AbortController().signal)
  assert.equal(replay.proposalId, first.proposalId)
  assert.equal(first.status, 'pending_human_consent')
  await assert.rejects(memory.listOwnProposals('U00002', source.manifest.attempt_id))
  await assert.rejects(memory.listOwnProposals('U00001', source.manifest.attempt_id),
    'a running attempt cannot expose proposals to the employee yet')
  await runs.transitionAttempt(tenantId, source.manifest.attempt_id, 'succeeded')
  await runs.transitionRun(tenantId, source.runId, 'succeeded')
  const listed = await memory.listOwnProposals('U00001', source.manifest.attempt_id)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.id, first.proposalId)
  assert.deepEqual(await memory.resolveContext({
    query: '核对资料', userId: 'U00001', workspaceId: source.manifest.workspace_id,
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
  }), [], 'an Agent proposal cannot directly enter future context')
  await assert.rejects(memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey: `wrong-${randomUUID()}`,
    ...proposalInput, content: `${proposalInput.content}已修改`, visibility: 'private', retentionDays: 30,
    proposalId: first.proposalId,
  }), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'MEMORY_PROPOSAL_CONFLICT')
  const candidate = await memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey: `consent-${randomUUID()}`,
    ...proposalInput, visibility: 'private', retentionDays: 30, proposalId: first.proposalId,
  })
  assert.equal(candidate.status, 'pending')
  assert.deepEqual(await memory.listOwnProposals('U00001', source.manifest.attempt_id), [], 'submitted text is no longer offered as a draft')
  const [redactedProposal] = await database<{ content: string }[]>`
    select content from memory_proposals where tenant_id = ${tenantId} and id = ${first.proposalId}
  `
  assert.match(redactedProposal?.content ?? '', /内容已撤回或超过可使用期限/)
  await assert.rejects(memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey: `second-${randomUUID()}`,
    ...proposalInput, visibility: 'private', retentionDays: 30, proposalId: first.proposalId,
  }), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'MEMORY_PROPOSAL_CONFLICT')
  assert.deepEqual(await memory.resolveContext({
    query: '核对资料', userId: 'U00001', workspaceId: source.manifest.workspace_id,
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
  }), [], 'employee consent is still insufficient without admin review')
  await memory.reviewCandidate({ candidateId: candidate.id, decision: 'approved', actor: 'U00001', resolutionKey: `review-${randomUUID()}` })
  assert.equal((await memory.resolveContext({
    query: '核对资料', userId: 'U00001', workspaceId: source.manifest.workspace_id,
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
  })).length, 1)
})

test('AE-04 retries a failed Run with a fresh Attempt-owned proposal operation', async () => {
  const first = await succeededFixture('retry-memory-proposal', 'ws-personal-U00001', 'agent-version-dsh-work-assistant-1', 'running')
  const input = {
    kind: 'experience' as const, title: '失败重试核对经验',
    content: '重试运行时重新核对当前来源、授权和未完成的操作回执。',
  }
  const parameterDigest = taskOperationParameterDigest(input)
  async function accept(manifest: RuntimeManifest) {
    return tasks.acceptOperation({
      tenantId, taskId: manifest.task_id, runId: manifest.run_id, attemptId: manifest.attempt_id,
      operationKey: platformToolOperationKey('propose_memory', parameterDigest, manifest.attempt_id),
      actionType: 'platform-tool-write', actionRef: 'propose_memory', parameterDigest,
      receipt: { callId: 'same-model-call' },
    })
  }
  const firstOperation = await accept(first.manifest)
  assert.equal(firstOperation.created, true)
  const firstProposal = await memory.proposeFromAttempt(input, first.manifest, new AbortController().signal)
  await tasks.resolveOperation({
    tenantId, operationId: firstOperation.operation.id, status: 'completed', receipt: { result: firstProposal },
  })
  await runs.transitionAttempt(tenantId, first.manifest.attempt_id, 'failed', 'TEST_FAILURE')
  await runs.transitionRun(tenantId, first.runId, 'failed')

  const retryManifest: RuntimeManifest = {
    ...first.manifest, attempt_id: `attempt-${randomUUID()}`, created_at: new Date().toISOString(),
  }
  const compiled = compileRuntimeManifest(retryManifest)
  await runs.createAttempt({
    attemptId: retryManifest.attempt_id, tenantId, runId: first.runId, runtimeId: 'runtime-local-01',
    manifest: JSON.parse(compiled.canonicalJson) as JsonObject, manifestSha256: compiled.sha256,
    modelRouteSnapshot: {},
  })
  await runs.transitionAttempt(tenantId, retryManifest.attempt_id, 'running')
  await runs.transitionRun(tenantId, first.runId, 'running')
  const retryOperation = await accept(retryManifest)
  assert.equal(retryOperation.created, true)
  assert.notEqual(retryOperation.operation.id, firstOperation.operation.id)
  const retryProposal = await memory.proposeFromAttempt(input, retryManifest, new AbortController().signal)
  assert.notEqual(retryProposal.proposalId, firstProposal.proposalId)
  await tasks.resolveOperation({
    tenantId, operationId: retryOperation.operation.id, status: 'completed', receipt: { result: retryProposal },
  })
  const replay = await accept(retryManifest)
  assert.equal(replay.created, false)
  assert.equal(replay.operation.id, retryOperation.operation.id)
  await runs.transitionAttempt(tenantId, retryManifest.attempt_id, 'succeeded')
  await runs.transitionRun(tenantId, first.runId, 'succeeded')
  assert.deepEqual((await memory.listOwnProposals('U00001', retryManifest.attempt_id)).map(item => item.id),
    [retryProposal.proposalId])
})

test('AE-04 removes expired, unconsented Agent proposals', async () => {
  const source = await succeededFixture('expiring-proposal', 'ws-personal-U00001', 'agent-version-dsh-work-assistant-1', 'running')
  const created = await memory.proposeFromAttempt({
    kind: 'preference', title: '临时输出偏好', content: '这个尚未获得任何同意的暂存提案到期后，应从平台数据库中删除。',
  }, source.manifest, new AbortController().signal)
  await database`
    update memory_proposals set expires_at = now() - interval '1 second'
     where tenant_id = ${tenantId} and id = ${created.proposalId}
  `
  assert.equal(await memory.purgeExpiredProposals(), 1)
  const [remaining] = await database<{ count: number }[]>`
    select count(*)::integer as count from memory_proposals
     where tenant_id = ${tenantId} and id = ${created.proposalId}
  `
  assert.equal(remaining?.count, 0)
})

test('AE-04 revisions from a newer Agent Version advance one stable memory entry', async () => {
  const oldSource = await succeededFixture('agent-memory-old')
  const original = await memory.submitCandidate({
    userId: 'U00001', attemptId: oldSource.manifest.attempt_id,
    submissionKey: `submit-${randomUUID()}`, kind: 'experience', title: '跨版本核对方法',
    content: '核对分析结论时，先确认数据时间、来源权限和所有未完成的外部操作回执。',
    visibility: 'workspace', retentionDays: 30,
  })
  const first = await memory.reviewCandidate({
    candidateId: original.id, decision: 'approved', actor: 'U00001', resolutionKey: `review-${randomUUID()}`,
  })
  // Upgrade fixture: PF-05 originally keyed a logical memory by Agent Version.
  const legacyKey = createHash('sha256')
    .update(`${oldSource.manifest.agent_version_id}\nexperience\n跨版本核对方法\nworkspace\n${oldSource.manifest.workspace_id}`)
    .digest('hex')
  await database`
    update memory_entries set memory_key = ${legacyKey} where tenant_id = ${tenantId} and id = ${first.approvedEntryId}
  `
  const newSource = await succeededFixture('agent-memory-new', 'ws-personal-U00001', 'agent-version-dsh-work-assistant-output-1')
  const revision = await memory.submitCandidate({
    userId: 'U00001', attemptId: newSource.manifest.attempt_id,
    submissionKey: `submit-${randomUUID()}`, kind: 'experience', title: '跨版本核对方法',
    content: '核对分析结论时，先确认当前数据时间和来源授权，再逐一核对未完成的外部操作回执。',
    visibility: 'workspace', retentionDays: 30,
  })
  const second = await memory.reviewCandidate({
    candidateId: revision.id, decision: 'approved', actor: 'U00001', resolutionKey: `review-${randomUUID()}`,
  })
  assert.equal(second.approvedEntryId, first.approvedEntryId)
  assert.notEqual(second.approvedVersionId, first.approvedVersionId)
  const [version] = await database<{ version: number }[]>`
    select version from memory_versions where tenant_id = ${tenantId} and id = ${second.approvedVersionId}
  `
  assert.equal(version?.version, 2)
  const resolved = await memory.resolveContext({
    query: '跨版本核对方法', userId: 'U00001', workspaceId: newSource.manifest.workspace_id,
    agentVersionId: newSource.manifest.agent_version_id, roleIds: ['role-employee'],
  })
  assert.equal(resolved[0]?.memoryVersionId, second.approvedVersionId)
})

test('AE-04 approves a legacy pending candidate into the stable Agent entry after a newer version', async () => {
  const oldSource = await succeededFixture('agent-memory-pending-old')
  const oldCandidate = await memory.submitCandidate({
    userId: 'U00001', attemptId: oldSource.manifest.attempt_id,
    submissionKey: `submit-${randomUUID()}`, kind: 'experience', title: '跨版本同名经验',
    content: '旧版经验：先核对来源时间和权限，再确认未完成的外部动作回执。',
    visibility: 'workspace', retentionDays: 30,
  })
  const legacyKey = createHash('sha256')
    .update(`${oldSource.manifest.agent_version_id}\nexperience\n跨版本同名经验\nworkspace\n${oldSource.manifest.workspace_id}`)
    .digest('hex')
  await database`
    update memory_candidates set memory_key = ${legacyKey}
     where tenant_id = ${tenantId} and id = ${oldCandidate.id}
  `
  const newSource = await succeededFixture('agent-memory-pending-new', 'ws-personal-U00001', 'agent-version-dsh-work-assistant-output-1')
  const newCandidate = await memory.submitCandidate({
    userId: 'U00001', attemptId: newSource.manifest.attempt_id,
    submissionKey: `submit-${randomUUID()}`, kind: 'experience', title: '跨版本同名经验',
    content: '新版经验：先核对当前来源时间与访问权限，再检查全部未完成操作回执。',
    visibility: 'workspace', retentionDays: 30,
  })
  const newer = await memory.reviewCandidate({
    candidateId: newCandidate.id, decision: 'approved', actor: 'U00001', resolutionKey: `review-${randomUUID()}`,
  })
  const older = await memory.reviewCandidate({
    candidateId: oldCandidate.id, decision: 'approved', actor: 'U00001', resolutionKey: `review-${randomUUID()}`,
  })
  assert.equal(older.approvedEntryId, newer.approvedEntryId)
  assert.equal(older.memoryKey, newer.memoryKey)
  const [state] = await database<{ entryCount: number; oldCandidateKey: string; versionCount: number }[]>`
    select (select count(*)::integer from memory_entries where tenant_id = ${tenantId}
      and memory_key = ${newer.memoryKey}) as "entryCount",
      (select memory_key from memory_candidates where tenant_id = ${tenantId}
        and id = ${oldCandidate.id}) as "oldCandidateKey",
      (select count(*)::integer from memory_versions where tenant_id = ${tenantId}
        and entry_id = ${newer.approvedEntryId}) as "versionCount"
  `
  assert.deepEqual(state, { entryCount: 1, oldCandidateKey: newer.memoryKey, versionCount: 2 })
  const resolved = await memory.resolveContext({
    query: '跨版本同名经验', userId: 'U00001', workspaceId: newSource.manifest.workspace_id,
    agentVersionId: newSource.manifest.agent_version_id, roleIds: ['role-employee'],
  })
  assert.deepEqual(resolved.filter(item => item.title === '跨版本同名经验').map(item => item.memoryVersionId),
    [older.approvedVersionId])
})

test('PF-05 withdrawal blocks new retrieval while preserving historical references', async () => {
  const source = await succeededFixture('withdrawal')
  const candidate = await memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey: `submit-${randomUUID()}`,
    kind: 'experience', title: '异常分析核对方法',
    content: '分析异常时先核对当前数据版本、缺失字段和外部操作回执，再形成可复核的结论。',
    visibility: 'workspace', retentionDays: 60,
  })
  const resolutionKey = `approve-${randomUUID()}`
  const approved = await memory.reviewCandidate({
    candidateId: candidate.id, decision: 'approved', actor: 'U00001',
    resolutionKey,
  })
  const before = await memory.resolveContext({
    query: '异常分析核对', userId: 'U00001', workspaceId: source.manifest.workspace_id,
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
  })
  assert.ok(before.some(item => item.memoryVersionId === approved.approvedVersionId))
  const withdrawn = await memory.withdrawConsent({ userId: 'U00001', consentId: candidate.consentId })
  assert.equal(withdrawn.status, 'withdrawn')
  const after = await memory.resolveContext({
    query: '异常分析核对', userId: 'U00001', workspaceId: source.manifest.workspace_id,
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
  })
  assert.equal(after.some(item => item.memoryVersionId === approved.approvedVersionId), false)
  await assert.rejects(
    memory.assertCurrentReferences({
      memory_context: before,
      user_context: source.manifest.user_context,
      workspace_id: source.manifest.workspace_id,
      agent_version_id: source.manifest.agent_version_id,
    }),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'permission_denied',
  )
  const governed = await memory.listCandidates('approved')
  assert.equal(governed.find(item => item.id === approved.id)?.content, '[内容已撤回或超过可使用期限，不再展示正文]')
  const replay = await memory.reviewCandidate({
    candidateId: candidate.id, decision: 'approved', actor: 'U00001', resolutionKey,
  })
  assert.equal(replay.content, '[内容已撤回或超过可使用期限，不再展示正文]')
  assert.equal(approved.status, 'approved', 'the immutable review record remains historical evidence')
})

test('AE-04 shares reviewed memory across versions of the same Agent while preserving role and workspace ACL', async () => {
  const source = await succeededFixture('acl')
  const candidate = await memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey: `submit-${randomUUID()}`,
    kind: 'experience', title: '库存风险解释方法',
    content: '解释库存风险时同时展示可用库存、安全库存、在途数量和数据日期，缺失项必须明确标注。',
    visibility: 'workspace', retentionDays: 90,
  })
  await memory.reviewCandidate({
    candidateId: candidate.id, decision: 'approved', actor: 'U00001', resolutionKey: `approve-${randomUUID()}`,
  })
  assert.deepEqual(await memory.resolveContext({
    query: '库存风险', userId: 'U00001', workspaceId: source.manifest.workspace_id,
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-unrelated'],
  }), [], 'current role ACL is mandatory')
  const inherited = await memory.resolveContext({
    query: '库存风险', userId: 'U00001', workspaceId: source.manifest.workspace_id,
    agentVersionId: 'agent-version-dsh-work-assistant-output-1', roleIds: ['role-employee'],
  })
  assert.equal(inherited.length, 1, 'a newer version of the same Agent inherits reviewed memory')
  await memory.assertCurrentReferences({
    memory_context: inherited,
    user_context: source.manifest.user_context,
    workspace_id: source.manifest.workspace_id,
    agent_version_id: 'agent-version-dsh-work-assistant-output-1',
  })
  await database`
    update execution_principals set status = 'disabled'
     where tenant_id = ${tenantId} and agent_id = 'agent-dsh-work-assistant'
  `
  try {
    assert.deepEqual(await memory.resolveContext({
      query: '库存风险', userId: 'U00001', workspaceId: source.manifest.workspace_id,
      agentVersionId: 'agent-version-dsh-work-assistant-output-1', roleIds: ['role-employee'],
    }), [], 'disabled Agent identity cannot retrieve inherited memory')
    await assert.rejects(memory.assertCurrentReferences({
      memory_context: inherited,
      user_context: source.manifest.user_context,
      workspace_id: source.manifest.workspace_id,
      agent_version_id: 'agent-version-dsh-work-assistant-output-1',
    }), (error: unknown) => typeof error === 'object' && error !== null
      && 'code' in error && error.code === 'permission_denied')
  } finally {
    await database`
      update execution_principals set status = 'active'
       where tenant_id = ${tenantId} and agent_id = 'agent-dsh-work-assistant'
    `
  }

  const pending = await memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey: `submit-${randomUUID()}`,
    kind: 'preference', title: '输出顺序偏好',
    content: '输出时先给出结论，再列证据和限制，避免把待确认信息写成已经发生的事实。',
    visibility: 'private', retentionDays: 30,
  })
  await memory.withdrawConsent({ userId: 'U00001', consentId: pending.consentId })
  await assert.rejects(
    memory.reviewCandidate({
      candidateId: pending.id, decision: 'approved', actor: 'U00001', resolutionKey: `late-${randomUUID()}`,
    }),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'MEMORY_REVIEW_CONFLICT',
  )
})

test('PF-05 never injects private memory into a team workspace', async () => {
  const source = await succeededFixture('private-team-boundary')
  const candidate = await memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey: `submit-${randomUUID()}`,
    kind: 'preference', title: '仅本人可见的答复偏好',
    content: '这是只允许本人在个人空间使用的答复偏好，不能进入任何团队共享回答或公开引用标题。',
    visibility: 'private', retentionDays: 30,
  })
  const approved = await memory.reviewCandidate({
    candidateId: candidate.id, decision: 'approved', actor: 'U00001', resolutionKey: `approve-${randomUUID()}`,
  })
  const personal = await memory.resolveContext({
    query: '答复偏好', userId: 'U00001', workspaceId: 'ws-personal-U00001',
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
  })
  assert.ok(personal.some(item => item.memoryVersionId === approved.approvedVersionId))
  assert.deepEqual(await memory.resolveContext({
    query: '答复偏好', userId: 'U00001', workspaceId: 'ws-supply',
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
  }), [])
  await assert.rejects(
    memory.assertCurrentReferences({
      memory_context: personal,
      user_context: source.manifest.user_context,
      workspace_id: 'ws-supply',
      agent_version_id: source.manifest.agent_version_id,
    }),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error
      && error.code === 'permission_denied',
  )
})

test('PF-05 intersects current roles with the roles pinned by the source Attempt', async () => {
  const source = await succeededFixture('role-revocation')
  const candidate = await memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey: `submit-${randomUUID()}`,
    kind: 'experience', title: '角色受控分析经验',
    content: '这条经验只能在来源 Attempt 固定的角色仍然属于当前用户时进入运行上下文。',
    visibility: 'private', retentionDays: 30,
  })
  const approved = await memory.reviewCandidate({
    candidateId: candidate.id, decision: 'approved', actor: 'U00001', resolutionKey: `approve-${randomUUID()}`,
  })
  const fixed = await memory.resolveContext({
    query: '角色受控分析经验', userId: 'U00001', workspaceId: source.manifest.workspace_id,
    agentVersionId: source.manifest.agent_version_id, roleIds: source.manifest.user_context.role_ids,
  })
  assert.ok(fixed.some(item => item.memoryVersionId === approved.approvedVersionId))

  const replacementRoleId = `role-memory-replacement-${randomUUID()}`
  await database`
    insert into roles (id, tenant_id, code, name, permissions)
    values (${replacementRoleId}, ${tenantId}, ${replacementRoleId}, '替代工作台角色', '["workbench:use"]'::jsonb)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id)
    values (${tenantId}, 'U00001', ${replacementRoleId})
  `
  await database`
    delete from user_roles where tenant_id = ${tenantId} and user_id = 'U00001' and role_id = 'role-employee'
  `
  try {
    const afterRoleChange = await memory.resolveContext({
      query: '角色受控分析经验', userId: 'U00001', workspaceId: source.manifest.workspace_id,
      agentVersionId: source.manifest.agent_version_id, roleIds: source.manifest.user_context.role_ids,
    })
    assert.equal(afterRoleChange.some(item => item.memoryVersionId === approved.approvedVersionId), false,
      'stale snapshot roles must not authorize a new retrieval')
    await assert.rejects(
      memory.assertCurrentReferences({
        memory_context: fixed,
        user_context: source.manifest.user_context,
        workspace_id: source.manifest.workspace_id,
        agent_version_id: source.manifest.agent_version_id,
      }),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error
        && error.code === 'permission_denied',
    )
  } finally {
    await database`
      insert into user_roles (tenant_id, user_id, role_id)
      values (${tenantId}, 'U00001', 'role-employee') on conflict do nothing
    `
  }
})

test('PF-05 requires current access to the source workspace at submission, review and use', async () => {
  const workspaceId = `ws-memory-source-${randomUUID()}`
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, '记忆来源权限测试', '', 'team', 'U00008', 'active')
  `
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values
      (${tenantId}, ${workspaceId}, 'U00008', 'owner', 'U00008'),
      (${tenantId}, ${workspaceId}, 'U00001', 'member', 'U00008')
  `
  const source = await succeededFixture('revoked-source', workspaceId)
  await database`delete from workspace_members where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and user_id = 'U00001'`
  await assert.rejects(
    memory.submitCandidate({
      userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey: `submit-${randomUUID()}`,
      kind: 'experience', title: '已撤权来源经验',
      content: '这段内容来自已经撤销访问权限的团队空间，不能借助记忆候选绕过当前的空间授权。',
      visibility: 'private', retentionDays: 30,
    }),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error
      && error.code === 'permission_denied',
  )

  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values (${tenantId}, ${workspaceId}, 'U00001', 'member', 'U00008')
  `
  const approvedCandidate = await memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey: `submit-${randomUUID()}`,
    kind: 'experience', title: '需要持续授权的来源经验',
    content: '只有来源用户仍可访问原团队空间时，这段经验才允许进入后续个人空间的受控记忆上下文。',
    visibility: 'private', retentionDays: 30,
  })
  const approved = await memory.reviewCandidate({
    candidateId: approvedCandidate.id, decision: 'approved', actor: 'U00001', resolutionKey: `approve-${randomUUID()}`,
  })
  const pending = await memory.submitCandidate({
    userId: 'U00001', attemptId: source.manifest.attempt_id, submissionKey: `submit-${randomUUID()}`,
    kind: 'preference', title: '等待审核的来源偏好',
    content: '这条待审核偏好用于验证来源权限被撤销以后，管理员不能继续把候选内容发布为正式记忆。',
    visibility: 'private', retentionDays: 30,
  })
  const before = await memory.resolveContext({
    query: '持续授权 来源经验', userId: 'U00001', workspaceId: 'ws-personal-U00001',
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
  })
  assert.ok(before.some(item => item.memoryVersionId === approved.approvedVersionId))
  const unavailableMemory = new PostgresControlledMemoryService(database, {
    authorizeWorkbench: async input => {
      if (input.workspaceId === workspaceId) throw new Error('authorization database unavailable')
      return authorization.authorizeWorkbench(input)
    },
  })
  await assert.rejects(
    unavailableMemory.resolveContext({
      query: '持续授权 来源经验', userId: 'U00001', workspaceId: 'ws-personal-U00001',
      agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
    }),
    /authorization database unavailable/,
    'an authorization infrastructure failure must not be disguised as an empty memory result',
  )

  await database`delete from workspace_members where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and user_id = 'U00001'`
  const afterRevocation = await memory.resolveContext({
    query: '持续授权 来源经验', userId: 'U00001', workspaceId: 'ws-personal-U00001',
    agentVersionId: source.manifest.agent_version_id, roleIds: ['role-employee'],
  })
  assert.equal(afterRevocation.some(item => item.memoryVersionId === approved.approvedVersionId), false)
  await assert.rejects(
    memory.assertCurrentReferences({
      memory_context: before,
      user_context: source.manifest.user_context,
      workspace_id: 'ws-personal-U00001',
      agent_version_id: source.manifest.agent_version_id,
    }),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error
      && error.code === 'permission_denied',
  )
  await assert.rejects(
    memory.reviewCandidate({
      candidateId: pending.id, decision: 'approved', actor: 'U00001', resolutionKey: `approve-${randomUUID()}`,
    }),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error
      && error.code === 'MEMORY_SOURCE_ACCESS_REVOKED',
  )
  const rejected = await memory.reviewCandidate({
    candidateId: pending.id, decision: 'rejected', actor: 'U00008', resolutionKey: `reject-${randomUUID()}`,
    comment: '来源权限已撤销，关闭候选。',
  })
  assert.equal(rejected.status, 'rejected', 'revoked source access must not prevent closing a pending candidate')
  const governed = await memory.listCandidates()
  assert.equal(governed.find(item => item.id === approvedCandidate.id)?.content,
    '[内容已撤回或超过可使用期限，不再展示正文]')
})

async function succeededFixture(
  label: string,
  workspaceId = 'ws-personal-U00001',
  agentVersionId = 'agent-version-dsh-work-assistant-1',
  finalStatus: 'running' | 'succeeded' = 'succeeded',
) {
  const unique = `${label}-${randomUUID()}`
  const task = await tasks.createTask({
    tenantId, requestedBy: 'U00001', sourceType: 'api', correlationKey: unique,
    workspaceId,
  })
  const run = await runs.createRun({
    tenantId, taskId: task.id, sessionId: null, workspaceId: task.workspaceId,
    requestedBy: task.requestedBy, idempotencyKey: unique,
  })
  const manifest: RuntimeManifest = {
    manifest_version: '1.0', run_id: run.id, attempt_id: `attempt-${randomUUID()}`,
    task_id: task.id, session_id: null, workspace_id: task.workspaceId!,
    agent_version_id: agentVersionId,
    agent_configuration: { system_prompt: 'Test controlled memory.', skill_instructions: [] },
    user_context: { user_id: task.requestedBy, tenant_id: tenantId, role_ids: ['role-employee'] },
    permission_policy: { approval_mode: 'never', network_policy: 'deny', write_policy: 'workspace_only' },
    skills: [], tools: finalStatus === 'running' ? [{ id: 'propose_memory', version: '1.0.0' }] : [], data_scopes: [], knowledge_context: [],
    input: { message: 'Produce a governed answer.', file_mounts: [] },
    budget: {
      scope_task_id: task.id,
      cumulative_limits: { max_duration_ms: null, max_tool_calls: null, max_output_bytes: null },
      reservation: { duration_ms: 30_000, tool_calls: 1, output_bytes: 4096 },
      enforcement: { duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported' },
    },
    limits: { timeout_seconds: 30, max_tool_calls: 1, max_output_bytes: 4096 },
    created_at: new Date().toISOString(), trace_id: `trace-${unique}`,
  }
  if (finalStatus === 'running') {
    const [principal] = await database<{ id: string; authorizationVersion: number }[]>`
      select ep.id, ep.authorization_version as "authorizationVersion"
        from agent_versions av join execution_principals ep
          on ep.tenant_id = av.tenant_id and ep.agent_id = av.agent_id and ep.kind = 'agent'
       where av.tenant_id = ${tenantId} and av.id = ${agentVersionId}
    `
    assert.ok(principal)
    manifest.principal_context = {
      initiated_by: task.initiatedByPrincipalId!, executed_as: principal.id,
      disclosure_user_id: 'U00001', executor_authorization_version: principal.authorizationVersion,
    }
  }
  const compiled = compileRuntimeManifest(manifest)
  await runs.createAttempt({
    attemptId: manifest.attempt_id, tenantId, runId: run.id, runtimeId: 'runtime-local-01',
    manifest: JSON.parse(compiled.canonicalJson) as JsonObject, manifestSha256: compiled.sha256,
    modelRouteSnapshot: {},
  })
  await runs.transitionAttempt(tenantId, manifest.attempt_id, 'running')
  await runs.transitionRun(tenantId, run.id, 'running')
  if (finalStatus === 'succeeded') {
    await runs.transitionAttempt(tenantId, manifest.attempt_id, 'succeeded')
    await runs.transitionRun(tenantId, run.id, 'succeeded')
  }
  return { runId: run.id, manifest }
}
