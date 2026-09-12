import type { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { PostgresWorkspaceAgentMemberService } from '../../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import type { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import type { RunRepository } from '../../modules/run/run-repository.ts'
import type { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { authorizationDenied, canReadWorkspaceObject } from '../../modules/authorization/authorization-errors.ts'
import type { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import type { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import {
  envelope,
  httpResult,
  readJsonBody,
  requireRequestIdentity,
  routePermissionDenied,
  routeValidationFailed,
  sessionAuthorizationContext,
  type Router,
} from '../router.ts'

const basePath = '/api/workbench/v1'
const tenantId = 'tenant-dsh-work'

export function registerConversationRoutes(
  router: Router,
  conversations: PostgresConversationRepository,
  orchestration: RunOrchestrationService,
  runs: RunRepository,
  agents: PostgresAgentService,
  authorization?: PostgresAuthorizationService,
  operations?: PostgresOperationsService,
  skills?: PostgresSkillService,
  agentMembers?: PostgresWorkspaceAgentMemberService,
) {
  router.get(`${basePath}/tasks`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const tasks = await conversations.listTasks(userId)
    // 团队空间运行在收权后必须停止交付：列表与详情同样只按发起人过滤，因此这里
    // 逐条复核当前团队读权限，失权空间的条目直接不返回（与 SSE 同一口径）。
    const visible = authorization
      ? (await Promise.all(tasks.map(async task =>
          (await authorizeTeamTaskRead(authorization, task, userId)) ? task : null,
        ))).filter((task): task is (typeof tasks)[number] => task !== null)
      : tasks
    return envelope('workbench', visible, 'postgres')
  })

  // 团队历史会话分页（1B-T1）：返回 Session 摘要（不含正文），任何当前成员可读；
  // 非成员与个人空间一律拒绝，与收权口径一致（AC-23）。
  // 3-T1 读取轨：历史会话属于「只读保留」，归档后现任成员仍可读取，因此这里用
  // 状态无关的 readableWorkspaceTypeOf + purpose:'read'（默认的执行轨仍只认 active）。
  router.get(`${basePath}/workspaces/:workspaceId/sessions`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    // 读取轨（3-T1）。空间不存在/非团队时的拒绝必须与「非成员」同状态码，否则可用
    // 状态码区分空间是否存在（符合性评审 P1-3：此前抛「仅支持…」被归为 422）。
    const workspaceType = await authorization?.readableWorkspaceTypeOf(workspaceId)
    if (workspaceType !== 'team') {
      throw authorizationDenied('工作空间不存在、已归档或当前用户不是成员')
    }
    await authorization?.requireTeamRole(
      workspaceId,
      userId,
      ['owner', 'admin', 'member', 'viewer'],
      { purpose: 'read' },
    )
    const limit = parseSessionPageLimit(context.url.searchParams.get('limit'))
    const query = (context.url.searchParams.get('query') ?? '').trim()
    const cursor = context.url.searchParams.get('cursor') ?? undefined
    return envelope(
      'workbench',
      await conversations.listWorkspaceSessions({ workspaceId, actorUserId: userId, query, cursor, limit }),
      'postgres',
    )
  })

  router.post(`${basePath}/sessions`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    const authorizationContext = sessionAuthorizationContext(identity)
    const body = await readJsonBody<{
      title: string
      workspaceId?: string
      agentId?: string
      skillId?: string
      workspaceAgentMemberId?: string
    }>(request)
    const access = await authorization?.authorizeWorkbench({ userId, ...authorizationContext })
    // Team workspaces must start sessions through the agent member
    // association (pinned version); personal workspaces, non-members and
    // omitted workspaceIds keep the existing resolution path untouched
    // (AC-23).
    const selectedSkillVersion = body.skillId && skills
      ? await skills.resolveWorkbenchSkillVersion(body.skillId)
      : undefined
    const workspaceType = await authorization?.resolveWorkspaceType(body.workspaceId, userId)
    const agentVersionId = workspaceType === 'team'
      ? await resolveTeamSessionAgentVersion(agentMembers, agents, body, userId, access?.roleIds ?? identity.roleIds)
      : await agents.resolveWorkbenchAgentVersion(
          body.agentId,
          userId,
          access?.roleIds ?? identity.roleIds,
          selectedSkillVersion ? [selectedSkillVersion.reference] : [],
        )
    const session = await orchestration.createSession({
      userId,
      title: body.title,
      workspaceId: body.workspaceId,
      agentVersionId,
      selectedSkillVersionId: selectedSkillVersion?.id,
      selectedSkillReference: selectedSkillVersion?.reference,
      authorizationContext,
    })
    return httpResult(201, envelope('workbench', session, 'postgres'))
  })

  if (skills) {
    router.get(`${basePath}/skills`, async (_request, context) => {
      const identity = requireRequestIdentity(context, 'workbench')
      await authorization?.authorizeWorkbench({
        userId: identity.userId,
        ...sessionAuthorizationContext(identity),
      })
      return envelope('workbench', await skills.listWorkbenchSkills(), 'postgres')
    })
  }

  router.delete(`${basePath}/sessions/:sessionId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const sessionId = context.params['sessionId'] ?? ''
    const archived = await conversations.archiveSession(sessionId, userId)
    await operations?.appendAudit(
      userId,
      'session.delete',
      sessionId,
      'success',
      `trace-session-${crypto.randomUUID()}`,
      '员工删除对话',
      'session',
    ).catch((error: unknown) => console.error('session deletion audit failed', error))
    return envelope('workbench', archived, 'postgres')
  })

  router.get(`${basePath}/runs/:runId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const task = await conversations.getTask(context.params['runId'] ?? '', userId)
    if (!task) return httpResult(404, { error: { code: 'run_not_found', message: 'Run 不存在或不可访问' } })
    // 团队空间运行详情与 SSE 同一收权口径：被移出的成员不得再读到正文。
    if (authorization && !(await authorizeTeamTaskRead(authorization, task, userId))) {
      return httpResult(404, { error: { code: 'run_not_found', message: 'Run 不存在或不可访问' } })
    }
    return envelope('workbench', task, 'postgres')
  })

  router.post(`${basePath}/sessions/:sessionId/runs`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    const body = await readJsonBody<{ prompt: string; idempotencyKey?: string; fileIds?: string[] }>(request)
    if (body.fileIds !== undefined && (!Array.isArray(body.fileIds) || body.fileIds.some(id => typeof id !== 'string'))) {
      throw new Error('fileIds 必须是文件标识数组')
    }
    if ((body.fileIds?.length ?? 0) > 5) throw new Error('每次 Run 最多分析 5 个文件')
    const headerKey = request.headers['idempotency-key']
    const run = await orchestration.startRun({
      userId,
      sessionId: context.params['sessionId'] ?? '',
      prompt: body.prompt,
      idempotencyKey: body.idempotencyKey ?? (Array.isArray(headerKey) ? headerKey[0] : headerKey) ?? crypto.randomUUID(),
      fileIds: body.fileIds ?? [],
      authorizationContext: sessionAuthorizationContext(identity),
    })
    if (!run) throw new Error('Run 创建失败')
    const task = await conversations.getTask(run.id, userId)
    return httpResult(202, envelope('workbench', task, 'postgres'))
  })

  router.post(`${basePath}/runs/:runId/cancel`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await orchestration.cancel(
      context.params['runId'] ?? '',
      userId,
      sessionAuthorizationContext(identity),
    )
    const task = await conversations.getTask(context.params['runId'] ?? '', userId)
    // 取消与重试同样返回完整正文，必须与详情/列表用同一团队读取口径，否则被移出
    // 成员可借这些接口读回回答内容（AC-09）。
    if (!task || (authorization && !(await authorizeTeamTaskRead(authorization, task, userId)))) {
      return httpResult(404, { error: { code: 'run_not_found', message: 'Run 不存在或不可访问' } })
    }
    return httpResult(202, envelope('workbench', task, 'postgres'))
  })

  router.post(`${basePath}/runs/:runId/retry`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await orchestration.retry(
      context.params['runId'] ?? '',
      userId,
      sessionAuthorizationContext(identity),
    )
    const task = await conversations.getTask(context.params['runId'] ?? '', userId)
    if (!task || (authorization && !(await authorizeTeamTaskRead(authorization, task, userId)))) {
      return httpResult(404, { error: { code: 'run_not_found', message: 'Run 不存在或不可访问' } })
    }
    return httpResult(202, envelope('workbench', task, 'postgres'))
  })

  router.get(`${basePath}/runs/:runId/events`, async (request, context, response) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const runId = context.params['runId'] ?? ''
    const task = await conversations.getTask(runId, userId)
    if (!task) return httpResult(404, { error: { code: 'run_not_found', message: 'Run 不存在或不可访问' } })
    // 团队空间运行启用逐批写出拦截（1A-T5）；个人/独立空间保持原路径（AC-23）。
    // 空间类型必须用不依赖调用者当前成员身份的解析器判定：被移出团队空间的用户仍是
    // 该 run 的 requested_by（getTask 只按 requested_by 判定），若用成员相关的
    // resolveWorkspaceType，他会解析出 null 并**降级到无拦截的个人路径**，建连与逐批
    // 检查全部失效。这里是 fail-closed：非成员一律 403，不降级。
    //
    // 3-T1：读轨用状态无关的 readableWorkspaceTypeOf，归档空间仍解析为 team 并走
    // `canReadWorkspaceObject`（现任成员可读，被移出成员拒绝）；执行轨（排队领取与
    // 执行前复核）仍用只认 active 的 workspaceTypeOf，见 run-orchestration-service。
    if (task.workspaceId && authorization) {
      const workspaceType = await authorization.readableWorkspaceTypeOf(task.workspaceId)
      if (workspaceType === 'team') {
        // 团队空间：建连与逐批写出都走同一读取门禁；非成员与已删除空间一律
        // fail-closed 403，不降级为无拦截的个人路径。归档空间的现任成员按
        // 「归档=只读保留」继续读取。显式包装为权限错误，避免依赖错误消息文本分类。
        if (!(await canReadWorkspaceObject(authorization, task.workspaceId, userId))) {
          throw routePermissionDenied('当前用户不能读取该团队空间运行')
        }
        await streamRunEvents(response, request.headers['last-event-id'], runId, runs, 250, 15_000, {
          workspaceId: task.workspaceId,
          userId,
          authorization,
        })
        return
      }
      // 空间不存在（类型解析为 null）：与详情、列表、文件、成果同一口径
      // fail-closed，不能当作「非团队」放行（1B-T4 / §6.5-3）。
      if (workspaceType === null) {
        throw routePermissionDenied('该工作空间不存在或已归档')
      }
    }
    await streamRunEvents(response, request.headers['last-event-id'], runId, runs)
  })
}

