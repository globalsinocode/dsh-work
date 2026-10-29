import {
  parseTargetLimit,
  parseTargetQuery,
  type ConversationTargetStore,
} from '../../modules/workbench/application/conversation-targets.ts'
import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, routeValidationFailed, sessionAuthorizationContext, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

type WorkbenchAccess = Pick<PostgresAuthorizationService, 'authorizeWorkbench'>

/**
 * 协作模式对话对象（S5c / S5e，项目空间方案 12.6）。除本人已读位置外均为只读接口，均按当前登录账号本人：
 * 单聊聚合本人的个人会话，群组只含本人当前所在的活动项目空间。发送消息仍走既有
 * `POST /sessions`（开启会话）与 `POST /sessions/:id/runs`（续写），不新增执行入口。
 */
export function registerConversationTargetRoutes(
  router: Router,
  targets: ConversationTargetStore,
  authorization?: WorkbenchAccess,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  const authorize = async (identity: ReturnType<typeof requireRequestIdentity>) => {
    const access = await authorization?.authorizeWorkbench({ userId: identity.userId, ...sessionAuthorizationContext(identity) })
    return access?.roleIds ?? identity.roleIds
  }

  router.get(`${basePath}/me/conversation-targets`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const roleIds = await authorize(identity)
    const params = context.url.searchParams
    const query = parseTargetQuery(params.get('query'))
    const cursor = params.get('cursor') ?? undefined
    return envelope('workbench', await targets.listTargets({
      userId: identity.userId,
      roleIds,
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
      limit: parseTargetLimit(params.get('limit'), 30),
    }), adapter)
  })

  router.get(`${basePath}/me/conversation-targets/agent/:agentId/sessions`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const roleIds = await authorize(identity)
    const cursor = context.url.searchParams.get('cursor') ?? undefined
    return envelope('workbench', await targets.getAgentConversation({
      userId: identity.userId,
      roleIds,
      agentId: context.params['agentId'] ?? '',
      ...(cursor ? { cursor } : {}),
      limit: parseTargetLimit(context.url.searchParams.get('limit'), 5),
    }), adapter)
  })

  router.get(`${basePath}/me/conversation-targets/resolve`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorize(identity)
    const conversationId = (context.url.searchParams.get('conversation') ?? '').trim()
    if (!conversationId || conversationId.length > 200) throw routeValidationFailed('conversation 必须是对话或运行标识')
    return envelope('workbench', await targets.resolveConversation({ userId: identity.userId, conversationId }), adapter)
  })

  // S5e：本人在对话对象上的已读位置，只写本人的记录，不改变任何业务数据。
  router.post(`${basePath}/me/conversation-targets/:type/:id/read`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorize(identity)
    const type = context.params['type']
    if (type !== 'agent' && type !== 'group') throw routeValidationFailed('type 必须是 agent 或 group')
    const id = (context.params['id'] ?? '').trim()
    if (!id || id.length > 200) throw routeValidationFailed('id 必须是 AI 同事或群组标识')
    const body = await readJsonBody<unknown>(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw routeValidationFailed('请求体必须是对象')
    const raw = (body as { upTo?: unknown }).upTo
    let upTo: Date | undefined
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) throw routeValidationFailed('upTo 必须是 ISO 时间')
      upTo = new Date(raw)
    }
    return envelope('workbench', await targets.markRead({ userId: identity.userId, type, id, ...(upTo ? { upTo } : {}) }), adapter)
  })
  // D38：本人未读的 @ 提醒（按空间与讨论汇总），供工作模式项目空间列表与讨论历史标出“有人@我”。
  router.get(`${basePath}/me/mentions`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorize(identity)
    return envelope('workbench', await targets.listMentions({ userId: identity.userId }), adapter)
  })

  // D38：打开讨论（工作模式）时把本人在该讨论的 @ 提醒标为已读；只写本人的提醒状态。
  router.post(`${basePath}/me/mentions/read`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorize(identity)
    const body = await readJsonBody<unknown>(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw routeValidationFailed('请求体必须是对象')
    const { workspaceId, sessionId } = body as { workspaceId?: unknown; sessionId?: unknown }
    if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 200) {
      throw routeValidationFailed('workspaceId 必须是项目空间标识')
    }
    if (sessionId !== undefined && sessionId !== null && (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200)) {
      throw routeValidationFailed('sessionId 必须是讨论标识')
    }
    return envelope('workbench', await targets.markMentionsRead({
      userId: identity.userId,
      workspaceId: workspaceId.trim(),
      ...(typeof sessionId === 'string' ? { sessionId: sessionId.trim() } : {}),
    }), adapter)
  })
}
