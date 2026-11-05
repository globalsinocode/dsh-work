import { notFound } from '../../domain/request-errors.ts'
import type { DingTalkSelfBindingStore, DingTalkSelfBindingView } from '../../modules/identity/dingtalk/dingtalk-self-service.ts'

/** P0 冒烟：测试身份没有钉钉绑定，页面显示“未绑定”与如何绑定。解绑行为由 P1 覆盖。 */
export class MemoryDingTalkBindingStore implements DingTalkSelfBindingStore {
  async get(): Promise<DingTalkSelfBindingView> {
    return { enabled: true, status: 'unbound', binding: null, invalid: null, selfRebindLocked: false }
  }

  async unbind(): Promise<DingTalkSelfBindingView> {
    throw notFound('你没有有效的钉钉绑定')
  }
}
