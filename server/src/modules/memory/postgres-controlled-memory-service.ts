import { createHash, randomUUID } from 'node:crypto'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { PostgresOperationsService } from '../admin/application/postgres-operations-service.ts'
import { authorizationDenied, isAuthorizationDenial, requestInvalid } from '../authorization/authorization-errors.ts'
import type { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import type { RuntimeControlledMemory, RuntimeManifest } from '../runtime/runtime-types.ts'

const tenantId = 'tenant-dsh-work'
const maxContextMemories = 3
const maxExcerptCharacters = 1200
const unavailableContent = '[内容已撤回或超过可使用期限，不再展示正文]'

export type MemoryKind = 'preference' | 'experience'
export type MemoryVisibility = 'private' | 'workspace' | 'organization'
export type MemoryCandidateStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn'

export interface ControlledMemoryCandidate {
  id: string
  consentId: string
  memoryKey: string
  kind: MemoryKind
  title: string
  content: string
  contentDigest: string
  visibility: MemoryVisibility
  scopeRef: string
  retentionUntil: string
  status: MemoryCandidateStatus
  submittedBy: string
  reviewedBy: string | null
  reviewedAt: string | null
  reviewComment: string | null
  approvedEntryId: string | null
  approvedVersionId: string | null
  createdAt: string
}

export interface ControlledMemoryConsent {
  id: string
  sourceRunId: string
  sourceAttemptId: string
  workspaceId: string
  agentVersionId: string
  visibility: MemoryVisibility
  retentionUntil: string
  purpose: string
  status: 'active' | 'withdrawn'
  withdrawnAt: string | null
  createdAt: string
  candidateId: string
  candidateStatus: MemoryCandidateStatus
  title: string
}

export interface ResolvedControlledMemory extends RuntimeControlledMemory {
  relevanceScore: number
}

export interface AgentMemoryProposal {
  id: string
  attemptId: string
  kind: MemoryKind
  title: string
  content: string
  status: 'proposed' | 'submitted'
  createdAt: string
  expiresAt: string
}

export interface ExperienceIterationAgentSummary {
  agentId: string
  agentName: string
  agentVersion: string
  agentStatus: string
  totalApplications: number
  pendingApplications: number
  approvedApplications: number
  rejectedApplications: number
  latestApplicationAt: string | null
}

export interface ExperienceIterationApplication {
  id: string
  agentId: string
  agentName: string
  sourceAgentVersionId: string
  sourceAgentVersion: string
  sourceRunId: string
  sourceAttemptId: string
  proposedBy: string
  title: string
  content: string
  contentDigest: string
  status: 'pending' | 'approved' | 'rejected'
  reviewedBy: string | null
  reviewedAt: string | null
  reviewComment: string | null
  publishedVersionId: string | null
  createdAt: string
}

interface CandidateRow {
  id: string
  consentId: string
  memoryKey: string
  kind: MemoryKind
  title: string
  content: string
  contentDigest: string
  visibility: MemoryVisibility
  scopeRef: string
  retentionUntil: Date
  status: MemoryCandidateStatus
  submittedBy: string
  reviewedBy: string | null
  reviewedAt: Date | null
  reviewComment: string | null
  resolutionKey: string | null
  approvedEntryId: string | null
  approvedVersionId: string | null
  createdAt: Date
}

export class PostgresControlledMemoryService {
  private readonly database: DatabaseClient
  private readonly authorization: Pick<PostgresAuthorizationService, 'authorizeWorkbench'>
  private readonly operations?: Pick<PostgresOperationsService, 'appendAudit'>

  constructor(
    database: DatabaseClient,
    authorization: Pick<PostgresAuthorizationService, 'authorizeWorkbench'>,
    operations?: Pick<PostgresOperationsService, 'appendAudit'>,
  ) {
    this.database = database
    this.authorization = authorization
    this.operations = operations
  }

  /** Submitted proposals remain linked to their consent; abandoned drafts are removed after seven days. */
  async purgeExpiredProposals(): Promise<number> {
    const removed = await this.database<{ id: string }[]>`
      delete from memory_proposals where tenant_id = ${tenantId}
        and status = 'proposed' and expires_at <= now() returning id
    `
    return removed.length
  }

  /** A DSH tool can only stage text. It cannot grant scope, publish memory or set retention. */
  async proposeFromAttempt(input: { kind: MemoryKind; title: string; content: string }, manifest: RuntimeManifest, signal: AbortSignal): Promise<{
    proposalId: string; status: 'pending_admin_review' | 'trial_only'
  }> {
    signal.throwIfAborted()
    const title = input.title.trim()
    const content = input.content.trim()
    if ((input.kind !== 'preference' && input.kind !== 'experience')
      || title.length < 3 || title.length > 120 || content.length < 20 || content.length > 4000) {
      throw requestInvalid('记忆提案的类型、标题或内容无效')
    }
    if (!manifest.agent_version_id || !manifest.tools.some(tool => tool.id === 'propose_memory' && tool.version === '1.0.0')) {
      throw authorizationDenied('当前 Agent Version 未声明记忆提案能力')
    }
    if (manifest.purpose === 'agent-release-trial') {
      return {
        proposalId: `trial-memory-proposal-${createHash('sha256').update(`${manifest.attempt_id}\n${input.kind}\n${title}\n${content}`).digest('hex').slice(0, 32)}`,
        status: 'trial_only',
      }
    }
    const [source] = await this.database<{
      runId: string; requestedBy: string; workspaceId: string | null; attemptStatus: string;
      runStatus: string; currentAttemptId: string | null; agentId: string; principalId: string; principalStatus: string
    }[]>`
      select r.id as "runId", r.requested_by as "requestedBy", t.workspace_id as "workspaceId",
             ra.status as "attemptStatus", r.status as "runStatus", r.current_attempt_id as "currentAttemptId",
             av.agent_id as "agentId", ep.id as "principalId", ep.status as "principalStatus"
        from run_attempts ra
        join runs r on r.tenant_id = ra.tenant_id and r.id = ra.run_id
        join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
        join agent_versions av on av.tenant_id = ra.tenant_id and av.id = ra.manifest->>'agent_version_id'
        join execution_principals ep on ep.tenant_id = av.tenant_id and ep.agent_id = av.agent_id and ep.kind = 'agent'
       where ra.tenant_id = ${tenantId} and ra.id = ${manifest.attempt_id}
    `
    if (!source || source.runId !== manifest.run_id || source.workspaceId !== manifest.workspace_id
      || source.requestedBy !== manifest.user_context.user_id
      || source.currentAttemptId !== manifest.attempt_id
      || source.attemptStatus !== 'running' || source.runStatus !== 'running'
      || source.principalStatus !== 'active'
      || source.principalId !== manifest.principal_context?.executed_as) {
      throw authorizationDenied('当前 Attempt 或 Agent 身份已失效，不能提出记忆候选')
    }
    const contentDigest = createHash('sha256').update(content).digest('hex')
    const proposalKey = createHash('sha256').update(JSON.stringify({ kind: input.kind, title, contentDigest })).digest('hex')
    const id = `memory-proposal-${randomUUID()}`
    const [created] = await this.database<{ id: string }[]>`
      insert into memory_proposals (
        id, tenant_id, run_id, attempt_id, agent_version_id, agent_principal_id,
        requested_by, workspace_id, proposal_key, kind, title, content, content_digest
      ) values (
        ${id}, ${tenantId}, ${manifest.run_id}, ${manifest.attempt_id}, ${manifest.agent_version_id},
        ${source.principalId}, ${source.requestedBy}, ${source.workspaceId}, ${proposalKey},
        ${input.kind}, ${title}, ${content}, ${contentDigest}
      ) on conflict (tenant_id, attempt_id, proposal_key) do nothing
      returning id
    `
    const [existing] = created ? [] : await this.database<{ id: string; status: string; expiresAt: Date }[]>`
      select id, status, expires_at as "expiresAt" from memory_proposals
       where tenant_id = ${tenantId} and attempt_id = ${manifest.attempt_id} and proposal_key = ${proposalKey}
    `
    if (!created && (!existing || existing.status !== 'proposed' || existing.expiresAt.getTime() <= Date.now())) {
      throw Object.assign(new Error('相同记忆提案已提交或已过期'), { status: 409, code: 'MEMORY_PROPOSAL_CONFLICT' })
    }
    return { proposalId: (created ?? existing)!.id, status: 'pending_admin_review' }
  }

  async listOwnProposals(userId: string, attemptId: string): Promise<AgentMemoryProposal[]> {
    const [source] = await this.database<{ workspaceId: string | null }[]>`
      select t.workspace_id as "workspaceId" from run_attempts ra
      join runs r on r.tenant_id = ra.tenant_id and r.id = ra.run_id
      join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
      where ra.tenant_id = ${tenantId} and ra.id = ${attemptId}
        and r.requested_by = ${userId} and ra.status = 'succeeded'
    `
    if (!source?.workspaceId) throw authorizationDenied('来源 Attempt 不可访问或尚未成功完成')
    await this.authorization.authorizeWorkbench({ userId, workspaceId: source.workspaceId })
    const rows = await this.database<Array<{
      id: string; attemptId: string; kind: MemoryKind; title: string; content: string;
      status: 'proposed' | 'submitted'; createdAt: Date; expiresAt: Date
    }>>`
      select id, attempt_id as "attemptId", kind, title, content, status,
             created_at as "createdAt", expires_at as "expiresAt"
        from memory_proposals
       where tenant_id = ${tenantId} and attempt_id = ${attemptId}
         and requested_by = ${userId} and status = 'proposed' and expires_at > now()
       order by created_at, id
    `
    return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() }))
  }

  async submitCandidate(input: {
    userId: string
    attemptId: string
    submissionKey: string
    kind: MemoryKind
    title: string
    content: string
    visibility: MemoryVisibility
    retentionDays: number
    proposalId?: string
  }): Promise<ControlledMemoryCandidate> {
    const title = input.title.trim()
    const content = input.content.trim()
    if (title.length < 3 || title.length > 120) throw requestInvalid('title 长度必须为 3～120 个字符')
    if (content.length < 20 || content.length > 4000) throw requestInvalid('content 长度必须为 20～4000 个字符')
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650) {
      throw requestInvalid('retentionDays 必须为 1～3650 的整数')
    }
    if (!input.submissionKey.trim() || input.submissionKey.length > 200) throw requestInvalid('submissionKey 无效')
    if (input.proposalId !== undefined && (typeof input.proposalId !== 'string' || !/^memory-proposal-[0-9a-f-]{36}$/.test(input.proposalId))) {
      throw requestInvalid('proposalId 无效')
    }
    const [source] = await this.database<{
      runId: string; requestedBy: string; workspaceId: string | null; attemptStatus: string;
      agentVersionId: string | null; agentId: string | null; roleIds: unknown; agentStatus: string | null
    }[]>`
      select r.id as "runId", r.requested_by as "requestedBy", t.workspace_id as "workspaceId",
             ra.status as "attemptStatus", ra.manifest->>'agent_version_id' as "agentVersionId",
             ra.manifest->'user_context'->'role_ids' as "roleIds", av.status as "agentStatus",
             av.agent_id as "agentId"
        from run_attempts ra
        join runs r on r.tenant_id = ra.tenant_id and r.id = ra.run_id
        join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
        left join agent_versions av on av.tenant_id = ra.tenant_id and av.id = ra.manifest->>'agent_version_id'
       where ra.tenant_id = ${tenantId} and ra.id = ${input.attemptId}
    `
    if (!source || source.requestedBy !== input.userId) throw authorizationDenied('来源 Attempt 不存在或不属于当前用户')
    if (source.attemptStatus !== 'succeeded') throw requestInvalid('只有成功完成的 Attempt 可以作为记忆候选来源')
    if (!source.workspaceId || !source.agentVersionId || !source.agentId || source.agentStatus !== 'published') {
      throw requestInvalid('来源 Attempt 缺少可用 Workspace 或已发布 Agent Version')
    }
    await this.authorization.authorizeWorkbench({ userId: input.userId, workspaceId: source.workspaceId })
    const roles = Array.isArray(source.roleIds) ? source.roleIds.filter((value): value is string => typeof value === 'string') : []
    const scopeRef = input.visibility === 'private'
      ? input.userId
      : input.visibility === 'workspace'
        ? source.workspaceId
        : ''
    const retentionUntil = new Date(Date.now() + input.retentionDays * 86_400_000)
    const normalizedTitle = title.toLocaleLowerCase('zh-CN').replaceAll(/\s+/g, ' ')
    const memoryKey = createHash('sha256')
      .update(`${source.agentId}\n${input.kind}\n${normalizedTitle}\n${input.visibility}\n${scopeRef}`)
      .digest('hex')
    const contentDigest = createHash('sha256').update(content).digest('hex')
    const requestDigest = createHash('sha256').update(JSON.stringify({
      attemptId: input.attemptId,
      sourceRunId: source.runId,
      sourceWorkspaceId: source.workspaceId,
      agentVersionId: source.agentVersionId,
      kind: input.kind,
      title,
      contentDigest,
      visibility: input.visibility,
      scopeRef,
      retentionDays: input.retentionDays,
      proposalId: input.proposalId ?? null,
    })).digest('hex')
    const result = await this.database.begin(async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(
          hashtext(${tenantId}),
          hashtext(${`${input.userId}\n${input.submissionKey.trim()}`})
        )
      `
      const [existing] = await transaction<(CandidateRow & { requestDigest: string })[]>`
        select mc.id, mc.consent_id as "consentId", mc.memory_key as "memoryKey", mc.kind,
               mc.title, mc.content, mc.content_digest as "contentDigest", mc.visibility,
               mc.scope_ref as "scopeRef", mc.retention_until as "retentionUntil", mc.status,
               mc.request_digest as "requestDigest",
               mc.submitted_by as "submittedBy", mc.reviewed_by as "reviewedBy",
               mc.reviewed_at as "reviewedAt", mc.review_comment as "reviewComment",
               mc.resolution_key as "resolutionKey", mc.approved_entry_id as "approvedEntryId",
               mc.approved_version_id as "approvedVersionId", mc.created_at as "createdAt"
          from memory_candidates mc
         where mc.tenant_id = ${tenantId} and mc.submitted_by = ${input.userId}
           and mc.submission_key = ${input.submissionKey.trim()}
      `
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw Object.assign(new Error('submissionKey 已用于不同的记忆候选'), { status: 409, code: 'MEMORY_SUBMISSION_CONFLICT' })
        }
        return existing
      }
      if (input.proposalId) {
        const [proposal] = await transaction<{ kind: MemoryKind; title: string; content: string; status: string }[]>`
          select kind, title, content, status from memory_proposals
           where tenant_id = ${tenantId} and id = ${input.proposalId}
             and attempt_id = ${input.attemptId} and requested_by = ${input.userId}
             and expires_at > now() for update
        `
        if (!proposal || proposal.status !== 'proposed'
          || proposal.kind !== input.kind || proposal.title !== title || proposal.content !== content) {
          throw Object.assign(new Error('记忆提案已过期、已提交或内容已改变'), { status: 409, code: 'MEMORY_PROPOSAL_CONFLICT' })
        }
      }
      const consentId = `memory-consent-${randomUUID()}`
      const candidateId = `memory-candidate-${randomUUID()}`
      await transaction`
        insert into memory_consents (
          id, tenant_id, source_user_id, source_run_id, source_attempt_id, workspace_id,
          agent_version_id, visibility, retention_until, purpose, status
        ) values (
          ${consentId}, ${tenantId}, ${input.userId}, ${source.runId}, ${input.attemptId}, ${source.workspaceId},
          ${source.agentVersionId}, ${input.visibility}, ${retentionUntil},
          ${`用户明确提交${input.kind === 'preference' ? '稳定偏好' : '可复用经验'}候选`}, 'active'
        )
      `
      const [created] = await transaction<CandidateRow[]>`
        insert into memory_candidates (
          id, tenant_id, consent_id, submission_key, request_digest, memory_key, kind, title, content,
          content_digest, visibility, scope_ref, allowed_role_ids, retention_until, status, submitted_by,
          source_proposal_id
        ) values (
          ${candidateId}, ${tenantId}, ${consentId}, ${input.submissionKey.trim()}, ${requestDigest}, ${memoryKey}, ${input.kind},
          ${title}, ${content}, ${contentDigest}, ${input.visibility}, ${scopeRef}, ${transaction.json(roles)},
          ${retentionUntil}, 'pending', ${input.userId}, ${input.proposalId ?? null}
        ) returning id, consent_id as "consentId", memory_key as "memoryKey", kind, title, content,
          content_digest as "contentDigest", visibility, scope_ref as "scopeRef",
          retention_until as "retentionUntil", status, submitted_by as "submittedBy",
          reviewed_by as "reviewedBy", reviewed_at as "reviewedAt", review_comment as "reviewComment",
          resolution_key as "resolutionKey", approved_entry_id as "approvedEntryId",
          approved_version_id as "approvedVersionId", created_at as "createdAt"
      `
      if (!created) throw new Error('记忆候选创建失败')
      if (input.proposalId) await transaction`
        update memory_proposals set status = 'submitted', content = ${unavailableContent}
         where tenant_id = ${tenantId} and id = ${input.proposalId}
      `
      return created
    })
    await this.operations?.appendAudit(input.userId, 'memory.candidate.submit', result.id, 'success', `trace-${result.id}`, `${result.kind}:${result.visibility}`)
    return mapCandidate(result)
  }

  async listOwnConsents(userId: string): Promise<ControlledMemoryConsent[]> {
    const rows = await this.database<Array<{
      id: string; sourceRunId: string; sourceAttemptId: string; workspaceId: string; agentVersionId: string;
      visibility: MemoryVisibility; retentionUntil: Date; purpose: string; status: 'active' | 'withdrawn';
      withdrawnAt: Date | null; createdAt: Date; candidateId: string; candidateStatus: MemoryCandidateStatus; title: string
    }>>`
      select c.id, c.source_run_id as "sourceRunId", c.source_attempt_id as "sourceAttemptId",
             c.workspace_id as "workspaceId", c.agent_version_id as "agentVersionId", c.visibility,
             c.retention_until as "retentionUntil", c.purpose, c.status,
             c.withdrawn_at as "withdrawnAt", c.created_at as "createdAt",
             mc.id as "candidateId", mc.status as "candidateStatus", mc.title
        from memory_consents c
        join memory_candidates mc on mc.tenant_id = c.tenant_id and mc.consent_id = c.id
       where c.tenant_id = ${tenantId} and c.source_user_id = ${userId}
       order by c.created_at desc
    `
    return rows.map(row => ({
      ...row,
      retentionUntil: row.retentionUntil.toISOString(),
      withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  async withdrawConsent(input: { userId: string; consentId: string }): Promise<ControlledMemoryConsent> {
    await this.database.begin(async (transaction) => {
      const [consent] = await transaction<{ status: string; sourceUserId: string }[]>`
        select status, source_user_id as "sourceUserId" from memory_consents
         where tenant_id = ${tenantId} and id = ${input.consentId} for update
      `
      if (!consent || consent.sourceUserId !== input.userId) throw authorizationDenied('记忆授权不存在或不可撤回')
      if (consent.status === 'withdrawn') return
      await transaction`
        update memory_consents set status = 'withdrawn', withdrawn_at = now()
         where tenant_id = ${tenantId} and id = ${input.consentId}
      `
      await transaction`
        update memory_candidates set status = 'withdrawn'
         where tenant_id = ${tenantId} and consent_id = ${input.consentId} and status = 'pending'
      `
    })
    await this.operations?.appendAudit(input.userId, 'memory.consent.withdraw', input.consentId, 'success', `trace-${input.consentId}`, '阻止后续 Attempt 引用')
    const consent = (await this.listOwnConsents(input.userId)).find(item => item.id === input.consentId)
    if (!consent) throw new Error('撤回后的记忆授权不存在')
    return consent
  }

  async listCandidates(status?: MemoryCandidateStatus): Promise<ControlledMemoryCandidate[]> {
    const rows = await this.database<(CandidateRow & { sourceUserId: string; sourceWorkspaceId: string })[]>`
      select mc.id, mc.consent_id as "consentId", mc.memory_key as "memoryKey", mc.kind, mc.title,
             case when c.status = 'active' and c.retention_until > now() and mc.retention_until > now()
               then mc.content else ${unavailableContent} end as content,
             mc.content_digest as "contentDigest", mc.visibility, mc.scope_ref as "scopeRef",
             mc.retention_until as "retentionUntil", mc.status, mc.submitted_by as "submittedBy",
             mc.reviewed_by as "reviewedBy", mc.reviewed_at as "reviewedAt", mc.review_comment as "reviewComment",
             mc.resolution_key as "resolutionKey", mc.approved_entry_id as "approvedEntryId",
             mc.approved_version_id as "approvedVersionId", mc.created_at as "createdAt"
             , c.source_user_id as "sourceUserId", c.workspace_id as "sourceWorkspaceId"
        from memory_candidates mc
        join memory_consents c on c.tenant_id = mc.tenant_id and c.id = mc.consent_id
       where mc.tenant_id = ${tenantId}
        ${status ? this.database`and mc.status = ${status}` : this.database``}
       order by mc.created_at asc, mc.id asc
    `
    const sourceAccess = await this.resolveSourceAccess(rows)
    return rows.map(row => mapCandidate(sourceAccess.get(sourceAccessKey(row)) ? row : { ...row, content: unavailableContent }))
  }

  async listExperienceIterationAgents(): Promise<ExperienceIterationAgentSummary[]> {
    const [agents, applications] = await Promise.all([
      this.database<Array<{ agentId: string; agentName: string; agentVersion: string; agentStatus: string }>>`
        select a.id as "agentId", a.name as "agentName",
               coalesce(active_version.version, draft_version.version, '—') as "agentVersion",
               a.status as "agentStatus"
          from agents a
          left join agent_versions active_version
            on active_version.tenant_id = a.tenant_id and active_version.id = a.active_version_id
          left join agent_versions draft_version
            on draft_version.tenant_id = a.tenant_id and draft_version.id = a.draft_version_id
         where a.tenant_id = ${tenantId}
         order by a.name, a.id
      `,
      this.listExperienceIterationApplications(),
    ])
    return agents.map(agent => {
      const owned = applications.filter(application => application.agentId === agent.agentId)
      return {
        ...agent,
        totalApplications: owned.length,
        pendingApplications: owned.filter(application => application.status === 'pending').length,
        approvedApplications: owned.filter(application => application.status === 'approved').length,
        rejectedApplications: owned.filter(application => application.status === 'rejected').length,
        latestApplicationAt: owned[0]?.createdAt ?? null,
      }
    })
  }

  async listExperienceIterationApplications(
    agentId?: string,
    status?: ExperienceIterationApplication['status'],
  ): Promise<ExperienceIterationApplication[]> {
    const proposals = await this.database<Array<{
      id: string; agentId: string; agentName: string; sourceAgentVersionId: string; sourceAgentVersion: string;
      sourceRunId: string; sourceAttemptId: string; proposedBy: string; title: string; content: string;
      contentDigest: string; createdAt: Date; sourceUserId: string; sourceWorkspaceId: string
    }>>`
      select mp.id, av.agent_id as "agentId", a.name as "agentName",
             mp.agent_version_id as "sourceAgentVersionId", av.version as "sourceAgentVersion",
             mp.run_id as "sourceRunId", mp.attempt_id as "sourceAttemptId",
             mp.agent_principal_id as "proposedBy", mp.title, mp.content,
             mp.requested_by as "sourceUserId", mp.workspace_id as "sourceWorkspaceId",
             mp.content_digest as "contentDigest", mp.created_at as "createdAt"
        from memory_proposals mp
        join run_attempts ra on ra.tenant_id = mp.tenant_id and ra.id = mp.attempt_id
        join agent_versions av on av.tenant_id = mp.tenant_id and av.id = mp.agent_version_id
        join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
       where mp.tenant_id = ${tenantId} and mp.kind = 'experience'
         and mp.status = 'proposed' and mp.expires_at > now() and ra.status = 'succeeded'
         ${agentId ? this.database`and av.agent_id = ${agentId}` : this.database``}
       order by mp.created_at desc, mp.id
    `
    const reviewed = await this.database<Array<{
      id: string; agentId: string; agentName: string; sourceAgentVersionId: string; sourceAgentVersion: string;
      sourceRunId: string; sourceAttemptId: string; proposedBy: string; title: string; content: string;
      contentDigest: string; status: 'pending' | 'approved' | 'rejected'; reviewedBy: string | null; reviewedAt: Date | null;
      reviewComment: string | null; publishedVersionId: string | null; createdAt: Date;
      sourceUserId: string; sourceWorkspaceId: string
    }>>`
      select mp.id, av.agent_id as "agentId", a.name as "agentName",
             mp.agent_version_id as "sourceAgentVersionId", av.version as "sourceAgentVersion",
             mp.run_id as "sourceRunId", mp.attempt_id as "sourceAttemptId",
             mp.agent_principal_id as "proposedBy", mc.title,
             case when c.status = 'active' and c.retention_until > now() and mc.retention_until > now()
               then mc.content else ${unavailableContent} end as content,
             c.source_user_id as "sourceUserId", c.workspace_id as "sourceWorkspaceId",
             mc.content_digest as "contentDigest", mc.status, mc.reviewed_by as "reviewedBy",
             mc.reviewed_at as "reviewedAt", mc.review_comment as "reviewComment",
             mc.approved_version_id as "publishedVersionId", mp.created_at as "createdAt"
        from memory_proposals mp
        join memory_candidates mc
          on mc.tenant_id = mp.tenant_id and mc.source_proposal_id = mp.id
        join memory_consents c on c.tenant_id = mc.tenant_id and c.id = mc.consent_id
        join agent_versions av on av.tenant_id = mp.tenant_id and av.id = mp.agent_version_id
        join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
       where mp.tenant_id = ${tenantId} and mp.kind = 'experience'
         and mc.status in ('pending', 'approved', 'rejected')
         ${agentId ? this.database`and av.agent_id = ${agentId}` : this.database``}
       order by mp.created_at desc, mp.id
    `
    const sourceAccess = await this.resolveSourceAccess([...proposals, ...reviewed])
    const applications: ExperienceIterationApplication[] = [
      ...proposals.map(row => ({
        id: row.id, agentId: row.agentId, agentName: row.agentName,
        sourceAgentVersionId: row.sourceAgentVersionId, sourceAgentVersion: row.sourceAgentVersion,
        sourceRunId: row.sourceRunId, sourceAttemptId: row.sourceAttemptId,
        proposedBy: row.proposedBy, title: row.title,
        content: sourceAccess.get(sourceAccessKey(row)) ? row.content : unavailableContent,
        contentDigest: row.contentDigest,
        status: 'pending' as const,
        reviewedBy: null,
        reviewedAt: null,
        reviewComment: null,
        publishedVersionId: null,
        createdAt: row.createdAt.toISOString(),
      })),
      ...reviewed.map(row => ({
        id: row.id, agentId: row.agentId, agentName: row.agentName,
        sourceAgentVersionId: row.sourceAgentVersionId, sourceAgentVersion: row.sourceAgentVersion,
        sourceRunId: row.sourceRunId, sourceAttemptId: row.sourceAttemptId,
        proposedBy: row.proposedBy, title: row.title,
        content: sourceAccess.get(sourceAccessKey(row)) ? row.content : unavailableContent,
        contentDigest: row.contentDigest, status: row.status,
        reviewedBy: row.reviewedBy, reviewComment: row.reviewComment,
        publishedVersionId: row.publishedVersionId,
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
    return status ? applications.filter(application => application.status === status) : applications
  }

  async reviewExperienceIterationApplication(input: {
    applicationId: string
    decision: 'approved' | 'rejected'
    actor: string
    resolutionKey: string
    comment?: string
  }): Promise<ExperienceIterationApplication> {
    const [proposal] = await this.database<{
      requestedBy: string; attemptId: string; kind: MemoryKind; title: string; content: string; status: string
    }[]>`
      select requested_by as "requestedBy", attempt_id as "attemptId", kind, title, content, status
        from memory_proposals
       where tenant_id = ${tenantId} and id = ${input.applicationId}
    `
    if (!proposal || proposal.kind !== 'experience') throw requestInvalid('经验迭代申请不存在')

    let [candidate] = await this.database<{ id: string }[]>`
      select id from memory_candidates
       where tenant_id = ${tenantId} and source_proposal_id = ${input.applicationId}
    `
    if (!candidate) {
      if (proposal.status !== 'proposed') throw requestInvalid('经验迭代申请状态不可审核')
      const created = await this.submitCandidate({
        userId: proposal.requestedBy,
        attemptId: proposal.attemptId,
        submissionKey: `agent-experience:${input.applicationId}`,
        kind: 'experience',
        title: proposal.title,
        content: proposal.content,
        visibility: 'organization',
        retentionDays: 3650,
        proposalId: input.applicationId,
      })
      candidate = { id: created.id }
    }
    await this.reviewCandidate({
      candidateId: candidate.id,
      decision: input.decision,
      actor: input.actor,
      resolutionKey: input.resolutionKey,
      comment: input.comment,
      auditActionPrefix: 'experience.iteration.application',
      auditTargetId: input.applicationId,
    })
    const application = (await this.listExperienceIterationApplications()).find(item => item.id === input.applicationId)
    if (!application) throw new Error('审核后的经验迭代申请不存在')
    return application
  }

  async reviewCandidate(input: {
    candidateId: string
    decision: 'approved' | 'rejected'
    actor: string
    resolutionKey: string
    comment?: string
    auditActionPrefix?: string
    auditTargetId?: string
  }): Promise<ControlledMemoryCandidate> {
    const outcome = await this.database.begin(async (transaction) => {
      const [candidate] = await transaction<(CandidateRow & {
        consentStatus: string; consentAgentVersionId: string; agentId: string; consentSourceUserId: string;
        sourceRunId: string; sourceAttemptId: string; sourceWorkspaceId: string; consentRetentionUntil: Date
      })[]>`
        select mc.id, mc.consent_id as "consentId", mc.memory_key as "memoryKey", mc.kind,
               mc.title, mc.content, mc.content_digest as "contentDigest", mc.visibility,
               mc.scope_ref as "scopeRef", mc.retention_until as "retentionUntil", mc.status,
               mc.submitted_by as "submittedBy", mc.reviewed_by as "reviewedBy",
               mc.reviewed_at as "reviewedAt", mc.review_comment as "reviewComment",
               mc.resolution_key as "resolutionKey", mc.approved_entry_id as "approvedEntryId",
               mc.approved_version_id as "approvedVersionId", mc.created_at as "createdAt",
               c.status as "consentStatus", c.agent_version_id as "consentAgentVersionId",
               source_av.agent_id as "agentId",
               c.source_user_id as "consentSourceUserId", c.source_run_id as "sourceRunId",
               c.source_attempt_id as "sourceAttemptId", c.workspace_id as "sourceWorkspaceId",
               c.retention_until as "consentRetentionUntil"
          from memory_candidates mc
          join memory_consents c on c.tenant_id = mc.tenant_id and c.id = mc.consent_id
          join agent_versions source_av on source_av.tenant_id = c.tenant_id and source_av.id = c.agent_version_id
         where mc.tenant_id = ${tenantId} and mc.id = ${input.candidateId}
         for update of mc, c
      `
      if (!candidate) throw requestInvalid('记忆候选不存在')
      if (candidate.status !== 'pending') {
        if (candidate.status === input.decision && candidate.resolutionKey === input.resolutionKey) {
          if (candidate.consentStatus !== 'active'
            || candidate.consentRetentionUntil.getTime() <= Date.now()
            || candidate.retentionUntil.getTime() <= Date.now()) {
            return { ...candidate, content: unavailableContent }
          }
          const sourceAccess = await this.resolveSourceAccess([{
            sourceUserId: candidate.consentSourceUserId,
            sourceWorkspaceId: candidate.sourceWorkspaceId,
          }])
          return sourceAccess.get(sourceAccessKey({
            sourceUserId: candidate.consentSourceUserId,
            sourceWorkspaceId: candidate.sourceWorkspaceId,
          })) ? candidate : { ...candidate, content: unavailableContent }
        }
        throw Object.assign(new Error('记忆候选已被处理，当前决定未生效'), { status: 409, code: 'MEMORY_REVIEW_CONFLICT' })
      }
      if (candidate.consentStatus !== 'active' || candidate.consentRetentionUntil.getTime() <= Date.now()) {
        throw Object.assign(new Error('来源授权已撤回或过期，不能发布记忆'), { status: 409, code: 'MEMORY_CONSENT_INACTIVE' })
      }
      if (input.decision === 'rejected') {
        const [rejected] = await transaction<CandidateRow[]>`
          update memory_candidates set status = 'rejected', reviewed_by = ${input.actor}, reviewed_at = now(),
                 review_comment = ${input.comment ?? null}, resolution_key = ${input.resolutionKey}
           where tenant_id = ${tenantId} and id = ${candidate.id}
           returning id, consent_id as "consentId", memory_key as "memoryKey", kind, title, content,
             content_digest as "contentDigest", visibility, scope_ref as "scopeRef", retention_until as "retentionUntil",
             status, submitted_by as "submittedBy", reviewed_by as "reviewedBy", reviewed_at as "reviewedAt",
             review_comment as "reviewComment", resolution_key as "resolutionKey",
             approved_entry_id as "approvedEntryId", approved_version_id as "approvedVersionId", created_at as "createdAt"
        `
        return rejected!
      }
      try {
        await this.authorization.authorizeWorkbench({
          userId: candidate.consentSourceUserId,
          workspaceId: candidate.sourceWorkspaceId,
        })
      } catch (error) {
        if (!isAuthorizationDenial(error)) throw error
        throw Object.assign(new Error('来源用户已无权访问来源工作空间，不能发布记忆'), {
          status: 409,
          code: 'MEMORY_SOURCE_ACCESS_REVOKED',
        })
      }
      const normalizedTitle = candidate.title.toLocaleLowerCase('zh-CN').replaceAll(/\s+/g, ' ')
      const stableMemoryKey = createHash('sha256')
        .update(`${candidate.agentId}\n${candidate.kind}\n${normalizedTitle}\n${candidate.visibility}\n${candidate.scopeRef}`)
        .digest('hex')
      // Older pending candidates still carry an Agent Version key. All reviews
      // for one logical memory must serialize under the stable Agent key.
      await transaction`select pg_advisory_xact_lock(hashtext(${stableMemoryKey}))`
      if (candidate.memoryKey !== stableMemoryKey) {
        await transaction`
          update memory_candidates set memory_key = ${stableMemoryKey}
           where tenant_id = ${tenantId} and id = ${candidate.id}
        `
        candidate.memoryKey = stableMemoryKey
      }
      const agentVersions = await transaction<{ id: string }[]>`
        select id from agent_versions where tenant_id = ${tenantId} and agent_id = ${candidate.agentId}
      `
      const legacyKeys = agentVersions.map(version => createHash('sha256')
        .update(`${version.id}\n${candidate.kind}\n${normalizedTitle}\n${candidate.visibility}\n${candidate.scopeRef}`)
        .digest('hex'))
      let [entry] = await transaction<{ id: string; currentVersionId: string | null }[]>`
        select me.id, me.current_version_id as "currentVersionId" from memory_entries me
        join agent_versions av on av.tenant_id = me.tenant_id and av.id = me.agent_version_id
         where me.tenant_id = ${tenantId}
           and me.memory_key in ${transaction([stableMemoryKey, ...legacyKeys])}
           and me.kind = ${candidate.kind}
           and me.visibility = ${candidate.visibility} and me.scope_ref = ${candidate.scopeRef}
           and av.agent_id = ${candidate.agentId}
         order by (me.memory_key = ${stableMemoryKey}) desc, me.updated_at desc
         limit 1 for update of me
      `
      if (entry) await transaction`
        update memory_entries set memory_key = ${stableMemoryKey}
         where tenant_id = ${tenantId} and id = ${entry.id} and memory_key <> ${stableMemoryKey}
      `
      if (!entry) {
        const entryId = `memory-entry-${randomUUID()}`
        ;[entry] = await transaction<{ id: string; currentVersionId: string | null }[]>`
          insert into memory_entries (id, tenant_id, memory_key, kind, visibility, scope_ref, agent_version_id)
          values (${entryId}, ${tenantId}, ${stableMemoryKey}, ${candidate.kind}, ${candidate.visibility},
                  ${candidate.scopeRef}, ${candidate.consentAgentVersionId})
          returning id, current_version_id as "currentVersionId"
        `
      }
      const [counter] = await transaction<{ version: number }[]>`
        select coalesce(max(version), 0)::integer + 1 as version from memory_versions
         where tenant_id = ${tenantId} and entry_id = ${entry!.id}
      `
      const versionId = `memory-version-${randomUUID()}`
      const [roles] = await transaction<{ allowedRoleIds: unknown }[]>`
        select allowed_role_ids as "allowedRoleIds" from memory_candidates
         where tenant_id = ${tenantId} and id = ${candidate.id}
      `
      await transaction`
        insert into memory_versions (
          id, tenant_id, entry_id, candidate_id, version, title, content, content_digest,
          kind, visibility, scope_ref, agent_version_id, allowed_role_ids, source_user_id,
          source_run_id, source_attempt_id, retention_until, published_by
        ) values (
          ${versionId}, ${tenantId}, ${entry!.id}, ${candidate.id}, ${counter?.version ?? 1},
          ${candidate.title}, ${candidate.content}, ${candidate.contentDigest}, ${candidate.kind},
          ${candidate.visibility}, ${candidate.scopeRef}, ${candidate.consentAgentVersionId},
          ${transaction.json(Array.isArray(roles?.allowedRoleIds) ? roles.allowedRoleIds : [])},
          ${candidate.consentSourceUserId}, ${candidate.sourceRunId}, ${candidate.sourceAttemptId},
          ${candidate.retentionUntil}, ${input.actor}
        )
      `
      await transaction`
        update memory_entries set current_version_id = ${versionId}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${entry!.id}
      `
      const [approved] = await transaction<CandidateRow[]>`
        update memory_candidates set status = 'approved', reviewed_by = ${input.actor}, reviewed_at = now(),
               review_comment = ${input.comment ?? null}, resolution_key = ${input.resolutionKey},
               approved_entry_id = ${entry!.id}, approved_version_id = ${versionId}
         where tenant_id = ${tenantId} and id = ${candidate.id}
         returning id, consent_id as "consentId", memory_key as "memoryKey", kind, title, content,
           content_digest as "contentDigest", visibility, scope_ref as "scopeRef", retention_until as "retentionUntil",
           status, submitted_by as "submittedBy", reviewed_by as "reviewedBy", reviewed_at as "reviewedAt",
           review_comment as "reviewComment", resolution_key as "resolutionKey",
           approved_entry_id as "approvedEntryId", approved_version_id as "approvedVersionId", created_at as "createdAt"
      `
      return approved!
    })
    const auditTargetId = input.auditTargetId ?? input.candidateId
    await this.operations?.appendAudit(
      input.actor,
      `${input.auditActionPrefix ?? 'memory.candidate'}.${input.decision}`,
      auditTargetId,
      'success',
      `trace-${auditTargetId}`,
      input.comment ?? input.decision,
    )
    return mapCandidate(outcome)
  }

  async resolveContext(input: {
    query: string
    userId: string
    workspaceId: string
    agentVersionId: string | null
    roleIds: string[]
  }): Promise<ResolvedControlledMemory[]> {
    if (!input.agentVersionId) return []
    const targetAuthorization = await this.authorization.authorizeWorkbench({
      userId: input.userId,
      workspaceId: input.workspaceId,
    })
    const currentRoleIds = await this.currentAgentRoles(
      input.agentVersionId,
      targetAuthorization.roleIds.filter(roleId => input.roleIds.includes(roleId)),
    )
    if (!currentRoleIds.length) return []
    const roleIds = currentRoleIds.length ? [...new Set(currentRoleIds)] : ['__no_role__']
    const rows = await this.database<Array<{
      memoryVersionId: string; title: string; version: number; kind: MemoryKind; visibility: MemoryVisibility;
      content: string; contentDigest: string; allowedRoleIds: unknown; sourceUserId: string; sourceWorkspaceId: string
    }>>`
      select mv.id as "memoryVersionId", mv.title, mv.version, mv.kind, mv.visibility,
             mv.content, mv.content_digest as "contentDigest", mv.allowed_role_ids as "allowedRoleIds",
             c.source_user_id as "sourceUserId", c.workspace_id as "sourceWorkspaceId"
        from memory_entries me
        join memory_versions mv on mv.tenant_id = me.tenant_id and mv.id = me.current_version_id
        join agent_versions owner_av on owner_av.tenant_id = me.tenant_id and owner_av.id = me.agent_version_id
        join agent_versions target_av on target_av.tenant_id = me.tenant_id
          and target_av.id = ${input.agentVersionId} and target_av.agent_id = owner_av.agent_id
          and target_av.status <> 'disabled'
        join execution_principals ep on ep.tenant_id = me.tenant_id and ep.agent_id = target_av.agent_id
          and ep.kind = 'agent' and ep.status = 'active'
        join memory_candidates mc on mc.tenant_id = mv.tenant_id and mc.id = mv.candidate_id
        join memory_consents c on c.tenant_id = mc.tenant_id and c.id = mc.consent_id
       where me.tenant_id = ${tenantId}
         and mc.status = 'approved' and c.status = 'active'
         and mv.retention_until > now() and c.retention_until > now()
         and (
           (mv.visibility = 'private' and mv.scope_ref = ${input.userId}
             and ${targetAuthorization.workspaceType} = 'personal')
           or (mv.visibility = 'workspace' and mv.scope_ref = ${input.workspaceId})
           or mv.visibility = 'organization'
         )
         and (jsonb_array_length(mv.allowed_role_ids) = 0 or exists (
           select 1 from jsonb_array_elements_text(mv.allowed_role_ids) role_id
            where role_id in ${this.database(roleIds)}
         ))
    `
    const sourceAccess = await this.resolveSourceAccess(rows)
    const authorizedRows = rows.filter(row => sourceAccess.get(sourceAccessKey(row)))
    const query = input.query.trim().toLocaleLowerCase('zh-CN')
    const tokens = tokenize(query)
    return authorizedRows
      .map(row => ({ row, score: relevanceScore(row.title, row.content, query, tokens) }))
      .filter(candidate => candidate.score >= 2)
      .sort((left, right) => right.score - left.score || right.row.version - left.row.version)
      .slice(0, maxContextMemories)
      .map(({ row, score }) => ({
        memoryVersionId: row.memoryVersionId,
        title: row.title,
        version: row.version,
        kind: row.kind,
        visibility: row.visibility,
        contentDigest: row.contentDigest,
        excerpt: buildExcerpt(row.content, tokens),
        relevanceScore: score,
      }))
  }

  async assertCurrentReferences(manifest: Pick<RuntimeManifest, 'memory_context' | 'user_context' | 'workspace_id' | 'agent_version_id'>): Promise<void> {
    const memories = manifest.memory_context
    if (!memories?.length) return
    const targetAuthorization = await this.authorization.authorizeWorkbench({
      userId: manifest.user_context.user_id,
      workspaceId: manifest.workspace_id,
    })
    const ids = memories.map(item => item.memoryVersionId)
    const currentRoleIds = await this.currentAgentRoles(
      manifest.agent_version_id,
      targetAuthorization.roleIds.filter(roleId => manifest.user_context.role_ids.includes(roleId)),
    )
    if (!currentRoleIds.length) throw authorizationDenied('Agent 当前身份或角色已不允许使用受控记忆')
    const roleIds = currentRoleIds.length
      ? [...new Set(currentRoleIds)]
      : ['__no_role__']
    const rows = await this.database<{ id: string; contentDigest: string; sourceUserId: string; sourceWorkspaceId: string }[]>`
      select mv.id, mv.content_digest as "contentDigest", c.source_user_id as "sourceUserId",
             c.workspace_id as "sourceWorkspaceId"
        from memory_versions mv
        join memory_entries me on me.tenant_id = mv.tenant_id and me.id = mv.entry_id
        join agent_versions owner_av on owner_av.tenant_id = me.tenant_id and owner_av.id = me.agent_version_id
        join agent_versions target_av on target_av.tenant_id = me.tenant_id
          and target_av.id = ${manifest.agent_version_id} and target_av.agent_id = owner_av.agent_id
          and target_av.status <> 'disabled'
        join execution_principals ep on ep.tenant_id = me.tenant_id and ep.agent_id = target_av.agent_id
          and ep.kind = 'agent' and ep.status = 'active'
        join memory_candidates mc on mc.tenant_id = mv.tenant_id and mc.id = mv.candidate_id
        join memory_consents c on c.tenant_id = mc.tenant_id and c.id = mc.consent_id
       where me.tenant_id = ${tenantId} and mv.id in ${this.database(ids)}
         and mc.status = 'approved' and c.status = 'active'
         and mv.retention_until > now() and c.retention_until > now()
         and (
           (mv.visibility = 'private' and mv.scope_ref = ${manifest.user_context.user_id}
             and ${targetAuthorization.workspaceType} = 'personal')
           or (mv.visibility = 'workspace' and mv.scope_ref = ${manifest.workspace_id})
           or mv.visibility = 'organization'
         )
         and (jsonb_array_length(mv.allowed_role_ids) = 0 or exists (
           select 1 from jsonb_array_elements_text(mv.allowed_role_ids) role_id
            where role_id in ${this.database(roleIds)}
         ))
    `
    const sourceAccess = await this.resolveSourceAccess(rows)
    const current = new Map(rows
      .filter(row => sourceAccess.get(sourceAccessKey(row)))
      .map(row => [row.id, row.contentDigest]))
    if (memories.some(item => current.get(item.memoryVersionId) !== item.contentDigest)) {
      throw authorizationDenied('受控记忆已撤回、过期或不再符合当前使用范围')
    }
  }

  async addCitationFooter(attemptId: string, answer: string): Promise<string> {
    const rows = await this.database<{ title: string; version: number; visibility: MemoryVisibility }[]>`
      select mv.title, mv.version, mv.visibility from run_memory_sources rms
      join memory_versions mv on mv.tenant_id = rms.tenant_id and mv.id = rms.memory_version_id
      where rms.tenant_id = ${tenantId} and rms.attempt_id = ${attemptId}
      order by rms.relevance_score desc, mv.published_at desc
    `
    if (!rows.length) return answer
    return `${answer.trim()}\n\n受控记忆参考（非权威业务事实）\n${rows.map((row, index) =>
      `- 【M${index + 1}】${row.title} v${row.version}（${visibilityLabel(row.visibility)}）`,
    ).join('\n')}`
  }

  private async currentAgentRoles(agentVersionId: string | null, candidateRoles: string[]): Promise<string[]> {
    if (!agentVersionId || !candidateRoles.length) return []
    const [target] = await this.database<{ declaredRoles: string[]; grantedRoles: string[] }[]>`
      select av.visible_role_ids as "declaredRoles",
             coalesce(jsonb_agg(g.role_id) filter (where g.role_id is not null), '[]'::jsonb) as "grantedRoles"
        from agent_versions av
        join execution_principals ep on ep.tenant_id = av.tenant_id and ep.agent_id = av.agent_id
          and ep.kind = 'agent' and ep.status = 'active'
        left join agent_principal_role_grants g on g.tenant_id = ep.tenant_id and g.principal_id = ep.id
       where av.tenant_id = ${tenantId} and av.id = ${agentVersionId} and av.status <> 'disabled'
       group by av.id
    `
    if (!target) return []
    const declared = new Set(target.declaredRoles)
    const granted = new Set(target.grantedRoles)
    return candidateRoles.filter(roleId => declared.has(roleId) && granted.has(roleId))
  }

  private async resolveSourceAccess<T extends { sourceUserId: string; sourceWorkspaceId: string }>(
    rows: T[],
  ): Promise<Map<string, boolean>> {
    const sources = new Map<string, T>()
    for (const row of rows) sources.set(sourceAccessKey(row), row)
    const decisions = await Promise.all([...sources.entries()].map(async ([key, source]) => {
      try {
        await this.authorization.authorizeWorkbench({
          userId: source.sourceUserId,
          workspaceId: source.sourceWorkspaceId,
        })
        return [key, true] as const
      } catch (error) {
        if (!isAuthorizationDenial(error)) throw error
        return [key, false] as const
      }
    }))
    return new Map(decisions)
  }
}

function sourceAccessKey(source: { sourceUserId: string; sourceWorkspaceId: string }): string {
  return `${source.sourceUserId}\u0000${source.sourceWorkspaceId}`
}

function mapCandidate(row: CandidateRow): ControlledMemoryCandidate {
  return {
    id: row.id,
    consentId: row.consentId,
    memoryKey: row.memoryKey,
    kind: row.kind,
    title: row.title,
    content: row.content,
    contentDigest: row.contentDigest,
    visibility: row.visibility,
    scopeRef: row.scopeRef,
    retentionUntil: row.retentionUntil.toISOString(),
    status: row.status,
    submittedBy: row.submittedBy,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewComment: row.reviewComment,
    approvedEntryId: row.approvedEntryId,
    approvedVersionId: row.approvedVersionId,
    createdAt: row.createdAt.toISOString(),
  }
}

function tokenize(value: string): string[] {
  const tokens = new Set<string>()
  for (const word of value.match(/[a-z0-9_-]{2,}/g) ?? []) tokens.add(word)
  for (const sequence of value.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    if (sequence.length <= 4) tokens.add(sequence)
    for (let index = 0; index < sequence.length - 1; index += 1) tokens.add(sequence.slice(index, index + 2))
  }
  return [...tokens]
}

function relevanceScore(title: string, content: string, query: string, tokens: string[]): number {
  let score = 0
  const lowerTitle = title.toLocaleLowerCase('zh-CN')
  const lowerContent = content.toLocaleLowerCase('zh-CN')
  if (query && lowerTitle.includes(query)) score += 8
  for (const token of tokens) {
    if (lowerTitle.includes(token)) score += 4
    if (lowerContent.includes(token)) score += 1
  }
  return score
}

function buildExcerpt(content: string, tokens: string[]): string {
  const lower = content.toLocaleLowerCase('zh-CN')
  const firstMatch = tokens.map(token => lower.indexOf(token)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, firstMatch - 160)
  const excerpt = content.slice(start, start + maxExcerptCharacters).trim()
  return `${start > 0 ? '…' : ''}${excerpt}${start + excerpt.length < content.length ? '…' : ''}`
}

function visibilityLabel(value: MemoryVisibility): string {
  if (value === 'private') return '仅本人'
  if (value === 'workspace') return '当前工作空间'
  return '组织范围'
}
