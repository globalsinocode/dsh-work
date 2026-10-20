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

interface SmokeArchiveVersion {
  versionId: string
  versionNo: number
  items: string[]
  sourceKind: 'archivist' | 'manual' | 'rollback'
  sourceTasks: Array<{ id: string; title: string }>
  rollbackFromVersionNo: number | null
  createdBy: { userId: string; displayName: string } | null
  createdAt: string
}

/**
 * P0 冒烟（项目空间 S1/S2）：`ws-supply` 的成员名册、项目简报、员工任务与项目档案的内存实现，
 * 只用于验证页面交互（PS-E2E-01/02/05）。不实现 Agent 任务执行、权限矩阵或持久化——
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
  const lin = { userId: 'U00001', displayName: '林岚' }
  const zhou = { userId: 'U00002', displayName: '周衡' }
  // 档案按版本倒序保存，第一项即当前版本。
  const archiveVersions: SmokeArchiveVersion[] = [
    {
      versionId: 'warch-smoke-3', versionNo: 3, sourceKind: 'manual', sourceTasks: [], rollbackFromVersionNo: null,
      items: ['华东缺货集中在高周转 SKU 类目，主因是采购到货周期波动。', '决策：按 SKU 类目分别设置安全库存。', '术语：安全库存按“日均出库 × 波动天数”计算。'],
      createdBy: zhou, createdAt: '2026-10-17T02:05:00.000Z',
    },
    {
      versionId: 'warch-smoke-2', versionNo: 2, sourceKind: 'archivist', rollbackFromVersionNo: null, createdBy: null,
      sourceTasks: [{ id: 'ptask-smoke-analysis', title: '分析华东缺货原因' }],
      items: ['华东缺货集中在高周转 SKU 类目，主因是采购到货周期波动。', '决策：按 SKU 类目分别设置安全库存。', '术语：安全库存固定为 7 天销量。'],
      createdAt: '2026-10-16T09:40:00.000Z',
    },
    {
      versionId: 'warch-smoke-1', versionNo: 1, sourceKind: 'manual', sourceTasks: [], rollbackFromVersionNo: null,
      items: ['决策：按 SKU 类目分别设置安全库存。'], createdBy: lin, createdAt: '2026-10-15T08:00:00.000Z',
    },
  ]
  const appendArchiveVersion = (
    items: string[],
    actor: { userId: string; displayName: string },
    rollbackFromVersionNo: number | null,
  ) => {
    const versionNo = (archiveVersions[0]?.versionNo ?? 0) + 1
    const version: SmokeArchiveVersion = {
      versionId: `warch-smoke-${versionNo}`, versionNo, items, sourceTasks: [],
      sourceKind: rollbackFromVersionNo === null ? 'manual' : 'rollback', rollbackFromVersionNo,
      createdBy: actor, createdAt: new Date().toISOString(),
    }
    archiveVersions.unshift(version)
    return version
  }
  const archiveConflict = (baseVersionNo: unknown) => baseVersionNo !== (archiveVersions[0]?.versionNo ?? 0)
    ? httpResult(409, { error: { code: 'state_conflict', message: '档案已被更新，请刷新后再修改' } })
    : null

  const requireSmokeSpace = (workspaceId: string | undefined) => {
    if (workspaceId !== smokeWorkspaceId) return httpResult(422, { error: { code: 'invalid_request', message: '冒烟数据仅包含 ws-supply 的项目协作数据' } })
    return null
  }
  const view = (task: SmokeTask) => ({
    ...task,
    sessionId: null,
    latestRunId: null,
    latestRunStatus: null,
    latestRunAt: null,
    // S4：冒烟数据只有员工任务，没有执行规则。
    schedule: null,
    scheduleState: null,
    scheduleReason: null,
    nextRunAt: null,
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

  router.get(`${basePath}/workspaces/:workspaceId/project-archive`, (_request, context) => {
    requireRequestIdentity(context, 'workbench')
    return requireSmokeSpace(context.params['workspaceId'])
      ?? envelope('workbench', { current: archiveVersions[0] ?? null, archivistRunning: false })
  })
  router.get(`${basePath}/workspaces/:workspaceId/project-archive/versions`, (_request, context) => {
    requireRequestIdentity(context, 'workbench')
    return requireSmokeSpace(context.params['workspaceId']) ?? envelope('workbench', archiveVersions)
  })
  router.put(`${basePath}/workspaces/:workspaceId/project-archive`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const invalid = requireSmokeSpace(context.params['workspaceId'])
    if (invalid) return invalid
    const body = await readJsonBody<{ baseVersionNo?: unknown; items?: unknown }>(request)
    const conflict = archiveConflict(body.baseVersionNo)
    if (conflict) return conflict
    const items = Array.isArray(body.items) ? body.items.map(item => (typeof item === 'string' ? item.trim() : '')) : null
    if (!items || items.some(item => !item || item.length > 500) || new Set(items).size !== items.length || items.length > 50) {
      return httpResult(422, { error: { code: 'invalid_request', message: '档案条目无效' } })
    }
    return envelope('workbench', appendArchiveVersion(items, { userId: identity.userId, displayName: identity.profile.name }, null))
  })
  router.post(`${basePath}/workspaces/:workspaceId/project-archive/rollback`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const invalid = requireSmokeSpace(context.params['workspaceId'])
    if (invalid) return invalid
    const body = await readJsonBody<{ versionNo?: unknown; baseVersionNo?: unknown }>(request)
    const conflict = archiveConflict(body.baseVersionNo)
    if (conflict) return conflict
    const target = archiveVersions.find(version => version.versionNo === body.versionNo)
    if (!target || target === archiveVersions[0]) {
      return httpResult(422, { error: { code: 'invalid_request', message: '要回退的档案版本不存在或已是当前版本' } })
    }
    return envelope('workbench', appendArchiveVersion([...target.items], { userId: identity.userId, displayName: identity.profile.name }, target.versionNo))
  })

  router.get(`${basePath}/workspaces/:workspaceId/project-tasks`, (_request, context) => {
    requireRequestIdentity(context, 'workbench')
    const invalid = requireSmokeSpace(context.params['workspaceId'])
    if (invalid) return invalid
    // 冒烟实现用 offset 充当游标，响应形状与生产的分页一致。
    const limit = Math.max(1, Math.min(Number(context.url.searchParams.get('limit') ?? tasks.length) || tasks.length, 100))
    const offset = Math.max(0, Number(context.url.searchParams.get('cursor') ?? 0) || 0)
    // 冒烟任务都没有任务线程（view 固定 sessionId: null）：按线程查找时恒为空。
    const matched = context.url.searchParams.get('sessionId') ? [] : tasks
    const items = matched.slice(offset, offset + limit)
    return envelope('workbench', {
      items: items.map(view),
      nextCursor: offset + limit < matched.length ? String(offset + limit) : null,
      total: tasks.length,
    })
  })
  router.get(`${basePath}/workspaces/:workspaceId/project-tasks/:taskId`, (_request, context) => {
    requireRequestIdentity(context, 'workbench')
    const invalid = requireSmokeSpace(context.params['workspaceId'])
    if (invalid) return invalid
    const task = tasks.find(item => item.id === context.params['taskId'])
    if (!task) return httpResult(404, { error: { code: 'project_task_not_found', message: '任务不存在或已移除' } })
    return envelope('workbench', view(task))
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
