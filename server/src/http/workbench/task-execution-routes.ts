import type { PostgresAuthorizationService, SessionAuthorizationContext } from '../../modules/authorization/postgres-authorization-service.ts'
import { authorizationDenied, requestInvalid } from '../../modules/authorization/authorization-errors.ts'
import type { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import type { JsonObject } from '../../modules/run/run-types.ts'
import type { PostgresTaskQueryService } from '../../modules/task/postgres-task-query-service.ts'
import type { TaskRepository } from '../../modules/task/task-repository.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, sessionAuthorizationContext, type Router } from '../router.ts'

const basePath = '/api/workbench/v1/task-executions'

export function registerTaskExecutionRoutes(
  router: Router,
  service: PostgresTaskQueryService,
  orchestration: RunOrchestrationService,
  authorization: PostgresAuthorizationService,
) {
  router.post(basePath, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readJsonBody<{
      workspaceId?: unknown
      agentVersionId?: unknown
      prompt?: unknown
      sourceType?: unknown
      sourceRef?: unknown
      correlationKey?: unknown
    } | null>(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw requestInvalid('请求体必须是 JSON 对象')
    const workspaceId = requiredString(body.workspaceId, 'workspaceId')
    const agentVersionId = requiredString(body.agentVersionId, 'agentVersionId')
    const sourceType = body.sourceType === 'event' ? 'event' : body.sourceType === undefined || body.sourceType === 'api' ? 'api' : null
    if (!sourceType) throw requestInvalid('sourceType 仅支持 api 或 event')
    if (body.sourceRef !== undefined && body.sourceRef !== null && typeof body.sourceRef !== 'string') {
      throw requestInvalid('sourceRef 必须是字符串或 null')
    }
    const headerKey = request.headers['idempotency-key']
    const correlationKey = body.correlationKey ?? (Array.isArray(headerKey) ? headerKey[0] : headerKey)
    const run = await orchestration.startTaskExecution({
      userId: identity.userId,
      workspaceId,
      agentVersionId,
      prompt: body.prompt,
      sourceType,
      sourceRef: body.sourceRef as string | null | undefined,
      correlationKey: requiredString(correlationKey, 'correlationKey 或 Idempotency-Key'),
      authorizationContext: sessionAuthorizationContext(identity),
    })
    if (!run) throw new Error('Task Run 创建失败')
    const execution = await service.get(run.taskId)
    return httpResult(202, envelope('workbench', execution, 'postgres'))
  })

  router.get(`${basePath}/:taskId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const execution = await requireReadableTask(service, authorization, context.params['taskId'] ?? '', identity.userId, sessionAuthorizationContext(identity))
    return envelope('workbench', execution, 'postgres')
  })

  router.get(`${basePath}/:taskId/operations`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const execution = await requireReadableTask(service, authorization, context.params['taskId'] ?? '', identity.userId, sessionAuthorizationContext(identity))
    return envelope('workbench', execution.result.operations, 'postgres')
  })

  router.post(`${basePath}/:taskId/cancel`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const execution = await requireReadableTask(service, authorization, context.params['taskId'] ?? '', identity.userId, sessionAuthorizationContext(identity), false)
    if (!execution.run) throw requestInvalid('Task 尚未创建 Run')
    await orchestration.cancel(execution.run.id, identity.userId, sessionAuthorizationContext(identity))
    return httpResult(202, envelope('workbench', await service.get(execution.task.id), 'postgres'))
  })

  router.post(`${basePath}/:taskId/retry`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const execution = await requireReadableTask(service, authorization, context.params['taskId'] ?? '', identity.userId, sessionAuthorizationContext(identity), false)
    if (!execution.run) throw requestInvalid('Task 尚未创建 Run')
    await orchestration.retry(execution.run.id, identity.userId, sessionAuthorizationContext(identity))
    return httpResult(202, envelope('workbench', await service.get(execution.task.id), 'postgres'))
  })
}

/** Operator-only reconciliation after querying the authoritative external system. */
export function registerTaskOperationAdminRoutes(
  router: Router,
  tasks: TaskRepository,
  authorization: PostgresAuthorizationService,
) {
  router.post('/api/admin/v1/task-executions/:taskId/operations/:operationId/resolve', async (request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    await authorization.requirePlatformAdmin(identity.userId)
    const operation = await tasks.getOperation('tenant-dsh-work', context.params['operationId'] ?? '')
    if (!operation || operation.taskId !== context.params['taskId']) throw authorizationDenied('外部操作不存在或不可访问')
    const body = await readJsonBody<{ status?: unknown; receipt?: unknown; errorCode?: unknown } | null>(request)
    if (!body || (body.status !== 'completed' && body.status !== 'failed')) {
      throw requestInvalid('status 仅支持 completed 或 failed')
    }
    if (!body.receipt || typeof body.receipt !== 'object' || Array.isArray(body.receipt)) {
      throw requestInvalid('receipt 必须是 JSON 对象')
    }
    if (body.status === 'failed' && (typeof body.errorCode !== 'string' || !body.errorCode.trim())) {
      throw requestInvalid('failed 状态必须提供非空 errorCode')
    }
    if (body.status === 'completed' && body.errorCode !== undefined) {
      throw requestInvalid('completed 状态不能提供 errorCode')
    }
    const resolved = await tasks.resolveOperation({
      tenantId: 'tenant-dsh-work',
      operationId: operation.id,
      status: body.status,
      receipt: JSON.parse(JSON.stringify(body.receipt)) as JsonObject,
      errorCode: typeof body.errorCode === 'string' ? body.errorCode : undefined,
    })
    return envelope('admin', resolved, 'postgres')
  })
}

async function requireReadableTask(
  service: PostgresTaskQueryService,
  authorization: PostgresAuthorizationService,
  taskId: string,
  userId: string,
  context: SessionAuthorizationContext,
  allowArchived = true,
) {
  const execution = await service.get(taskId)
  if (!execution || execution.task.requestedBy !== userId || !execution.task.workspaceId) {
    throw authorizationDenied('Task 不存在或不可访问')
  }
  await authorization.authorizeWorkbench({
    userId,
    workspaceId: execution.task.workspaceId,
    allowArchived,
    ...context,
  })
  return execution
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw requestInvalid(`${name} 必须是非空字符串`)
  return value.trim()
}
