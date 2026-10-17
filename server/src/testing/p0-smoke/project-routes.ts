import { randomUUID } from 'node:crypto'

import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../../http/router.ts'

const basePath = '/api/workbench/v1'
const smokeWorkspaceId = 'ws-supply'

interface SmokeTask {
  id: string
  title: string
  description: string
  createdBy: { userId: string; displayName: string }
  assignee: { type: 'employee'; userId: string; displayName: string }
  status: 'todo' | 'in_progress' | 'done'
  completionNote: string | null
  completedAt: string | null
  dueDate: string | null
  createdAt: string
  updatedAt: string
}

/**
 * P0 冒烟（项目空间 S1）：`ws-supply` 的成员名册、项目简报与员工任务的内存实现，
 * 只用于验证页面交互（PS-E2E-01/02）。不实现 Agent 任务执行、权限矩阵或持久化——
 * 这些由服务端集成测试与 P1 旅程覆盖。每次启动冒烟服务都从同一种子开始。
 */
export function registerSmokeProjectRoutes(router: Router) {
  const members = [
    { userId: 'U00001', displayName: '林岚', role: 'owner' as const, joinedAt: '2026-09-01T00:00:00.000Z', department: '供应链中心' },
    { userId: 'U00002', displayName: '周衡', role: 'member' as const, joinedAt: '2026-09-02T00:00:00.000Z', department: '计划部' },
  ]
  let brief = {
    versionId: 'wbrief-smoke-1',
    versionNo: 1,
    content: '目标：本季度把华东区订单缺货率降到 3% 以下。\n范围：订单交付、库存与采购到货。',
    dueDate: '2026-12-31' as string | null,
    updatedBy: { userId: 'U00001', displayName: '林岚' },
    updatedAt: '2026-10-17T08:00:00.000Z',
  }
  const tasks: SmokeTask[] = []

  const requireSmokeSpace = (workspaceId: string | undefined) => {
    if (workspaceId !== smokeWorkspaceId) return httpResult(422, { error: { code: 'invalid_request', message: '冒烟数据仅包含 ws-supply 的项目协作数据' } })
    return null
  }
  const view = (task: SmokeTask) => ({
    ...task,
    sessionId: null,
    latestRunId: null,
    inputFiles: [],
    deliverableFiles: [],
    allowedActions: ['edit', 'remove', 'set_status', 'complete'],
  })

  router.get(`${basePath}/workspaces/:workspaceId/members`, (_request, context) => {
    requireRequestIdentity(context, 'workbench')
    return requireSmokeSpace(context.params['workspaceId'])
      ?? envelope('workbench', { items: members, currentUserRole: 'owner' })
  })
  router.get(`${basePath}/workspaces/:workspaceId/agent-members`, (_request, context) => {
    requireRequestIdentity(context, 'workbench')
    return requireSmokeSpace(context.params['workspaceId']) ?? envelope('workbench', [])
  })

  // 负责人视角的右栏还会读取动态、提醒与用量；冒烟数据给出空集合，页面呈现空态而不是报错。
  router.get(`${basePath}/workspaces/:workspaceId/activity`, (_request, context) => {
    requireRequestIdentity(context, 'workbench')
    return requireSmokeSpace(context.params['workspaceId'])
      ?? envelope('workbench', { workspaceId: smokeWorkspaceId, items: [], nextCursor: null })
  })
  router.get(`${basePath}/workspaces/:workspaceId/notifications`, (_request, context) => {
    requireRequestIdentity(context, 'workbench')
    return requireSmokeSpace(context.params['workspaceId'])
      ?? envelope('workbench', { workspaceId: smokeWorkspaceId, items: [], nextCursor: null, muted: false, mutedAt: null, lastReadAt: null, unreadCount: 0 })
  })
  router.get(`${basePath}/workspaces/:workspaceId/usage`, (_request, context) => {
    requireRequestIdentity(context, 'workbench')
    const invalid = requireSmokeSpace(context.params['workspaceId'])
    if (invalid) return invalid
    const days = 7
    const daily = Array.from({ length: days }, (_, index) => {
      const date = new Date(Date.UTC(2026, 9, 11 + index))
      return { day: `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`, callCount: 0, successCount: 0, failedCount: 0, inputTokens: 0, outputTokens: 0 }
    })
    return envelope('workbench', {
      workspaceId: smokeWorkspaceId, range: '7d', rangeDays: days, daily,
      totals: { callCount: 0, successCount: 0, failedCount: 0, estimatedCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    })
  })

  router.get(`${basePath}/workspaces/:workspaceId/brief`, (_request, context) => {
    requireRequestIdentity(context, 'workbench')
    return requireSmokeSpace(context.params['workspaceId']) ?? envelope('workbench', brief)
  })
  router.put(`${basePath}/workspaces/:workspaceId/brief`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const invalid = requireSmokeSpace(context.params['workspaceId'])
    if (invalid) return invalid
    const body = await readJsonBody<{ content?: unknown; dueDate?: unknown }>(request)
    if (typeof body.content !== 'string' || !body.content.trim()) {
      return httpResult(422, { error: { code: 'invalid_request', message: '简报内容不能为空' } })
    }
    brief = {
      versionId: `wbrief-smoke-${brief.versionNo + 1}`,
      versionNo: brief.versionNo + 1,
      content: body.content.trim(),
      dueDate: typeof body.dueDate === 'string' && body.dueDate ? body.dueDate : null,
      updatedBy: { userId: identity.userId, displayName: identity.profile.name },
      updatedAt: new Date().toISOString(),
    }
    return envelope('workbench', brief)
  })

  router.get(`${basePath}/workspaces/:workspaceId/project-tasks`, (_request, context) => {
    requireRequestIdentity(context, 'workbench')
    return requireSmokeSpace(context.params['workspaceId']) ?? envelope('workbench', tasks.map(view))
  })
  router.post(`${basePath}/workspaces/:workspaceId/project-tasks`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const invalid = requireSmokeSpace(context.params['workspaceId'])
    if (invalid) return invalid
    const body = await readJsonBody<{ title?: unknown; description?: unknown; assignee?: { type?: unknown; id?: unknown }; dueDate?: unknown }>(request)
    const assignee = members.find(member => body.assignee?.type === 'employee' && member.userId === body.assignee.id)
    if (typeof body.title !== 'string' || !body.title.trim() || !assignee) {
      return httpResult(422, { error: { code: 'invalid_request', message: '冒烟数据只支持指派给本空间员工的任务' } })
    }
    const now = new Date().toISOString()
    const task: SmokeTask = {
      id: `ptask-smoke-${randomUUID()}`,
      title: body.title.trim(),
      description: typeof body.description === 'string' ? body.description.trim() : '',
      createdBy: { userId: identity.userId, displayName: identity.profile.name },
      assignee: { type: 'employee', userId: assignee.userId, displayName: assignee.displayName },
      status: 'todo',
      completionNote: null,
      completedAt: null,
      dueDate: typeof body.dueDate === 'string' && body.dueDate ? body.dueDate : null,
      createdAt: now,
      updatedAt: now,
    }
    tasks.unshift(task)
    return httpResult(201, envelope('workbench', view(task)))
  })
  router.post(`${basePath}/workspaces/:workspaceId/project-tasks/:taskId/status`, async (request, context) => {
    requireRequestIdentity(context, 'workbench')
    const invalid = requireSmokeSpace(context.params['workspaceId'])
    if (invalid) return invalid
    const task = tasks.find(item => item.id === context.params['taskId'])
    if (!task) return httpResult(404, { error: { code: 'project_task_not_found', message: '任务不存在或已移除' } })
    const body = await readJsonBody<{ status?: unknown; completionNote?: unknown }>(request)
    if (body.status !== 'todo' && body.status !== 'in_progress' && body.status !== 'done') {
      return httpResult(422, { error: { code: 'invalid_request', message: 'status 无效' } })
    }
    task.status = body.status
    task.completionNote = body.status === 'done' && typeof body.completionNote === 'string' && body.completionNote.trim()
      ? body.completionNote.trim()
      : null
    task.completedAt = body.status === 'done' ? new Date().toISOString() : null
    task.updatedAt = new Date().toISOString()
    return envelope('workbench', view(task))
  })
}
