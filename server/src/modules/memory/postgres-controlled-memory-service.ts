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

  async submitCandidate(input: {
    userId: string
    attemptId: string
    submissionKey: string
    kind: MemoryKind
    title: string
    content: string
    visibility: MemoryVisibility
    retentionDays: number
  }): Promise<ControlledMemoryCandidate> {
    const title = input.title.trim()
    const content = input.content.trim()
    if (title.length < 3 || title.length > 120) throw requestInvalid('title 长度必须为 3～120 个字符')
    if (content.length < 20 || content.length > 4000) throw requestInvalid('content 长度必须为 20～4000 个字符')
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650) {
      throw requestInvalid('retentionDays 必须为 1～3650 的整数')
    }
    if (!input.submissionKey.trim() || input.submissionKey.length > 200) throw requestInvalid('submissionKey 无效')
    const [source] = await this.database<{
      runId: string; requestedBy: string; workspaceId: string | null; attemptStatus: string;
      agentVersionId: string | null; roleIds: unknown; agentStatus: string | null
    }[]>`
      select r.id as "runId", r.requested_by as "requestedBy", t.workspace_id as "workspaceId",
             ra.status as "attemptStatus", ra.manifest->>'agent_version_id' as "agentVersionId",
             ra.manifest->'user_context'->'role_ids' as "roleIds", av.status as "agentStatus"
        from run_attempts ra
        join runs r on r.tenant_id = ra.tenant_id and r.id = ra.run_id
        join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
        left join agent_versions av on av.tenant_id = ra.tenant_id and av.id = ra.manifest->>'agent_version_id'
       where ra.tenant_id = ${tenantId} and ra.id = ${input.attemptId}
    `
    if (!source || source.requestedBy !== input.userId) throw authorizationDenied('来源 Attempt 不存在或不属于当前用户')
    if (source.attemptStatus !== 'succeeded') throw requestInvalid('只有成功完成的 Attempt 可以作为记忆候选来源')
    if (!source.workspaceId || !source.agentVersionId || source.agentStatus !== 'published') {
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
      .update(`${source.agentVersionId}\n${input.kind}\n${normalizedTitle}\n${input.visibility}\n${scopeRef}`)
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
          content_digest, visibility, scope_ref, allowed_role_ids, retention_until, status, submitted_by
        ) values (
          ${candidateId}, ${tenantId}, ${consentId}, ${input.submissionKey.trim()}, ${requestDigest}, ${memoryKey}, ${input.kind},
          ${title}, ${content}, ${contentDigest}, ${input.visibility}, ${scopeRef}, ${transaction.json(roles)},
          ${retentionUntil}, 'pending', ${input.userId}
        ) returning id, consent_id as "consentId", memory_key as "memoryKey", kind, title, content,
          content_digest as "contentDigest", visibility, scope_ref as "scopeRef",
          retention_until as "retentionUntil", status, submitted_by as "submittedBy",
          reviewed_by as "reviewedBy", reviewed_at as "reviewedAt", review_comment as "reviewComment",
          resolution_key as "resolutionKey", approved_entry_id as "approvedEntryId",
          approved_version_id as "approvedVersionId", created_at as "createdAt"
      `
      if (!created) throw new Error('记忆候选创建失败')
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

  async reviewCandidate(input: {
    candidateId: string
    decision: 'approved' | 'rejected'
    actor: string
    resolutionKey: string
    comment?: string
  }): Promise<ControlledMemoryCandidate> {
    const outcome = await this.database.begin(async (transaction) => {
      const [candidate] = await transaction<(CandidateRow & {
        consentStatus: string; consentAgentVersionId: string; consentSourceUserId: string;
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
               c.source_user_id as "consentSourceUserId", c.source_run_id as "sourceRunId",
               c.source_attempt_id as "sourceAttemptId", c.workspace_id as "sourceWorkspaceId",
               c.retention_until as "consentRetentionUntil"
          from memory_candidates mc
          join memory_consents c on c.tenant_id = mc.tenant_id and c.id = mc.consent_id
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
      await transaction`select pg_advisory_xact_lock(hashtext(${candidate.memoryKey}))`
      let [entry] = await transaction<{ id: string; currentVersionId: string | null }[]>`
        select id, current_version_id as "currentVersionId" from memory_entries
         where tenant_id = ${tenantId} and memory_key = ${candidate.memoryKey} and kind = ${candidate.kind}
           and visibility = ${candidate.visibility} and scope_ref = ${candidate.scopeRef}
           and agent_version_id = ${candidate.consentAgentVersionId} for update
      `
      if (!entry) {
        const entryId = `memory-entry-${randomUUID()}`
        ;[entry] = await transaction<{ id: string; currentVersionId: string | null }[]>`
          insert into memory_entries (id, tenant_id, memory_key, kind, visibility, scope_ref, agent_version_id)
          values (${entryId}, ${tenantId}, ${candidate.memoryKey}, ${candidate.kind}, ${candidate.visibility},
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
    await this.operations?.appendAudit(input.actor, `memory.candidate.${input.decision}`, input.candidateId, 'success', `trace-${input.candidateId}`, input.comment ?? input.decision)
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
    const currentRoleIds = targetAuthorization.roleIds.filter(roleId => input.roleIds.includes(roleId))
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
        join memory_candidates mc on mc.tenant_id = mv.tenant_id and mc.id = mv.candidate_id
        join memory_consents c on c.tenant_id = mc.tenant_id and c.id = mc.consent_id
       where me.tenant_id = ${tenantId} and me.agent_version_id = ${input.agentVersionId}
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
    const currentRoleIds = targetAuthorization.roleIds.filter(roleId => manifest.user_context.role_ids.includes(roleId))
    const roleIds = currentRoleIds.length
      ? [...new Set(currentRoleIds)]
      : ['__no_role__']
    const rows = await this.database<{ id: string; contentDigest: string; sourceUserId: string; sourceWorkspaceId: string }[]>`
      select mv.id, mv.content_digest as "contentDigest", c.source_user_id as "sourceUserId",
             c.workspace_id as "sourceWorkspaceId"
        from memory_versions mv
        join memory_entries me on me.tenant_id = mv.tenant_id and me.id = mv.entry_id
        join memory_candidates mc on mc.tenant_id = mv.tenant_id and mc.id = mv.candidate_id
        join memory_consents c on c.tenant_id = mc.tenant_id and c.id = mc.consent_id
       where me.tenant_id = ${tenantId} and mv.id in ${this.database(ids)}
         and me.agent_version_id = ${manifest.agent_version_id}
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
