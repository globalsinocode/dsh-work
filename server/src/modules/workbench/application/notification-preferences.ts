import { invalidRequest } from '../../../domain/request-errors.ts'

export interface NotificationPreferences {
  collabUnread: boolean
  runFinished: boolean
}

export const defaultNotificationPreferences: NotificationPreferences = {
  collabUnread: true,
  runFinished: true,
}

export type NotificationPreferencesPatch = Partial<NotificationPreferences>

export function parseNotificationPreferencesPatch(body: unknown): NotificationPreferencesPatch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('请求体必须是 JSON 对象')
  }
  const record = body as Record<string, unknown>
  const patch: NotificationPreferencesPatch = {}
  if ('collabUnread' in record) {
    if (typeof record.collabUnread !== 'boolean') throw invalidRequest('collabUnread 必须是布尔值')
    patch.collabUnread = record.collabUnread
  }
  if ('runFinished' in record) {
    if (typeof record.runFinished !== 'boolean') throw invalidRequest('runFinished 必须是布尔值')
    patch.runFinished = record.runFinished
  }
  if (Object.keys(patch).length === 0) throw invalidRequest('至少提供一个可更新字段')
  return patch
}
