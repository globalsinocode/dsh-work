import type { IncomingMessage } from 'node:http'

import type { AutomationService } from '../../modules/automation/automation-service.ts'
import type { AutomationSchedule, AutomationInputTemplate } from '../../modules/automation/automation-types.ts'
import {
  envelope,
  readJsonBody,
  requireRequestIdentity,
  routeValidationFailed,
  sessionAuthorizationContext,
  type Router,
} from '../router.ts'

const basePath = '/api/workbench/v1'

interface CreateAutomationBody {
  name?: string
  agentId?: string
  workspaceId?: string
  schedule?: AutomationSchedule
  inputTemplate?: AutomationInputTemplate
}

interface UpdateAutomationBody {
  name?: string
  agentId?: string
  workspaceId?: string
  schedule?: AutomationSchedule
  inputTemplate?: AutomationInputTemplate
}

interface TriggerBody {
  idempotencyKey?: string
}

/** JSON body 必须是对象——null/数组/标量直接 422，不在服务层变成 TypeError 500。 */
async function readObjectBody<T extends object>(request: IncomingMessage): Promise<T> {
  const body = await readJsonBody<T | null>(request)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw routeValidationFailed('请求体必须是 JSON 对象')
  }
  return body
}

/**
 * AG-03 自动任务工作台 API：全部 owner-scoped（getMine/getByIdForOwner
 * 强制归属），仅面向工作台身份。创建/编辑只产生草稿；启停、立即运行、
 * 试运行与执行记录各自独立端点。
 */
export function registerAutomationRoutes(router: Router, service: AutomationService) {
  router.get(`${basePath}/automations`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', await service.listMine(identity.userId), 'postgres')
  })

  router.post(`${basePath}/automations`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readObjectBody<CreateAutomationBody>(request)
    if (!body.name || !body.agentId || !body.workspaceId || !body.schedule || !body.inputTemplate) {
      throw routeValidationFailed('name、agentId、workspaceId、schedule、inputTemplate 均为必填')
    }
    const created = await service.create(identity.userId, {
      name: body.name,
      agentId: body.agentId,
      workspaceId: body.workspaceId,
      schedule: body.schedule,
      inputTemplate: body.inputTemplate,
    }, sessionAuthorizationContext(identity).roleIds)
    return envelope('workbench', created, 'postgres')
  })

  router.get(`${basePath}/automations/:automationId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', await service.getMine(identity.userId, context.params['automationId'] ?? ''), 'postgres')
  })

  router.patch(`${basePath}/automations/:automationId`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readObjectBody<UpdateAutomationBody>(request)
    return envelope('workbench', await service.update(identity.userId, context.params['automationId'] ?? '', body, sessionAuthorizationContext(identity).roleIds), 'postgres')
  })

  router.post(`${basePath}/automations/:automationId/enable`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', await service.enable(identity.userId, context.params['automationId'] ?? ''), 'postgres')
  })

  router.post(`${basePath}/automations/:automationId/pause`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', await service.pause(identity.userId, context.params['automationId'] ?? ''), 'postgres')
  })

  router.post(`${basePath}/automations/:automationId/trial-runs`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readObjectBody<TriggerBody>(request)
    return envelope('workbench', await service.trialRun(identity.userId, context.params['automationId'] ?? '', body.idempotencyKey ?? ''), 'postgres')
  })

  router.post(`${basePath}/automations/:automationId/run-now`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readObjectBody<TriggerBody>(request)
    return envelope('workbench', await service.runNow(identity.userId, context.params['automationId'] ?? '', body.idempotencyKey ?? ''), 'postgres')
  })

  router.get(`${basePath}/automations/:automationId/executions`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', await service.listExecutions(identity.userId, context.params['automationId'] ?? ''), 'postgres')
  })

  router.delete(`${basePath}/automations/:automationId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', await service.disable(identity.userId, context.params['automationId'] ?? ''), 'postgres')
  })
}
