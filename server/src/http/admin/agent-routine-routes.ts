import type { AgentRoutineService } from '../../modules/automation/agent-routine-service.ts'
import type { AutomationBudget } from '../../modules/automation/automation-types.ts'
import type { AgentRoutineSchedule } from '../../modules/automation/agent-routine-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, routeValidationFailed,
  type RouteContext, type Router } from '../router.ts'

const root = '/api/admin/v1/agents/:agentId/routines'
type Template = { prompt: string; budget?: AutomationBudget; fileIds?: string[] }

function actor(context: RouteContext): string {
  return requireRequestIdentity(context, 'admin').userId
}
function pathAgent(context: { params: Record<string, string> }): string { return context.params.agentId ?? '' }
function pathRoutine(context: { params: Record<string, string> }): string { return context.params.routineId ?? '' }

export function registerAgentRoutineRoutes(router: Router, service: AgentRoutineService): void {
  router.get(root, async (_request, context) => envelope('admin',
    await service.list(pathAgent(context), actor(context)), 'postgres'))
  router.post(root, async (request, context) => {
    const body = await readJsonBody<{
      name?: string; agentVersionId?: string; workspaceId?: string; recipientUserId?: string
      schedule?: AgentRoutineSchedule; inputTemplate?: Template
    }>(request)
    if (!body || !body.name || !body.agentVersionId || !body.workspaceId || !body.recipientUserId
      || !body.schedule || !body.inputTemplate) throw routeValidationFailed('缺少 Agent 主动任务必填字段')
    return httpResult(201, envelope('admin', await service.create(actor(context), {
      agentId: pathAgent(context), name: body.name, agentVersionId: body.agentVersionId,
      workspaceId: body.workspaceId, recipientUserId: body.recipientUserId,
      schedule: body.schedule, inputTemplate: body.inputTemplate,
    }), 'postgres'))
  })
  router.patch(`${root}/:routineId`, async (request, context) => {
    const body = await readJsonBody<{
      expectedRevision?: number; name?: string; agentVersionId?: string; workspaceId?: string
      recipientUserId?: string; schedule?: AgentRoutineSchedule; inputTemplate?: Template
    }>(request)
    if (!body || !Number.isInteger(body.expectedRevision)) throw routeValidationFailed('缺少有效的 expectedRevision')
    return envelope('admin', await service.update(actor(context), pathAgent(context), pathRoutine(context), {
      ...body, expectedRevision: body.expectedRevision!,
    }), 'postgres')
  })
  router.post(`${root}/:routineId/enable`, async (request, context) => {
    const body = await readJsonBody<{ expectedRevision?: number; roleIds?: string[]; dataScopes?: string[] }>(request)
    if (!body || !Number.isInteger(body.expectedRevision) || !Array.isArray(body.roleIds)
      || !Array.isArray(body.dataScopes)) throw routeValidationFailed('启用必须提供修订及明确的角色/范围上限')
    return envelope('admin', await service.enable(actor(context), pathAgent(context), pathRoutine(context), {
      expectedRevision: body.expectedRevision!, roleIds: body.roleIds, dataScopes: body.dataScopes,
    }), 'postgres')
  })
  router.post(`${root}/:routineId/pause`, async (_request, context) => envelope('admin',
    await service.setStatus(actor(context), pathAgent(context), pathRoutine(context), 'paused'), 'postgres'))
  router.delete(`${root}/:routineId`, async (_request, context) => envelope('admin',
    await service.setStatus(actor(context), pathAgent(context), pathRoutine(context), 'disabled'), 'postgres'))
  router.post(`${root}/:routineId/run-now`, async (request, context) => {
    const body = await readJsonBody<{ idempotencyKey?: string }>(request)
    return envelope('admin', await service.runNow(actor(context), pathAgent(context), pathRoutine(context),
      body?.idempotencyKey ?? ''), 'postgres')
  })
  router.post(`${root}/:routineId/events`, async (request, context) => {
    const body = await readJsonBody<{ eventType?: string; source?: string; eventId?: string }>(request)
    if (!body?.eventType || !body.source || !body.eventId) throw routeValidationFailed('事件类型、来源与事件 ID 均为必填')
    return envelope('admin', await service.triggerEvent(actor(context), pathAgent(context), pathRoutine(context), {
      eventType: body.eventType, source: body.source, eventId: body.eventId,
    }), 'postgres')
  })
  router.get(`${root}/:routineId/executions`, async (_request, context) => envelope('admin',
    await service.executions(actor(context), pathAgent(context), pathRoutine(context)), 'postgres'))
}

export function registerAgentRoutineRecipientRoutes(router: Router, service: AgentRoutineService): void {
  router.get('/api/workbench/v1/agent-routine-results', async (_request, context) => envelope('workbench',
    await service.recipientResults(requireRequestIdentity(context, 'workbench').userId), 'postgres'))
}
