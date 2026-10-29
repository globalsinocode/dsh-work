import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import { dependencyUnavailable, invalidRequest } from '../../../domain/request-errors.ts'
import {
  defaultNotificationPreferences,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
} from './notification-preferences.ts'
import type { CollabUnreadPushPayload, RunFinishedPushPayload } from './web-push-copy.ts'

const tenantId = 'tenant-dsh-work'

export interface PushConfigView {
  vapidPublicKey: string
}

export interface PushSubscriptionUpsertResult {
  endpoint: string
  updated: true
}

export interface PushSubscriptionDeleteResult {
  endpoint: string
  deleted: true
}

export interface StoredPushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export type PushDeliveryKind = 'collab_unread' | 'run_finished'

export type WebPushSendResult = { statusCode: number }

export type WebPushSender = (
  subscription: StoredPushSubscription,
  payloadJson: string,
) => Promise<WebPushSendResult>

export interface WebPushServiceOptions {
  vapidPublicKey?: string
  vapidPrivateKey?: string
  vapidSubject?: string
  send?: WebPushSender
}

function vapidConfigured(options: WebPushServiceOptions): boolean {
  return Boolean(
    options.vapidPublicKey?.trim()
    && options.vapidPrivateKey?.trim()
    && options.vapidSubject?.trim(),
  )
}

export function parsePushSubscriptionBody(body: unknown): StoredPushSubscription {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('订阅格式无效')
  }
  const record = body as Record<string, unknown>
  const endpoint = typeof record.endpoint === 'string' ? record.endpoint.trim() : ''
  if (!endpoint.startsWith('https://')) throw invalidRequest('endpoint 无效')
  const keys = record.keys
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
    throw invalidRequest('keys 无效')
  }
  const keyRecord = keys as Record<string, unknown>
  const p256dh = typeof keyRecord.p256dh === 'string' ? keyRecord.p256dh.trim() : ''
  const auth = typeof keyRecord.auth === 'string' ? keyRecord.auth.trim() : ''
  if (!p256dh || !auth) throw invalidRequest('keys 无效')
  return { endpoint, keys: { p256dh, auth } }
}

export function parsePushSubscriptionDeleteBody(body: unknown): { endpoint: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('请求体无效')
  }
  const endpoint = typeof (body as Record<string, unknown>).endpoint === 'string'
    ? String((body as Record<string, unknown>).endpoint).trim()
    : ''
  if (!endpoint) throw invalidRequest('endpoint 无效')
  return { endpoint }
}

export class WebPushService {
  private readonly database: DatabaseClient
  private readonly options: WebPushServiceOptions
  private webPushModule: typeof import('web-push') | null = null

  constructor(database: DatabaseClient, options: WebPushServiceOptions = {}) {
    this.database = database
    this.options = options
  }

  assertConfigured(): PushConfigView {
    if (!vapidConfigured(this.options)) {
      throw dependencyUnavailable('通知服务暂不可用')
    }
    return { vapidPublicKey: this.options.vapidPublicKey!.trim() }
  }

  getConfig(): PushConfigView | null {
    if (!vapidConfigured(this.options)) return null
    return { vapidPublicKey: this.options.vapidPublicKey!.trim() }
  }

  async upsertSubscription(userId: string, body: unknown): Promise<PushSubscriptionUpsertResult> {
    this.assertConfigured()
    const subscription = parsePushSubscriptionBody(body)
    await this.database`
      insert into push_subscriptions (endpoint, tenant_id, user_id, p256dh, auth, created_at, updated_at)
      values (${subscription.endpoint}, ${tenantId}, ${userId}, ${subscription.keys.p256dh}, ${subscription.keys.auth}, now(), now())
      on conflict (endpoint)
        do update set tenant_id = excluded.tenant_id,
                      user_id = excluded.user_id,
                      p256dh = excluded.p256dh,
                      auth = excluded.auth,
                      updated_at = excluded.updated_at
    `
    return { endpoint: subscription.endpoint, updated: true }
  }

  async deleteSubscription(userId: string, body: unknown): Promise<PushSubscriptionDeleteResult> {
    const { endpoint } = parsePushSubscriptionDeleteBody(body)
    await this.database`
      delete from push_subscriptions
       where tenant_id = ${tenantId} and user_id = ${userId} and endpoint = ${endpoint}
    `
    return { endpoint, deleted: true }
  }

  async getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
    const [row] = await this.database<{ collabUnread: boolean; runFinished: boolean }[]>`
      select collab_unread as "collabUnread", run_finished as "runFinished"
        from notification_preferences
       where tenant_id = ${tenantId} and user_id = ${userId}
    `
    return row ?? { ...defaultNotificationPreferences }
  }

  async patchNotificationPreferences(
    userId: string,
    patch: NotificationPreferencesPatch,
  ): Promise<NotificationPreferences> {
    const current = await this.getNotificationPreferences(userId)
    const next: NotificationPreferences = {
      collabUnread: patch.collabUnread ?? current.collabUnread,
      runFinished: patch.runFinished ?? current.runFinished,
    }
    await this.database`
      insert into notification_preferences (tenant_id, user_id, collab_unread, run_finished)
      values (${tenantId}, ${userId}, ${next.collabUnread}, ${next.runFinished})
      on conflict (tenant_id, user_id)
        do update set collab_unread = excluded.collab_unread,
                      run_finished = excluded.run_finished
    `
    return next
  }

  async deliver(
    userId: string,
    kind: PushDeliveryKind,
    payload: CollabUnreadPushPayload | RunFinishedPushPayload,
  ): Promise<void> {
    if (!vapidConfigured(this.options)) return
    const preferences = await this.getNotificationPreferences(userId)
    if (kind === 'collab_unread' && !preferences.collabUnread) return
    if (kind === 'run_finished' && !preferences.runFinished) return

    const rows = await this.database<{ endpoint: string; p256dh: string; auth: string }[]>`
      select endpoint, p256dh, auth
        from push_subscriptions
       where tenant_id = ${tenantId} and user_id = ${userId}
    `
    if (rows.length === 0) return

    const payloadJson = JSON.stringify(payload)
    const send = this.options.send ?? (await this.defaultSender())
    for (const row of rows) {
      const subscription: StoredPushSubscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      }
      try {
        const result = await send(subscription, payloadJson)
        if (result.statusCode === 404 || result.statusCode === 410) {
          await this.database`
            delete from push_subscriptions where endpoint = ${row.endpoint}
          `
        }
      } catch {
        // 发送失败不回滚业务；不向外抛出
      }
    }
  }

  private async defaultSender(): Promise<WebPushSender> {
    if (this.options.send) return this.options.send
    if (!this.webPushModule) {
      this.webPushModule = await import('web-push')
      this.webPushModule.setVapidDetails(
        this.options.vapidSubject!.trim(),
        this.options.vapidPublicKey!.trim(),
        this.options.vapidPrivateKey!.trim(),
      )
    }
    const webPush = this.webPushModule
    return async (subscription, payloadJson) => {
      const result = await webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
        },
        payloadJson,
      )
      return { statusCode: result.statusCode }
    }
  }
}
