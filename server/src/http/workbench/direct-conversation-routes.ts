import {
  parseDirectLimit,
  type PostgresDirectConversationService,
} from '../../modules/workbench/application/postgres-direct-conversation-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, routeValidationFailed, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

/**
 * 同事私聊。只服务移动端；不并入 conversation-targets，PC 员工端不调用这些路由。
 * 发送只追加文本，不创建 Run。
 */
export function registerDirectConversationRoutes(
  router: Router,
  conversations: PostgresDirectConversationService,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  router.get(`${basePath}/me/direct-conversations`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const params = context.url.searchParams
    return envelope('workbench', await conversations.list({
      userId: identity.userId,
      ...(params.get('cursor') ? { cursor: params.get('cursor') ?? undefined } : {}),
      limit: parseDirectLimit(params.get('limit')),
    }), adapter)
  })

  router.get(`${basePath}/direct-conversations/with/:userId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const peerUserId = requireUserId(context.params['userId'])
    return envelope('workbench', await conversations.lookup({ userId: identity.userId, peerUserId }), adapter)
  })

  router.get(`${basePath}/direct-conversations/:id/messages`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const params = context.url.searchParams
    return envelope('workbench', await conversations.listMessages({
      userId: identity.userId,
      conversationId: requireObjectId(context.params['id'], '私聊'),
      ...(params.get('cursor') ? { cursor: params.get('cursor') ?? undefined } : {}),
      limit: parseDirectLimit(params.get('limit')),
    }), adapter)
  })

  router.post(`${basePath}/direct-conversations/with/:userId/messages`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readJsonBody<unknown>(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw routeValidationFailed('请求体必须是对象')
    return envelope('workbench', await conversations.send({
      userId: identity.userId,
      peerUserId: requireUserId(context.params['userId']),
      content: (body as { content?: unknown }).content,
    }), adapter)
  })

  router.post(`${basePath}/direct-conversations/with/:userId/read`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readJsonBody<unknown>(request)
    if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body))) throw routeValidationFailed('请求体必须是对象')
    const raw = (body as { upTo?: unknown } | undefined)?.upTo
    let upTo: Date | undefined
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) throw routeValidationFailed('upTo 必须是 ISO 时间')
      upTo = new Date(raw)
    }
    return envelope('workbench', await conversations.markRead({
      userId: identity.userId,
      peerUserId: requireUserId(context.params['userId']),
      ...(upTo ? { upTo } : {}),
    }), adapter)
  })

  router.post(`${basePath}/direct-conversations/:id/hide`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', await conversations.hide({
      userId: identity.userId,
      conversationId: requireObjectId(context.params['id'], '私聊'),
    }), adapter)
  })
}

function requireUserId(raw: string | undefined) {
  const userId = (raw ?? '').trim()
  if (!userId || userId.length > 200) throw routeValidationFailed('用户标识无效')
  return userId
}

function requireObjectId(raw: string | undefined, label: string) {
  const id = (raw ?? '').trim()
  if (!id || id.length > 200) throw routeValidationFailed(`${label}标识无效`)
  return id
}
