import type { LocationQuery, RouteLocationNormalized, RouteLocationRaw, RouteRecordNameGeneric } from 'vue-router'

import type { UiMode } from '@/types/domain'

/**
 * 员工端双模式的路由映射（项目空间方案 12.5）。
 *
 * 站内通知、复制的链接与旧书签都使用 A 工作模式的地址；当前为 B 协作模式时，守卫把
 * A 专属地址映射到 B 的对应页，当前为 A 时把 `/c/...` 映射回 A。共用页（定时任务、
 * 用户中心、Skill 广场、我的文件、历史对话等）不带 `meta.mode`，两种模式下地址不变。
 * 映射只换地址，不做权限判断：落地页照常经服务端授权。
 */

/** 守卫中的目标路由与 `router.resolve` 的结果都满足这一形状。 */
type ModeRoute = Pick<RouteLocationNormalized, 'meta' | 'path' | 'params' | 'query'> & { name?: RouteRecordNameGeneric | null }

/** 只在某一模式存在的路由在 `meta.mode` 上标注所属模式；共用路由不标注。 */
export function routeMode(route: Pick<ModeRoute, 'meta' | 'name' | 'path'>): UiMode | undefined {
  if (route.meta.mode === 'work' || route.meta.mode === 'collab') return route.meta.mode
  // `/c/` 下没有对应页的地址在 A 中回到首页；B 中照常显示“页面不存在”。
  if (route.name === 'not-found' && /^\/c(\/|$)/.test(route.path)) return 'collab'
  return undefined
}

/** 当前模式下应改去的地址；不需要映射时返回 undefined。 */
export function locationForMode(route: ModeRoute, mode: UiMode): RouteLocationRaw | undefined {
  const current = routeMode(route)
  if (!current || current === mode) return undefined
  return mode === 'collab' ? toCollab(route) : toWork(route)
}

/** A 页签 ↔ B 群组页签；A 的“对话”页签在 B 中是“对话”（chat），其余同名。 */
const groupTabsFromWork: Record<string, string> = {
  conversation: 'chat',
  tasks: 'tasks',
  files: 'files',
  artifacts: 'artifacts',
  archive: 'archive',
}
const workTabsFromGroup: Record<string, string> = Object.fromEntries(
  Object.entries(groupTabsFromWork).map(([work, group]) => [group, work]),
)

function toCollab(route: ModeRoute): RouteLocationRaw {
  const params = route.params
  const query = route.query
  switch (route.name) {
    case 'workbench': {
      const agentId = first(query.agent)
      const rest = omit(query, ['agent', 'new'])
      return agentId
        ? { name: 'collab-agent-chat', params: { agentId }, query: rest }
        : { name: 'collab-chats', query: rest }
    }
    case 'conversation':
      return { name: 'collab-chats', query: { conversation: first(params.id) } }
    case 'workspaces':
      return { name: 'collab-groups' }
    case 'agents':
      return { name: 'collab-agents' }
    case 'workspace-detail': {
      const tab = groupTabsFromWork[first(query.tab) ?? '']
      return { name: 'collab-group-chat', params: { id: first(params.id) }, query: tab ? { tab } : {} }
    }
    // 群组子路由与 A 同构（S5d）：执行详情、任务详情与任务对话按同名参数一一对应。
    case 'workspace-conversation':
      return { name: 'collab-group-conversation', params: { id: first(params.id), conversationId: first(params.conversationId) } }
    case 'workspace-task':
      return { name: 'collab-group-task', params: { id: first(params.id), taskId: first(params.taskId) } }
    case 'workspace-task-thread':
      return {
        name: 'collab-group-task-thread',
        params: { id: first(params.id), taskId: first(params.taskId), conversationId: first(params.conversationId) },
      }
    default:
      return { name: 'collab-chats' }
  }
}

function toWork(route: ModeRoute): RouteLocationRaw {
  const params = route.params
  const query = route.query
  switch (route.name) {
    case 'collab-chats': {
      const conversation = first(query.conversation)
      if (conversation) return { name: 'conversation', params: { id: conversation } }
      return { name: 'workbench', query: omit(query, ['conversation']) }
    }
    case 'collab-agent-chat': {
      // 单聊中定位的会话回到 A 的对话详情；未定位时回到预选该 AI 同事的新对话。
      const session = first(query.session)
      if (session) return { name: 'conversation', params: { id: session } }
      return { name: 'workbench', query: { agent: first(params.agentId) } }
    }
    case 'collab-group-chat': {
      const id = first(params.id)
      // 旧格式 ?tab=tasks&task= 仍能映射回任务详情。
      const task = first(query.task)
      if (task) return { name: 'workspace-task', params: { id, taskId: task } }
      // 群聊中定位的讨论（?session=，旧格式 ?conversation=）回到 A 的空间内对话。
      const conversation = first(query.session) ?? first(query.conversation)
      if (conversation) return { name: 'workspace-conversation', params: { id, conversationId: conversation } }
      const tab = workTabsFromGroup[first(query.tab) ?? '']
      return { name: 'workspace-detail', params: { id }, query: tab ? { tab } : {} }
    }
    case 'collab-group-conversation':
      return { name: 'workspace-conversation', params: { id: first(params.id), conversationId: first(params.conversationId) } }
    case 'collab-group-task':
      return { name: 'workspace-task', params: { id: first(params.id), taskId: first(params.taskId) } }
    case 'collab-group-task-thread':
      return {
        name: 'workspace-task-thread',
        params: { id: first(params.id), taskId: first(params.taskId), conversationId: first(params.conversationId) },
      }
    case 'collab-groups':
      return { name: 'workspaces' }
    case 'collab-group':
      return { name: 'workspace-detail', params: { id: first(params.id) } }
    case 'collab-agents':
    case 'collab-agent':
      return { name: 'agents' }
    default:
      return { name: 'workbench' }
  }
}

function first(value: LocationQuery[string] | string | string[] | undefined): string | undefined {
  const item = Array.isArray(value) ? value[0] : value
  return typeof item === 'string' && item !== '' ? item : undefined
}

function omit(query: LocationQuery, keys: string[]): LocationQuery {
  return Object.fromEntries(Object.entries(query).filter(([key]) => !keys.includes(key)))
}
