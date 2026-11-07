import { notFound } from '../../domain/request-errors.ts'
import type { UserNotificationItem, UserNotificationPage } from '../../modules/workbench/application/postgres-user-notification-service.ts'

/**
 * P0 冒烟用的站内通知（方案 NC-S2，验收目录 NC-03）：测试身份的一组确定性通知，只用于页面冒烟，
 * 随 `/api/testing/p0/reset` 重建。写入时机、权限复查与静音口径由 PostgreSQL 实现与
 * NC-01、NC-02 集成测试保证；这里的“不可见”条目是夹具直接给出的。
 */
export class MemoryUserNotificationStore {
  private readonly items: UserNotificationItem[]

  constructor(now: Date = new Date()) {
    const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString()
    const supply = { id: 'ws-supply', name: '供应链经营分析' }
    this.items = [
      {
        id: 'notif-smoke-mention', kind: 'mention', createdAt: minutesAgo(3), read: false, visible: true,
        actor: { id: 'U20017', name: '周敏' }, workspace: supply, objectName: null, detail: null,
        target: { type: 'message', id: 'msg-smoke-mention', sessionId: 'session-1002' },
      },
      {
        id: 'notif-smoke-member', kind: 'workspace_member_added', createdAt: minutesAgo(40), read: false, visible: true,
        actor: { id: 'U20017', name: '周敏' }, workspace: supply, objectName: null, detail: null,
        target: { type: 'workspace', id: supply.id, sessionId: null },
      },
      {
        id: 'notif-smoke-task', kind: 'task_assigned', createdAt: minutesAgo(26 * 60), read: true, visible: true,
        actor: { id: 'U20017', name: '周敏' }, workspace: supply, objectName: '核对华东安全库存', detail: null,
        target: { type: 'project_task', id: 'ptask-smoke-notification', sessionId: null },
      },
      {
        id: 'notif-smoke-hidden', kind: 'task_completed', createdAt: minutesAgo(3 * 24 * 60), read: true, visible: false,
        actor: null, workspace: null, objectName: null, detail: null, target: null,
      },
    ]
  }

  async list(input: { userId: string; status?: string | null; cursor?: string | null; limit?: number }): Promise<UserNotificationPage> {
    const matched = input.status === 'unread' ? this.items.filter(item => !item.read && item.visible) : this.items
    return { items: matched.map(item => ({ ...item })), nextCursor: null }
  }

  async unreadCount(): Promise<{ unread: number }> {
    return { unread: this.items.filter(item => !item.read && item.visible).length }
  }

  async markRead(_userId: string, notificationId: string): Promise<{ id: string; read: true }> {
    const item = this.items.find(entry => entry.id === notificationId)
    if (!item) throw notFound('通知不存在')
    item.read = true
    return { id: item.id, read: true }
  }

  async markAllRead(): Promise<{ read: number }> {
    const unread = this.items.filter(item => !item.read)
    for (const item of unread) item.read = true
    return { read: unread.length }
  }
}