/**
 * Team-run read gate shared by the REST detail and list routes (1A-T5 收权口径).
 * Uses the membership-independent workspaceTypeOf so a removed member cannot be
 * mistaken for a personal-space reader, and returns false instead of throwing so
 * callers can 404/omit. Personal and standalone runs are unaffected (AC-23).
 */
function parseSessionPageLimit(raw: string | null) {
  if (raw === null || raw === '') return undefined
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw routeValidationFailed('limit 必须为 1 到 100 之间的整数')
  return limit
}

/**
 * 团队运行/结果的读取门禁。口径与文件、成果读取共用
 * `canReadWorkspaceObject`（1B-T4 / §6.5-3「团队文件下载与结果读取采用相同
 * 授权边界」），避免两处各自实现后在归档、个人空间等边界上漂移。
 */
async function authorizeTeamTaskRead(
  authorization: PostgresAuthorizationService,
  task: { workspaceId: string },
  userId: string,
): Promise<boolean> {
  return canReadWorkspaceObject(authorization, task.workspaceId, userId)
}

/**
 * Team session start must go through the agent member association (TW-02
 * 单一会话绑定): the member's pinned version is used instead of the
 * platform's current active version. A team request without the association
 * — or one whose raw agentId resolves to a version different from the
 * member's pinned version — is rejected so the session can never silently
 * switch agent versions.
 */
