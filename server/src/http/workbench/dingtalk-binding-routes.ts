import type { DingTalkSelfBindingStore } from '../../modules/identity/dingtalk/dingtalk-self-service.ts'
import { envelope, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

/** 用户中心 › 钉钉：查看与解除本人的钉钉绑定（钉钉接入方案第 5 节）。只操作当前登录账号。 */
export function registerDingTalkBindingRoutes(
  router: Router,
  bindings: DingTalkSelfBindingStore,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  router.get(`${basePath}/me/dingtalk-binding`, async (_request, context) =>
    envelope('workbench', await bindings.get(requireRequestIdentity(context, 'workbench').userId), adapter))
  router.delete(`${basePath}/me/dingtalk-binding`, async (_request, context) =>
    envelope('workbench', await bindings.unbind(requireRequestIdentity(context, 'workbench').userId), adapter))
}
