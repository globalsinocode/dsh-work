import type { RouteLocationRaw } from 'vue-router'

import type { UiMode, UserNotification } from '@/types/domain'

/** 通知正文的片段：`strong` 为人名与对象名，界面加粗显示。 */
export interface NotificationTextPart {
  text: string
  strong?: boolean
}

/**
 * 通知正文（方案第 4 节）：只写“谁、在哪个项目/对象、做了什么”，名称由服务端按本人当前权限解析。
 * 已不可见的通知不显示任何名称。
 */
export function notificationText(item: UserNotification): NotificationTextPart[] {
  if (!item.visible) return [{ text: '一条通知（该内容已不可见）' }]
  const actor = item.actor?.name || '有人'
  const workspace = item.workspace?.name ?? ''
  const object = item.objectName ?? ''
  switch (item.kind) {
    case 'mention':
      return [{ text: actor, strong: true }, { text: ' 在 ' }, { text: `「${workspace}」`, strong: true }, { text: ' 中 @ 了你' }]
    case 'task_assigned':
      return [{ text: actor, strong: true }, { text: ' 把任务 ' }, { text: `「${object}」`, strong: true }, { text: ' 指派给你' }]
    case 'task_completed':
      return [{ text: actor, strong: true }, { text: ' 完成了你创建的任务 ' }, { text: `「${object}」`, strong: true }]
    case 'workspace_member_added':
      return [{ text: actor, strong: true }, { text: ' 把你加入了项目 ' }, { text: `「${workspace}」`, strong: true }]
    case 'task_schedule_stopped': {
      const state = item.detail?.state === 'stopped' ? '已停止' : '已暂停'
      const reason = scheduleStopReasons[item.detail?.reason ?? '']
      return [{ text: '任务 ' }, { text: `「${object}」`, strong: true }, { text: ` 的定时执行${state}${reason ? `：${reason}` : ''}` }]
    }
    case 'automation_failed':
      return [{ text: '定时任务 ' }, { text: `「${object}」`, strong: true }, { text: automationOutcomes[item.detail?.outcome ?? ''] ?? ' 本次执行没有成功' }]
    case 'skill_review_result':
      return [
        { text: '你提交的 Skill ' }, { text: `「${object}」`, strong: true },
        // 不写“原因见草稿卡片”：之后修改再提交、通过后，卡片已显示新结论，旧通知不能指向找不到的原因。
        { text: item.detail?.result === 'approved' ? ' 已发布到 Skill 广场' : ' 未通过审核' },
      ]
    // 钉钉绑定（钉钉接入方案 4.2）：objectName 为钉钉姓名，取自绑定记录。
    case 'dingtalk_bound_by_admin':
      return [{ text: `管理员${item.actor?.name ? ` ${item.actor.name} ` : ''}已为你绑定钉钉账号` }, ...(object ? [{ text: `（${object}）`, strong: true }] : []), { text: '；如果不是你本人的钉钉账号，请立即解除并联系管理员' }]
    case 'dingtalk_binding_revoked':
      return [{ text: item.detail?.reason === 'rebound_to_other' ? '你的钉钉绑定已由管理员改绑到其他员工' : '管理员已解除你的钉钉绑定' }, ...(object ? [{ text: `（${object}）`, strong: true }] : []), { text: '，钉钉内的登录已失效' }]
    case 'dingtalk_bind_reminder':
      return [{ text: '请在钉钉工作台打开 dsh-work，用账号密码登录一次即可绑定钉钉，之后可在钉钉内免登' }]
  }
}

/** 定时执行暂停或停止的原因（与服务端 `schedule_reason` 一致）。 */
const scheduleStopReasons: Record<string, string> = {
  consecutive_failures: '连续多次执行失败',
  setter_ineligible: '你已没有执行这个任务的权限',
  agent_unavailable: '负责的 Agent 已不可用',
  workspace_archived: '项目已归档',
  due_passed: '已过截止日期',
}

/** 定时任务一次执行没有成功的方式。 */
const automationOutcomes: Record<string, string> = {
  failed: ' 本次执行失败',
  skipped: ' 本次执行被跳过',
  missed: ' 因服务停机错过了执行',
  interrupted: ' 本次执行未能开始',
}

/** 无障碍名称与测试用的纯文本正文。 */
export function notificationPlainText(item: UserNotification): string {
  return notificationText(item).map(part => part.text).join('')
}

/** 类型图标的短标记（不用表情符号）。 */
export function notificationGlyph(item: UserNotification): string {
  if (!item.visible) return '–'
  return {
    mention: '@', task_assigned: '任', task_completed: '任', workspace_member_added: '员',
    task_schedule_stopped: '时', automation_failed: '时', skill_review_result: 'S',
    dingtalk_bound_by_admin: '钉', dingtalk_binding_revoked: '钉', dingtalk_bind_reminder: '钉',
  }[item.kind]
}

/**
 * 点击通知去往的地址。任务与项目使用 A 工作模式的地址，B 中由路由守卫映射到群组对应页
 * （mode-routes）；@ 我在 A 中打开该讨论，在 B 中打开群聊（讨论消息在群聊中）。定时任务与
 * Skill 审核打开对应对话（`/sessions/:id` 两种模式通用），没有对话时打开所在列表页。
 * 不可见的通知没有去向。
 */
export function notificationLocation(item: UserNotification, mode: UiMode): RouteLocationRaw | null {
  if (!item.visible || !item.target) return null
  const sessionId = item.target.sessionId
  if (item.target.type === 'automation') return sessionId ? { name: 'session-detail', params: { id: sessionId } } : { path: '/automations' }
  if (item.target.type === 'skill_submission') return sessionId ? { name: 'session-detail', params: { id: sessionId } } : { path: '/skills' }
  if (item.target.type === 'dingtalk_binding') return { path: '/settings', query: { section: 'dingtalk' } }
  if (!item.workspace) return null
  const workspaceId = item.workspace.id
  switch (item.target.type) {
    case 'message':
      if (mode === 'collab' || !item.target.sessionId) return { name: 'collab-group-chat', params: { id: workspaceId } }
      return { name: 'workspace-conversation', params: { id: workspaceId, conversationId: item.target.sessionId } }
    case 'project_task':
      return { name: 'workspace-task', params: { id: workspaceId, taskId: item.target.id } }
    case 'workspace':
      return { name: 'workspace-detail', params: { id: workspaceId } }
  }
}