async function resolveTeamSessionAgentVersion(
  agentMembers: PostgresWorkspaceAgentMemberService | undefined,
  agents: PostgresAgentService,
  body: { workspaceId?: string; agentId?: string; workspaceAgentMemberId?: string },
  userId: string,
  roleIds: string[],
) {
  if (!agentMembers || !body.workspaceId || !body.workspaceAgentMemberId) {
    throw new Error('团队空间对话必须通过 Agent 成员关联发起')
  }
  const member = await agentMembers.requireAvailableAgentMemberVersion(
    body.workspaceId,
    body.workspaceAgentMemberId,
  )
  if (body.agentId !== undefined) {
    const rawVersionId = await agents.resolveWorkbenchAgentVersion(body.agentId, userId, roleIds)
    if (rawVersionId !== member.agentVersionId) {
      throw new Error('团队空间对话必须通过 Agent 成员关联发起')
    }
  }
  return member.agentVersionId
}

export interface TeamStreamAccess {
  workspaceId: string
  userId: string
  authorization: {
    readableWorkspaceTypeOf(workspaceId: string | null | undefined): Promise<'personal' | 'team' | null>
    authorizeTeamReadAccess(workspaceId: string, userId: string, options: { allowArchived: boolean }): Promise<void>
  }
  /** Cache TTL override; defaults to the authorization service's TTL (≤ 10s). */
  ttlMs?: number
}

