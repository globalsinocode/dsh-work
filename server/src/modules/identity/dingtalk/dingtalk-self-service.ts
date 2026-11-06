import { randomUUID } from 'node:crypto'

import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import { notFound } from '../../../domain/request-errors.ts'
import { invalidateUserBindings } from './dingtalk-bindings.ts'
import { readOwnBinding, type DingTalkBindingView } from './dingtalk-admin-service.ts'
import type { DingTalkSettingsProvider } from './dingtalk-settings.ts'

const tenantId = 'tenant-dsh-work'

/** 用户中心 › 钉钉（钉钉接入 DT-S1，原型④）：`enabled` 为部署是否配置了钉钉应用。 */
export interface DingTalkSelfBindingView extends DingTalkBindingView {
  enabled: boolean
}

export interface DingTalkSelfBindingStore {
  get(userId: string): Promise<DingTalkSelfBindingView>
  unbind(userId: string): Promise<DingTalkSelfBindingView>
}

const emptyView: DingTalkBindingView = { status: 'unbound', binding: null, invalid: null, selfRebindLocked: false }

/** 员工只能查看与解除本人的绑定；不能自行绑定（绑定只在钉钉内登录或由管理员代绑）。 */
export class PostgresDingTalkSelfBindingService implements DingTalkSelfBindingStore {
  private readonly database: DatabaseClient
  private readonly settings: DingTalkSettingsProvider

  constructor(database: DatabaseClient, settings: DingTalkSettingsProvider) {
    this.database = database
    this.settings = settings
  }

  async get(userId: string): Promise<DingTalkSelfBindingView> {
    // AI Hub 账号不绑定钉钉。
    const [local] = await this.database`
      select 1 from users where tenant_id = ${tenantId} and id = ${userId} and identity_provider = 'local'
    `
    if (!local) return { ...emptyView, enabled: false }
    return { ...await readOwnBinding(this.database, userId), enabled: await this.settings.current() !== null }
  }

  /** 员工自行解绑：绑定失效、按 binding_id 撤销钉钉会话（含当前的钉钉会话），同一事务；不锁定自行绑定。 */
  async unbind(userId: string): Promise<DingTalkSelfBindingView> {
    await this.database.begin(async transaction => {
      await transaction`select id from users where tenant_id = ${tenantId} and id = ${userId} for update`
      const invalidated = await invalidateUserBindings(transaction, userId, 'self_unbind')
      if (!invalidated.length) throw notFound('你没有有效的钉钉绑定')
      await transaction`
        insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
        values (${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${userId}, 'identity.dingtalk.self_unbind', 'dingtalk_binding',
          ${userId}, 'success', ${`trace-dingtalk-${randomUUID()}`}, ${transaction.json({ channel: 'dingtalk', bindingId: invalidated[0]!.id })})
      `
    })
    return this.get(userId)
  }
}
