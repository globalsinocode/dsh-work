import { inject, provide, type InjectionKey } from 'vue'
import type { RouteLocationNormalizedLoaded } from 'vue-router'

/**
 * 项目空间内页面的地址（员工端双模式 S5d，D21 / D30）：任务列表、任务详情、任务对话与执行
 * 详情在 A（`/workspaces/:id/...`）与 B（`/c/chats/group/:id/...`）复用同一组组件，组件只经
 * 这里取地址，不写死某一种模式的路径。宿主页面 provide 对应模式的实现，缺省为 A。
 * 路由用 `meta.spaceView` 标注页面类型，组件据此判断，不依赖路由名称。
 */
export interface SpaceRoutes {
  /** 空间首页（A：默认页签；B：群聊）。 */
  home(workspaceId: string): string
  /** 任务列表。 */
  tasks(workspaceId: string): string
  task(workspaceId: string, taskId: string): string
  taskThread(workspaceId: string, taskId: string, conversationId: string): string
  /** 空间内的对话或执行详情（Run ID 或 Session ID）。 */
  conversation(workspaceId: string, conversationId: string): string
}

export type SpaceView = 'conversation' | 'task' | 'task-thread'

export const workSpaceRoutes: SpaceRoutes = {
  home: id => `/workspaces/${id}`,
  tasks: id => `/workspaces/${id}`,
  task: (id, taskId) => `/workspaces/${id}/tasks/${taskId}`,
  taskThread: (id, taskId, conversationId) => `/workspaces/${id}/tasks/${taskId}/thread/${conversationId}`,
  conversation: (id, conversationId) => `/workspaces/${id}/conversations/${conversationId}`,
}

export const collabSpaceRoutes: SpaceRoutes = {
  home: id => `/c/chats/group/${id}`,
  tasks: id => `/c/chats/group/${id}?tab=tasks`,
  task: (id, taskId) => `/c/chats/group/${id}/tasks/${taskId}`,
  taskThread: (id, taskId, conversationId) => `/c/chats/group/${id}/tasks/${taskId}/thread/${conversationId}`,
  conversation: (id, conversationId) => `/c/chats/group/${id}/conversations/${conversationId}`,
}

const spaceRoutesKey: InjectionKey<SpaceRoutes> = Symbol('space-routes')

export function provideSpaceRoutes(routes: SpaceRoutes) {
  provide(spaceRoutesKey, routes)
}

export function useSpaceRoutes(): SpaceRoutes {
  return inject(spaceRoutesKey, workSpaceRoutes)
}

const viewsByRouteName: Record<string, SpaceView> = {
  'workspace-conversation': 'conversation',
  'workspace-task': 'task',
  'workspace-task-thread': 'task-thread',
  'collab-group-conversation': 'conversation',
  'collab-group-task': 'task',
  'collab-group-task-thread': 'task-thread',
}

export function spaceView(route: Partial<Pick<RouteLocationNormalizedLoaded, 'meta' | 'name'>>): SpaceView | undefined {
  const value = route.meta?.spaceView
  if (value === 'conversation' || value === 'task' || value === 'task-thread') return value
  return typeof route.name === 'string' ? viewsByRouteName[route.name] : undefined
}