/**
 * SSE delivery loop. The team branch (1A-T5) re-verifies the viewer's read
 * access before each batch write AND before the heartbeat: the authorization
 * cache is keyed by (workspace, team_auth_revision) with a short TTL, so a
 * revocation (revision bump) terminates the stream on the next poll and
 * undelivered content is dropped. The check runs immediately before the
 * write — content read while the check passed is in-flight by definition
 * (plan 6.5: 已经开始写出的内容无法回收); nothing after a failed check is
 * ever written. The personal path stays exactly as before (AC-23).
 */
export async function streamRunEvents(
  response: RunEventStreamResponse,
  lastEventHeader: string | string[] | undefined,
  runId: string,
  runs: Pick<RunRepository, 'readEventsAfterEvent' | 'getRun'>,
  pollIntervalMs = 250,
  heartbeatIntervalMs = 15_000,
  teamAccess?: TeamStreamAccess,
) {
  response.writeHead(200, {
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()
  let cursor = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader
  let closed = false
  response.on('close', () => { closed = true })
  let emptyTerminalPolls = 0
  let heartbeatAt = Date.now()

  while (!closed) {
    const events = await runs.readEventsAfterEvent(tenantId, runId, cursor)
    if (events.length > 0 && teamAccess && !(await hasStreamAccess(teamAccess))) break
    for (const event of events) {
      cursor = event.id
      response.write(`id: ${event.id}\n`)
      response.write(`event: ${event.eventType}\n`)
      response.write(`data: ${JSON.stringify({
        event_id: event.id,
        run_id: event.runId,
        attempt_id: event.attemptId,
        sequence: event.sequence,
        event_type: event.eventType,
        occurred_at: event.occurredAt,
        display_message: event.displayMessage,
        safe_metadata: event.safeMetadata,
        trace_id: event.traceId,
      })}\n\n`)
    }
    const run = await runs.getRun(tenantId, runId)
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status) && events.length === 0) {
      emptyTerminalPolls += 1
      if (emptyTerminalPolls >= 2) break
    } else {
      emptyTerminalPolls = 0
    }
    if (Date.now() - heartbeatAt >= heartbeatIntervalMs) {
      // Check the interval first: the heartbeat authorization probe is the only
      // extra query here, so do not pay for it on every poll.
      if (teamAccess && !(await hasStreamAccess(teamAccess))) break
      response.write(`: heartbeat ${Date.now()}\n\n`)
      heartbeatAt = Date.now()
    }
    await wait(pollIntervalMs)
  }
  if (!closed) response.end()
}

/**
 * Returns false (stream must terminate) when the viewer lost read access.
 * Any unexpected error also terminates the stream — fail closed.
 *
 * 走 `canReadWorkspaceObject`（读取轨）：读门禁按状态无关的空间类型解析，因此
 * **归档空间对现任成员仍交付**；收权（成员变更会提升 team_auth_revision）立即终止流。
 * `ttlMs` 由调用点透传，控制逐批完整复核的间隔。
 */
async function hasStreamAccess(teamAccess: TeamStreamAccess) {
  try {
    return await canReadWorkspaceObject(
      teamAccess.authorization,
      teamAccess.workspaceId,
      teamAccess.userId,
      { ttlMs: teamAccess.ttlMs },
    )
  } catch {
    return false
  }
}

interface RunEventStreamResponse {
  writeHead(statusCode: number, headers: Record<string, string>): unknown
  flushHeaders(): void
  write(chunk: string): boolean
  end(): unknown
  on(event: 'close', listener: () => void): unknown
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}
